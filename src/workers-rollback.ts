import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { isRetryableRequestError } from "./client.ts";
import type { WorkersClientOptions } from "./workers-client.ts";
import * as workersClient from "./workers-client.ts";
import { WorkerPushError, checkWorkerHealth } from "./workers-push.ts";
import { loadWorkerProject } from "./workers-project.ts";

type UnknownRecord = Record<string, unknown>;
const DEPLOYMENT_TIMEOUT_MS = 3 * 60_000;

export interface RollbackClient {
  getWorker(options: WorkersClientOptions, id: string): Promise<unknown>;
  rollbackWorker(
    options: WorkersClientOptions,
    id: string,
    environment: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface WorkerRollbackPlan {
  schemaVersion: 1;
  workerId: string;
  environment: "preview" | "production";
  current: { deploymentId: string; artifactId: string };
  target: { deploymentId: string; artifactId?: string };
  selection: "previous" | "explicit";
  codeOnly: true;
  dataAndSecretsRolledBack: false;
  warning: string;
  requiresConfirmation: boolean;
}

export interface RollbackWorkerProjectOptions {
  cwd?: string;
  configPath?: string;
  environment: "preview" | "production";
  to?: "previous";
  deploymentId?: string;
  clientOptions: WorkersClientOptions;
  nonInteractive?: boolean;
  client?: RollbackClient;
  confirm?: (plan: WorkerRollbackPlan) => Promise<boolean>;
  onPlan?: (plan: WorkerRollbackPlan) => void;
  fetchPublic?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface WorkerRollbackResult {
  schemaVersion: 1;
  status: "ACTIVE";
  plan: WorkerRollbackPlan;
  deployment: {
    id: string;
    artifactId: string;
    status: "ACTIVE";
    idempotencyKey: string;
  };
  publicUrl: string;
  health: { url: string; status: number; attempts: number };
  dataAndSecretsRolledBack: false;
  commands: { logs: string; inspect: string };
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

function timestamp(deployment: UnknownRecord): number {
  const parsed = Date.parse(
    text(deployment.deployedAt) || text(deployment.createdAt) || "",
  );
  return Number.isFinite(parsed) ? parsed : 0;
}

function environmentOf(
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

function deploymentIdentity(
  deployment: UnknownRecord,
  label: string,
): { deploymentId: string; artifactId: string } {
  const deploymentId = text(deployment.id);
  const artifactId = text(deployment.artifactId);
  if (!deploymentId || !artifactId) {
    throw new WorkerPushError(`${label} is missing deployment or Artifact id`);
  }
  return { deploymentId, artifactId };
}

function stableRollbackKey(
  workerId: string,
  environment: string,
  deploymentId: string,
): string {
  return `rollback-${createHash("sha256")
    .update(
      `xapi-worker-rollback-v1\0${workerId}\0${environment}\0${deploymentId}`,
    )
    .digest("hex")
    .slice(0, 32)}`;
}

function deploymentFromWorker(
  worker: UnknownRecord,
  deploymentId: string | undefined,
  serverIdempotencyKey: string,
): UnknownRecord | undefined {
  return records(worker.deployments || [], "Worker deployments").find(
    (item) =>
      (deploymentId && item.id === deploymentId) ||
      item.idempotencyKey === serverIdempotencyKey,
  );
}

async function terminalConfirm(plan: WorkerRollbackPlan): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new WorkerPushError(
      "Interactive production rollback requires a TTY; CI must pass --non-interactive explicitly",
    );
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await prompt.question(
      `Roll back production code to deployment ${plan.target.deploymentId}? Data and Secrets will NOT be rolled back. [y/N] `,
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

export async function createWorkerRollbackPlan(
  options: RollbackWorkerProjectOptions,
): Promise<{ plan: WorkerRollbackPlan; worker: UnknownRecord }> {
  if ((options.to === "previous") === !!options.deploymentId) {
    throw new WorkerPushError(
      "Choose exactly one rollback target: --to previous or --deployment DEPLOYMENT_ID",
    );
  }
  const project = loadWorkerProject(options.cwd, options.configPath);
  const workerId = project.config.workerId;
  if (!workerId) {
    throw new WorkerPushError(
      "Project is not linked to a Worker; push preview before rollback",
    );
  }
  const api = options.client || (workersClient as RollbackClient);
  const worker = record(
    await api.getWorker(options.clientOptions, workerId),
    "Worker",
  );
  const environment = environmentOf(worker, options.environment);
  const environmentId = text(environment.id)!;
  const deployments = records(worker.deployments || [], "Worker deployments");
  const activeDeploymentId = text(environment.activeDeploymentId);
  const current = activeDeploymentId
    ? deployments.find((item) => item.id === activeDeploymentId)
    : deployments
        .filter(
          (item) =>
            item.environmentId === environmentId && item.status === "ACTIVE",
        )
        .sort((a, b) => timestamp(b) - timestamp(a))[0];
  if (!current || current.status !== "ACTIVE") {
    throw new WorkerPushError(
      `${options.environment} has no visible ACTIVE deployment to roll back`,
    );
  }
  const currentIdentity = deploymentIdentity(current, "Current deployment");

  let target: UnknownRecord | undefined;
  if (options.to === "previous") {
    target = deployments
      .filter(
        (item) =>
          item.environmentId === environmentId &&
          item.status === "ACTIVE" &&
          item.id !== currentIdentity.deploymentId &&
          item.artifactId !== currentIdentity.artifactId,
      )
      .sort((a, b) => timestamp(b) - timestamp(a))[0];
    if (!target) {
      throw new WorkerPushError(
        `No previous ACTIVE ${options.environment} deployment with different code is visible`,
      );
    }
  } else {
    target = deployments.find((item) => item.id === options.deploymentId);
    if (target) {
      if (
        target.environmentId !== environmentId ||
        target.status !== "ACTIVE"
      ) {
        throw new WorkerPushError(
          "Explicit rollback target is not an ACTIVE deployment in the selected environment",
        );
      }
      if (target.artifactId === currentIdentity.artifactId) {
        throw new WorkerPushError(
          "Explicit rollback target uses the Artifact that is already active",
        );
      }
    }
  }
  const targetDeploymentId =
    text(target?.id) || text(options.deploymentId) || undefined;
  if (!targetDeploymentId) {
    throw new WorkerPushError("Rollback target deployment id is missing");
  }
  const plan: WorkerRollbackPlan = {
    schemaVersion: 1,
    workerId,
    environment: options.environment,
    current: currentIdentity,
    target: {
      deploymentId: targetDeploymentId,
      ...(text(target?.artifactId)
        ? { artifactId: text(target?.artifactId) }
        : {}),
    },
    selection: options.to === "previous" ? "previous" : "explicit",
    codeOnly: true,
    dataAndSecretsRolledBack: false,
    warning:
      "Only Worker code is rolled back. D1, R2, KV, Durable Objects, Queues, Workflows, configuration, and Secrets keep their current state.",
    requiresConfirmation: options.environment === "production",
  };
  return { plan, worker };
}

async function waitForActiveRollback(
  api: RollbackClient,
  options: WorkersClientOptions,
  workerId: string,
  deployment: UnknownRecord,
  serverIdempotencyKey: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<UnknownRecord> {
  const started = Date.now();
  let current = deployment;
  while (true) {
    const status = text(current.status);
    if (status === "ACTIVE") return current;
    if (status === "FAILED") {
      throw new WorkerPushError("Worker rollback deployment failed", {
        workerId,
        deploymentId: text(current.id),
        errorCode: text(current.errorCode),
        errorMessage: text(current.errorMessage),
      });
    }
    if (status !== "DEPLOYING") {
      throw new WorkerPushError(
        `Worker rollback returned status ${status || "UNKNOWN"}`,
      );
    }
    if (Date.now() - started >= DEPLOYMENT_TIMEOUT_MS) {
      throw new WorkerPushError(
        "Timed out waiting for rollback deployment to become ACTIVE",
        { workerId, deploymentId: text(current.id) },
      );
    }
    await sleep(1_000);
    const worker = record(await api.getWorker(options, workerId), "Worker");
    const reconciled = deploymentFromWorker(
      worker,
      text(current.id),
      serverIdempotencyKey,
    );
    if (reconciled) current = reconciled;
  }
}

export async function rollbackWorkerProject(
  options: RollbackWorkerProjectOptions,
): Promise<WorkerRollbackResult> {
  const api = options.client || (workersClient as RollbackClient);
  const project = loadWorkerProject(options.cwd, options.configPath);
  const prepared = await createWorkerRollbackPlan({ ...options, client: api });
  options.onPlan?.(prepared.plan);
  if (prepared.plan.requiresConfirmation && !options.nonInteractive) {
    const confirmed = await (options.confirm || terminalConfirm)(prepared.plan);
    if (!confirmed) {
      throw new WorkerPushError(
        "Production rollback cancelled; no deployment was created",
      );
    }
  }
  const idempotencyKey = stableRollbackKey(
    prepared.plan.workerId,
    prepared.plan.environment,
    prepared.plan.target.deploymentId,
  );
  const serverIdempotencyKey = `rollback:${idempotencyKey}`;
  const wait =
    options.sleep ||
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  let deployment: UnknownRecord | undefined;
  try {
    deployment = record(
      await api.rollbackWorker(
        options.clientOptions,
        prepared.plan.workerId,
        prepared.plan.environment,
        {
          deploymentId: prepared.plan.target.deploymentId,
          idempotencyKey,
        },
      ),
      "Rollback deployment",
    );
  } catch (error) {
    if (!isRetryableRequestError(error)) throw error;
    const worker = record(
      await api.getWorker(options.clientOptions, prepared.plan.workerId),
      "Worker",
    );
    deployment = deploymentFromWorker(worker, undefined, serverIdempotencyKey);
    if (!deployment) {
      deployment = record(
        await api.rollbackWorker(
          options.clientOptions,
          prepared.plan.workerId,
          prepared.plan.environment,
          {
            deploymentId: prepared.plan.target.deploymentId,
            idempotencyKey,
          },
        ),
        "Rollback deployment",
      );
    }
  }
  const active = await waitForActiveRollback(
    api,
    options.clientOptions,
    prepared.plan.workerId,
    deployment,
    serverIdempotencyKey,
    wait,
  );
  const deploymentIdentityResult = deploymentIdentity(
    active,
    "ACTIVE rollback deployment",
  );
  const finalWorker = record(
    await api.getWorker(options.clientOptions, prepared.plan.workerId),
    "Worker",
  );
  const health = await checkWorkerHealth(
    finalWorker,
    prepared.plan.environment,
    project.config.environments[prepared.plan.environment].healthCheck,
    options.fetchPublic || fetch,
    wait,
  );
  const publicUrl = text(
    environmentOf(finalWorker, prepared.plan.environment).publicUrl,
  );
  if (!publicUrl) {
    throw new WorkerPushError("ACTIVE rollback deployment has no publicUrl");
  }
  return {
    schemaVersion: 1,
    status: "ACTIVE",
    plan: prepared.plan,
    deployment: {
      id: deploymentIdentityResult.deploymentId,
      artifactId: deploymentIdentityResult.artifactId,
      status: "ACTIVE",
      idempotencyKey,
    },
    publicUrl,
    health,
    dataAndSecretsRolledBack: false,
    commands: {
      logs: `xapi workers logs ${prepared.plan.workerId} --env ${prepared.plan.environment}`,
      inspect: `xapi workers get ${prepared.plan.workerId}`,
    },
  };
}
