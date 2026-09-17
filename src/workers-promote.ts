import { createInterface } from "node:readline/promises";
import type { WorkersClientOptions } from "./workers-client.ts";
import * as workersClient from "./workers-client.ts";
import {
  type DeploymentClient,
  WorkerPushError,
  checkWorkerHealth,
  ensureActiveDeployment,
  ensureManagedResources,
  type ManagedResourceClient,
  resourceMatches,
} from "./workers-push.ts";
import { loadWorkerProject } from "./workers-project.ts";
import { readWranglerDeploymentSettings } from "./workers-wrangler-import.ts";

type UnknownRecord = Record<string, unknown>;

export interface PromotionClient extends DeploymentClient, ManagedResourceClient {
  listWorkerResources(
    options: WorkersClientOptions,
    id: string,
    environment: string,
  ): Promise<unknown>;
  listWorkerSecrets(
    options: WorkersClientOptions,
    id: string,
    environment: string,
  ): Promise<unknown>;
}

export type PromotionCheckStatus =
  | "CREATE"
  | "NO_CHANGE"
  | "MANUAL"
  | "BLOCKED";

export interface WorkerPromotionCheck {
  status: PromotionCheckStatus;
  kind: "budget" | "resource" | "secret" | "routing";
  key: string;
  message: string;
  command?: string;
}

export interface WorkerPromotionPlan {
  schemaVersion: 1;
  workerId: string;
  to: "production";
  previewDeployment: { id: string; artifactId: string; deployedAt?: string };
  artifact: { id: string; contentSha256: string; sizeBytes?: number };
  production: {
    checks: WorkerPromotionCheck[];
    dataRisk: string[];
  };
  canPromote: boolean;
}

export interface PromoteWorkerProjectOptions {
  cwd?: string;
  configPath?: string;
  to: "production";
  artifactId?: string;
  clientOptions: WorkersClientOptions;
  nonInteractive?: boolean;
  retentionPriceVersion?: string;
  client?: PromotionClient;
  confirm?: (plan: WorkerPromotionPlan) => Promise<boolean>;
  onPlan?: (plan: WorkerPromotionPlan) => void;
  fetchPublic?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface WorkerPromotionResult {
  schemaVersion: 1;
  status: "ACTIVE";
  plan: WorkerPromotionPlan;
  workerId: string;
  artifact: { id: string; contentSha256: string; sizeBytes?: number };
  resources: { created: string[]; unchanged: string[] };
  deployment: { id: string; status: "ACTIVE"; idempotencyKey: string };
  publicUrl: string;
  health: { url: string; status: number; attempts: number };
  commands: { logs: string; rollback: string };
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerPushError(`xAPI returned an invalid ${label} response`);
  }
  return value as UnknownRecord;
}

function records(value: unknown, label: string): UnknownRecord[] {
  if (!Array.isArray(value)) {
    throw new WorkerPushError(`xAPI returned an invalid ${label} response`);
  }
  return value.map((item) => record(item, `${label} item`));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function amount(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function environment(
  worker: UnknownRecord,
  name: "preview" | "production",
): UnknownRecord {
  const selected = records(worker.environments, "Worker environments").find(
    (item) => text(item.name)?.toLowerCase() === name,
  );
  if (!selected || !text(selected.id)) {
    throw new WorkerPushError(`Worker is missing its ${name} environment`);
  }
  return selected;
}

function remoteType(value: unknown): string {
  const map: Record<string, string> = {
    KV_NAMESPACE: "kv_namespace",
    D1_DATABASE: "d1_database",
    R2_BUCKET: "r2_bucket",
    DURABLE_OBJECT: "durable_object",
    QUEUE: "queue",
    WORKFLOW: "workflow",
  };
  const raw = text(value) || "unknown";
  return map[raw] || raw;
}

function productionChecks(
  workerId: string,
  desired: ReturnType<
    typeof loadWorkerProject
  >["config"]["environments"]["production"],
  remoteEnvironment: UnknownRecord,
  resources: UnknownRecord[],
  secrets: UnknownRecord[],
  hasStaticAssets: boolean,
): { checks: WorkerPromotionCheck[]; dataRisk: string[] } {
  const checks: WorkerPromotionCheck[] = [];
  const dataRisk: string[] = [
    "Promotion changes the Worker code Artifact only; it does not snapshot, copy, or roll back production data",
  ];
  const currentBudget = amount(remoteEnvironment.dailyBudgetUsd);
  if (hasStaticAssets) {
    checks.push(
      remoteEnvironment.webAppReady === true
        ? {
            status: "NO_CHANGE",
            kind: "routing",
            key: "production",
            message: "Production web application has a dedicated hostname",
          }
        : {
            status: "MANUAL",
            kind: "routing",
            key: "production",
            message:
              "Production is using path fallback; verify the application base path, root-relative URLs, and OAuth callbacks, or configure a dedicated hostname",
          },
    );
  }
  if (
    currentBudget === undefined ||
    Math.abs(currentBudget - desired.dailyBudgetUsd) > 0.00005
  ) {
    checks.push({
      status: "BLOCKED",
      kind: "budget",
      key: "production",
      message: `Production budget is ${currentBudget ?? "unknown"}; desired is ${desired.dailyBudgetUsd}`,
      command: `xapi workers budget ${workerId} production --daily-usd ${desired.dailyBudgetUsd}`,
    });
  } else {
    checks.push({
      status: "NO_CHANGE",
      kind: "budget",
      key: "production",
      message: "Production daily budget matches desired state",
    });
  }

  const remoteResources = new Map<string, UnknownRecord>();
  for (const resource of resources) {
    const bindingName = text(resource.bindingName);
    if (!bindingName) {
      throw new WorkerPushError(
        "xAPI returned a production resource without bindingName",
      );
    }
    remoteResources.set(bindingName, resource);
  }
  for (const resource of [...desired.resources].sort((a, b) =>
    a.bindingName.localeCompare(b.bindingName),
  )) {
    dataRisk.push(
      `${resource.bindingName} (${resource.type}) keeps production state independent from preview`,
    );
    const current = remoteResources.get(resource.bindingName);
    if (!current) {
      checks.push({
        status: "CREATE",
        kind: "resource",
        key: resource.bindingName,
        message: "Create the missing production managed resource after confirmation",
      });
      continue;
    }
    remoteResources.delete(resource.bindingName);
    const status = text(current.status) || "UNKNOWN";
    const statusReady =
      status === "ACTIVE" ||
      (resource.type === "durable_object" && status === "PROVISIONING");
    if (!resourceMatches(current, resource) || !statusReady) {
      checks.push({
        status: "BLOCKED",
        kind: "resource",
        key: resource.bindingName,
        message: `Production resource is incompatible or not ready (type=${remoteType(current.type)}, status=${status})`,
      });
    } else {
      checks.push({
        status: "NO_CHANGE",
        kind: "resource",
        key: resource.bindingName,
        message: "Production managed resource matches desired state",
      });
    }
  }
  for (const [bindingName, resource] of [...remoteResources].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    checks.push({
      status: "MANUAL",
      kind: "resource",
      key: bindingName,
      message:
        "Extra production stateful resource is preserved and not modified",
    });
    dataRisk.push(
      `${bindingName} (${remoteType(resource.type)}) contains independent production state; promotion does not copy preview data or delete it`,
    );
  }

  const remoteSecrets = new Set(
    secrets.map((secret) => {
      const bindingName = text(secret.bindingName);
      if (!bindingName) {
        throw new WorkerPushError(
          "xAPI returned production Secret metadata without bindingName",
        );
      }
      return bindingName;
    }),
  );
  for (const name of [...desired.secrets].sort()) {
    if (remoteSecrets.delete(name)) {
      checks.push({
        status: "NO_CHANGE",
        kind: "secret",
        key: name,
        message: "Production Secret metadata exists; plaintext was not read",
      });
    } else {
      checks.push({
        status: "BLOCKED",
        kind: "secret",
        key: name,
        message: "Required production Secret is missing",
        command: `xapi workers secrets set ${workerId} ${name} --env production --from-env ${name}`,
      });
    }
  }
  for (const name of [...remoteSecrets].sort()) {
    checks.push({
      status: "MANUAL",
      kind: "secret",
      key: name,
      message: "Extra production Secret is preserved; plaintext was not read",
    });
  }
  checks.sort(
    (a, b) =>
      ({ routing: 0, budget: 1, resource: 2, secret: 3 })[a.kind] -
        { routing: 0, budget: 1, resource: 2, secret: 3 }[b.kind] ||
      a.key.localeCompare(b.key),
  );
  return { checks, dataRisk: dataRisk.sort() };
}

async function terminalConfirm(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new WorkerPushError(
      "Interactive production confirmation requires a TTY; CI must use --to production --non-interactive",
    );
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      "Promote this exact preview Artifact to production? [y/N] ",
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function createWorkerPromotionPlan(
  options: PromoteWorkerProjectOptions,
): Promise<{
  plan: WorkerPromotionPlan;
  worker: UnknownRecord;
  artifact: UnknownRecord;
}> {
  if (options.to !== "production") {
    throw new WorkerPushError("workers promote requires --to production");
  }
  const project = loadWorkerProject(options.cwd, options.configPath);
  const workerId = project.config.workerId;
  if (!workerId) {
    throw new WorkerPushError(
      "Project is not linked to a Worker; push preview before promotion",
    );
  }
  const api = options.client || (workersClient as PromotionClient);
  const worker = record(
    await api.getWorker(options.clientOptions, workerId),
    "Worker",
  );
  const preview = environment(worker, "preview");
  const production = environment(worker, "production");
  const activePreview = records(worker.deployments || [], "Worker deployments")
    .filter(
      (deployment) =>
        deployment.status === "ACTIVE" &&
        deployment.environmentId === preview.id &&
        (!options.artifactId || deployment.artifactId === options.artifactId),
    )
    .sort(
      (a, b) =>
        Date.parse(text(b.deployedAt) || text(b.createdAt) || "") -
        Date.parse(text(a.deployedAt) || text(a.createdAt) || ""),
    );
  const previewDeployment = activePreview[0];
  if (!previewDeployment) {
    throw new WorkerPushError(
      options.artifactId
        ? "Requested Artifact has no visible ACTIVE preview deployment"
        : "No ACTIVE preview deployment is available to promote",
    );
  }
  const artifactId = text(previewDeployment.artifactId);
  const previewDeploymentId = text(previewDeployment.id);
  const artifact = records(worker.artifacts || [], "Worker Artifacts").find(
    (item) => item.id === artifactId,
  );
  const contentSha256 = text(artifact?.contentSha256);
  if (
    !artifact ||
    !artifactId ||
    !previewDeploymentId ||
    !contentSha256 ||
    !/^[0-9a-f]{64}$/i.test(contentSha256)
  ) {
    throw new WorkerPushError(
      "ACTIVE preview deployment is missing immutable Artifact metadata",
    );
  }
  const [resources, secrets] = await Promise.all([
    api
      .listWorkerResources(options.clientOptions, workerId, "production")
      .then((value) => records(value, "production resources")),
    api
      .listWorkerSecrets(options.clientOptions, workerId, "production")
      .then((value) => records(value, "production Secret metadata")),
  ]);
  const checked = productionChecks(
    workerId,
    project.config.environments.production,
    production,
    resources,
    secrets,
    Boolean(project.config.assets),
  );
  const plan: WorkerPromotionPlan = {
    schemaVersion: 1,
    workerId,
    to: "production",
    previewDeployment: {
      id: previewDeploymentId,
      artifactId,
      ...(text(previewDeployment.deployedAt)
        ? { deployedAt: text(previewDeployment.deployedAt) }
        : {}),
    },
    artifact: {
      id: artifactId,
      contentSha256,
      ...(amount(artifact.sizeBytes) !== undefined
        ? { sizeBytes: amount(artifact.sizeBytes) }
        : {}),
    },
    production: checked,
    canPromote: !checked.checks.some(
      (item) =>
        item.status === "BLOCKED" ||
        (item.status === "MANUAL" && item.kind === "resource"),
    ),
  };
  return { plan, worker, artifact };
}

export async function promoteWorkerProject(
  options: PromoteWorkerProjectOptions,
): Promise<WorkerPromotionResult> {
  const api = options.client || (workersClient as PromotionClient);
  const project = loadWorkerProject(options.cwd, options.configPath);
  const prepared = await createWorkerPromotionPlan({ ...options, client: api });
  options.onPlan?.(prepared.plan);
  if (!prepared.plan.canPromote) {
    const blockingChecks = prepared.plan.production.checks.filter(
      (item) =>
        item.status === "BLOCKED" ||
        (item.status === "MANUAL" && item.kind === "resource"),
    );
    throw new WorkerPushError(
      blockingChecks.some((item) => item.status === "BLOCKED")
        ? "Production preflight is blocked; no changes were applied"
        : "Production resource drift requires reconciliation; no changes were applied",
      {
        checks: prepared.plan.production.checks,
        blockers: blockingChecks,
      },
    );
  }
  if (!options.nonInteractive) {
    const confirmed = await (options.confirm || terminalConfirm)(prepared.plan);
    if (!confirmed) {
      throw new WorkerPushError(
        "Production promotion cancelled; no deployment was created",
      );
    }
  }
  const compatibility = readWranglerDeploymentSettings(project, "production");
  const wait =
    options.sleep ||
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  try {
    const resources = await ensureManagedResources(
      api,
      options.clientOptions,
      prepared.plan.workerId,
      "production",
      project.config.environments.production.resources,
      options.retentionPriceVersion,
    );
    const deployed = await ensureActiveDeployment(
      api,
      options.clientOptions,
      prepared.plan.workerId,
      prepared.plan.artifact.id,
      "production",
      compatibility,
      wait,
    );
    const deploymentId = text(deployed.deployment.id);
    if (!deploymentId) {
      throw new WorkerPushError("ACTIVE production deployment is missing id");
    }
    const finalWorker = record(
      await api.getWorker(options.clientOptions, prepared.plan.workerId),
      "Worker",
    );
    const health = await checkWorkerHealth(
      finalWorker,
      "production",
      project.config.environments.production.healthCheck,
      options.fetchPublic || fetch,
      wait,
    );
    const publicUrl = text(environment(finalWorker, "production").publicUrl)!;
    return {
      schemaVersion: 1,
      status: "ACTIVE",
      plan: prepared.plan,
      workerId: prepared.plan.workerId,
      artifact: prepared.plan.artifact,
      resources,
      deployment: {
        id: deploymentId,
        status: "ACTIVE",
        idempotencyKey: deployed.idempotencyKey,
      },
      publicUrl,
      health,
      commands: {
        logs: `xapi workers logs ${prepared.plan.workerId} --env production`,
        rollback: `xapi workers rollback --env production --deployment <deployment-id>`,
      },
    };
  } catch (error) {
    if (error instanceof WorkerPushError) {
      throw new WorkerPushError(error.message, {
        workerId: prepared.plan.workerId,
        artifactId: prepared.plan.artifact.id,
        productionResourcesPreserved: true,
        ...error.recovery,
      });
    }
    throw new WorkerPushError(
      error instanceof Error ? error.message : "Production promotion failed",
      {
        workerId: prepared.plan.workerId,
        artifactId: prepared.plan.artifact.id,
        productionResourcesPreserved: true,
      },
    );
  }
}
