import { existsSync, lstatSync, statSync } from "node:fs";
import type { WorkersClientOptions } from "./workers-client.ts";
import * as workersClient from "./workers-client.ts";
import { loadWorkerArtifact, WorkerArtifactError } from "./workers-artifact.ts";
import { deploymentPrefix, currentMatchingDeployment } from "./workers-deployment-state.ts";
import { readWranglerDeploymentSettings } from "./workers-wrangler-import.ts";
import {
  type LoadedWorkerProject,
  type WorkerProjectConfig,
  WorkerProjectConfigError,
  loadWorkerProject,
  resolveWorkerProjectPath,
} from "./workers-project.ts";

export type WorkerPlanOperation =
  | "CREATE"
  | "UPDATE"
  | "NO_CHANGE"
  | "MANUAL"
  | "BLOCKED";

export type WorkerPlanKind =
  | "worker"
  | "budget"
  | "resource"
  | "secret"
  | "routing"
  | "artifact"
  | "deployment";

export interface WorkerPlanAction {
  operation: WorkerPlanOperation;
  kind: WorkerPlanKind;
  key: string;
  message: string;
  desired?: Record<string, unknown>;
  current?: Record<string, unknown>;
}

export interface WorkerDeploymentPlan {
  schemaVersion: 1;
  project: {
    rootDir: string;
    configPath: string;
    workerId?: string;
    slug: string;
    build: { command: string; output: string; main?: string };
  };
  environment: "preview" | "production";
  remote: { linked: boolean; workerId?: string };
  canApply: boolean;
  summary: Record<WorkerPlanOperation, number>;
  actions: WorkerPlanAction[];
}

export interface PlanClient {
  listWorkers(options: WorkersClientOptions): Promise<unknown>;
  getWorker(options: WorkersClientOptions, id: string): Promise<unknown>;
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

export interface CreateWorkerPlanOptions {
  cwd?: string;
  configPath?: string;
  environment: "preview" | "production";
  clientOptions: WorkersClientOptions;
  client?: PlanClient;
}

type UnknownRecord = Record<string, unknown>;
type DesiredResource =
  WorkerProjectConfig["environments"]["preview"]["resources"][number];

const KIND_ORDER: Record<WorkerPlanKind, number> = {
  worker: 0,
  budget: 1,
  resource: 2,
  secret: 3,
  routing: 4,
  artifact: 5,
  deployment: 6,
};

const REMOTE_RESOURCE_TYPE: Record<string, DesiredResource["type"]> = {
  KV_NAMESPACE: "kv_namespace",
  D1_DATABASE: "d1_database",
  R2_BUCKET: "r2_bucket",
  DURABLE_OBJECT: "durable_object",
  QUEUE: "queue",
  WORKFLOW: "workflow",
  kv_namespace: "kv_namespace",
  d1_database: "d1_database",
  r2_bucket: "r2_bucket",
  durable_object: "durable_object",
  queue: "queue",
  workflow: "workflow",
};

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function list(value: unknown, label: string): UnknownRecord[] {
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(record(value)?.items)
      ? (record(value)?.items as unknown[])
      : undefined;
  if (!raw) {
    throw new WorkerProjectConfigError(
      "worker_plan_invalid_response",
      `xAPI returned an invalid ${label} response`,
    );
  }
  return raw.map((item) => {
    const parsed = record(item);
    if (!parsed) {
      throw new WorkerProjectConfigError(
        "worker_plan_invalid_response",
        `xAPI returned an invalid item in ${label}`,
      );
    }
    return parsed;
  });
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function remoteWorker(value: unknown): UnknownRecord {
  const parsed = record(value);
  if (!parsed || !string(parsed.id) || !string(parsed.slug)) {
    throw new WorkerProjectConfigError(
      "worker_plan_invalid_response",
      "xAPI returned an invalid Worker response",
    );
  }
  return parsed;
}

function remoteEnvironment(
  worker: UnknownRecord,
  environment: "preview" | "production",
): UnknownRecord {
  const environments = list(worker.environments, "Worker environments");
  const selected = environments.find(
    (item) => string(item.name)?.toLowerCase() === environment,
  );
  if (!selected || !string(selected.id)) {
    throw new WorkerProjectConfigError(
      "worker_plan_invalid_response",
      `xAPI Worker is missing its ${environment} environment`,
    );
  }
  return selected;
}

function add(
  actions: WorkerPlanAction[],
  operation: WorkerPlanOperation,
  kind: WorkerPlanKind,
  key: string,
  message: string,
  desired?: Record<string, unknown>,
  current?: Record<string, unknown>,
): void {
  actions.push({
    operation,
    kind,
    key,
    message,
    ...(desired ? { desired } : {}),
    ...(current ? { current } : {}),
  });
}

function compareResources(
  actions: WorkerPlanAction[],
  desired: DesiredResource[],
  remote: UnknownRecord[],
): boolean {
  let blocked = false;
  const remoteByName = new Map<string, UnknownRecord>();
  for (const item of remote) {
    const name = string(item.bindingName);
    if (!name) {
      throw new WorkerProjectConfigError(
        "worker_plan_invalid_response",
        "xAPI returned a managed resource without bindingName",
      );
    }
    remoteByName.set(name, item);
  }
  for (const resource of [...desired].sort((a, b) =>
    a.bindingName.localeCompare(b.bindingName),
  )) {
    const existing = remoteByName.get(resource.bindingName);
    const desiredState = {
      type: resource.type,
      bindingName: resource.bindingName,
      ...(resource.className ? { className: resource.className } : {}),
    };
    if (!existing) {
      add(
        actions,
        "CREATE",
        "resource",
        resource.bindingName,
        "Create an xAPI-owned managed resource; no provider ID is supplied by the project",
        desiredState,
      );
      continue;
    }
    remoteByName.delete(resource.bindingName);
    const existingType = REMOTE_RESOURCE_TYPE[string(existing.type) || ""];
    const existingClassName = string(record(existing.config)?.className);
    if (
      existingType !== resource.type ||
      (resource.type === "durable_object" &&
        existingClassName !== resource.className)
    ) {
      blocked = true;
      add(
        actions,
        "BLOCKED",
        "resource",
        resource.bindingName,
        "A binding with the same name has a different type or Durable Object class; automatic replacement is unsafe",
        desiredState,
        {
          type: existingType || string(existing.type) || "unknown",
          ...(existingClassName ? { className: existingClassName } : {}),
        },
      );
      continue;
    }
    const status = string(existing.status) || "UNKNOWN";
    const readyForDeployment =
      status === "ACTIVE" ||
      (resource.type === "durable_object" && status === "PROVISIONING");
    if (!readyForDeployment) {
      blocked = true;
      add(
        actions,
        "BLOCKED",
        "resource",
        resource.bindingName,
        `Managed resource is ${status}; wait for or repair it before deployment`,
        desiredState,
        { status },
      );
      continue;
    }
    add(
      actions,
      "NO_CHANGE",
      "resource",
      resource.bindingName,
      status === "PROVISIONING"
        ? "Durable Object declaration matches and will become ACTIVE with the next deployment"
        : "Managed resource already matches desired state",
      desiredState,
      { status },
    );
  }
  for (const [name, existing] of [...remoteByName].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    add(
      actions,
      "MANUAL",
      "resource",
      name,
      "Remote resource remains bound and may keep accruing charges. Removing its local declaration does not detach or delete it; explicitly delete it, then deploy again",
      undefined,
      {
        type:
          REMOTE_RESOURCE_TYPE[string(existing.type) || ""] ||
          string(existing.type) ||
          "unknown",
        status: string(existing.status) || "UNKNOWN",
      },
    );
  }
  return blocked;
}

function compareSecrets(
  actions: WorkerPlanAction[],
  desired: string[],
  remote: UnknownRecord[],
): boolean {
  let blocked = false;
  const existing = new Set(
    remote.map((item) => {
      const name = string(item.bindingName);
      if (!name) {
        throw new WorkerProjectConfigError(
          "worker_plan_invalid_response",
          "xAPI returned Secret metadata without bindingName",
        );
      }
      return name;
    }),
  );
  for (const name of [...desired].sort()) {
    if (existing.delete(name)) {
      add(
        actions,
        "NO_CHANGE",
        "secret",
        name,
        "Secret binding metadata exists; plaintext was not requested",
        { bindingName: name },
      );
    } else {
      blocked = true;
      add(
        actions,
        "BLOCKED",
        "secret",
        name,
        "Secret value is missing; set it before build or deployment",
        { bindingName: name },
      );
    }
  }
  for (const name of [...existing].sort()) {
    add(
      actions,
      "MANUAL",
      "secret",
      name,
      "Remote Secret is not declared locally; plan preserves it and never reads plaintext",
      undefined,
      { bindingName: name },
    );
  }
  return blocked;
}

function localArtifact(project: LoadedWorkerProject): {
  sha256?: string;
  sizeBytes?: number;
  blocked?: string;
} {
  const path = resolveWorkerProjectPath(
    project,
    project.config.build.output,
    "build.output",
  );
  if (!existsSync(path)) return {};
  try {
    const artifact = loadWorkerArtifact(
      path,
      project.config.build.main,
      project.config.assets
        ? {
            ...project.config.assets,
            directory: resolveWorkerProjectPath(
              project,
              project.config.assets.directory,
              "assets.directory",
            ),
          }
        : undefined,
    );
    return {
      sha256: artifact.contentSha256,
      sizeBytes: artifact.sizeBytes,
    };
  } catch (error) {
    if (error instanceof WorkerArtifactError) {
      return { blocked: error.message };
    }
    throw error;
  }
}

function validatePlanInputs(project: LoadedWorkerProject): void {
  const wranglerPath = resolveWorkerProjectPath(
    project,
    project.config.wrangler,
    "wrangler",
  );
  if (!existsSync(wranglerPath)) {
    throw new WorkerProjectConfigError(
      "worker_project_wrangler_not_found",
      `Wrangler configuration not found: ${wranglerPath}`,
    );
  }
  if (lstatSync(wranglerPath).isSymbolicLink()) {
    throw new WorkerProjectConfigError(
      "worker_project_wrangler_symlink",
      `Wrangler configuration must not be a symbolic link: ${wranglerPath}`,
    );
  }
  if (!statSync(wranglerPath).isFile()) {
    throw new WorkerProjectConfigError(
      "worker_project_wrangler_not_file",
      `Wrangler configuration is not a file: ${wranglerPath}`,
    );
  }
}

function artifactAndDeployment(
  actions: WorkerPlanAction[],
  project: LoadedWorkerProject,
  remote: UnknownRecord | undefined,
  environmentId: string | undefined,
  blockedBeforeDeployment: boolean,
  environmentState: UnknownRecord | undefined,
  resources: UnknownRecord[],
  secrets: UnknownRecord[],
  environmentName: "preview" | "production",
): void {
  const local = localArtifact(project);
  if (local.blocked) {
    add(
      actions,
      "BLOCKED",
      "artifact",
      project.config.build.output,
      local.blocked,
    );
    add(
      actions,
      "BLOCKED",
      "deployment",
      "current",
      "Deployment is blocked by invalid build output",
    );
    return;
  }
  const artifacts = remote
    ? list(remote.artifacts || [], "Worker artifacts")
    : [];
  const matchingArtifact = local.sha256
    ? artifacts.find((item) => item.contentSha256 === local.sha256)
    : undefined;
  const artifactId = string(matchingArtifact?.id);
  if (matchingArtifact && artifactId) {
    add(
      actions,
      "NO_CHANGE",
      "artifact",
      local.sha256!,
      "An immutable remote Artifact already matches the local bundle",
      { sha256: local.sha256, sizeBytes: local.sizeBytes },
      { artifactId },
    );
  } else {
    add(
      actions,
      "CREATE",
      "artifact",
      local.sha256 || project.config.build.output,
      local.sha256
        ? "Upload the local bundle as a new immutable Artifact"
        : `Run ${project.config.build.command} and upload its Worker output`,
      {
        output: project.config.build.output,
        ...(local.sha256
          ? { sha256: local.sha256, sizeBytes: local.sizeBytes }
          : {}),
      },
    );
  }
  if (blockedBeforeDeployment) {
    add(
      actions,
      "BLOCKED",
      "deployment",
      "current",
      "Deployment is blocked until Worker, resource, and Secret prerequisites are satisfied",
    );
    return;
  }
  const deployments = remote
    ? list(remote.deployments || [], "Worker deployments")
    : [];
  const active =
    artifactId && environmentId && environmentState && remote &&
    !actions.some(a => a.kind === "resource" && a.operation === "CREATE")
      ? currentMatchingDeployment(deployments, environmentState, artifactId,
          deploymentPrefix(String(remote.id), environmentName, artifactId,
            readWranglerDeploymentSettings(project, environmentName), environmentState, resources, secrets))
      : undefined;
  if (active) {
    add(
      actions,
      "NO_CHANGE",
      "deployment",
      string(active.id) || "active",
      "The current deployment matches the Artifact, bindings and compatibility settings",
      { artifactId },
    );
  } else {
    add(
      actions,
      "CREATE",
      "deployment",
      local.sha256 || "next-artifact",
      "Create a deployment and wait until it reaches ACTIVE",
      artifactId ? { artifactId } : undefined,
    );
  }
}

function planSummary(
  actions: WorkerPlanAction[],
): Record<WorkerPlanOperation, number> {
  const result: Record<WorkerPlanOperation, number> = {
    CREATE: 0,
    UPDATE: 0,
    NO_CHANGE: 0,
    MANUAL: 0,
    BLOCKED: 0,
  };
  for (const action of actions) result[action.operation] += 1;
  return result;
}

export async function createWorkerPlan(
  options: CreateWorkerPlanOptions,
): Promise<WorkerDeploymentPlan> {
  const project = loadWorkerProject(options.cwd, options.configPath);
  validatePlanInputs(project);
  const desired = project.config.environments[options.environment];
  const api = options.client || workersClient;
  const actions: WorkerPlanAction[] = [];
  let remote: UnknownRecord | undefined;
  let remoteEnvironmentState: UnknownRecord | undefined;
  let remoteResources: UnknownRecord[] = [];
  let remoteSecrets: UnknownRecord[] = [];
  let prerequisiteBlocked = false;

  if (project.config.workerId) {
    // Authorization failures and hidden instance scopes propagate as the
    // backend's safe 404; do not fall back to a list that could reveal state.
    remote = remoteWorker(
      await api.getWorker(options.clientOptions, project.config.workerId),
    );
    remoteEnvironmentState = remoteEnvironment(remote, options.environment);
    [remoteResources, remoteSecrets] = await Promise.all([
      api
        .listWorkerResources(
          options.clientOptions,
          project.config.workerId,
          options.environment,
        )
        .then((value) => list(value, "managed resources")),
      api
        .listWorkerSecrets(
          options.clientOptions,
          project.config.workerId,
          options.environment,
        )
        .then((value) => list(value, "Secret metadata")),
    ]);
    if (remote.id !== project.config.workerId) {
      throw new WorkerProjectConfigError(
        "worker_plan_invalid_response",
        "xAPI returned a different Worker than requested",
      );
    }
    if (remote.slug !== project.config.worker.slug) {
      prerequisiteBlocked = true;
      add(
        actions,
        "BLOCKED",
        "worker",
        project.config.worker.slug,
        "Linked Worker slug differs from local configuration",
        { slug: project.config.worker.slug },
        { workerId: remote.id, slug: remote.slug },
      );
    } else {
      add(
        actions,
        "NO_CHANGE",
        "worker",
        project.config.worker.slug,
        "Project is linked to a visible Worker",
        { workerId: project.config.workerId, slug: project.config.worker.slug },
      );
    }
  } else {
    const visibleWorkers = list(
      await api.listWorkers(options.clientOptions),
      "Workers list",
    );
    const sameSlug = visibleWorkers.filter(
      (item) => item.slug === project.config.worker.slug,
    );
    if (sameSlug.length) {
      prerequisiteBlocked = true;
      add(
        actions,
        "BLOCKED",
        "worker",
        project.config.worker.slug,
        "A visible Worker already uses this slug; link its ID explicitly instead of creating a duplicate",
        { slug: project.config.worker.slug },
        {
          matchingVisibleWorkers: sameSlug.length,
          workerId: sameSlug.length === 1 ? string(sameSlug[0].id) : undefined,
        },
      );
    } else {
      add(
        actions,
        "CREATE",
        "worker",
        project.config.worker.slug,
        "Create a new xAPI-hosted Worker and persist its non-secret workerId",
        {
          name: project.config.worker.name,
          slug: project.config.worker.slug,
          template: project.config.worker.template,
        },
      );
    }
  }

  const currentBudget = number(remoteEnvironmentState?.dailyBudgetUsd);
  if (!remoteEnvironmentState) {
    add(
      actions,
      "CREATE",
      "budget",
      options.environment,
      "Set the environment budget during Worker creation",
      { dailyBudgetUsd: desired.dailyBudgetUsd },
    );
  } else if (currentBudget === undefined) {
    throw new WorkerProjectConfigError(
      "worker_plan_invalid_response",
      "xAPI returned an environment without dailyBudgetUsd",
    );
  } else if (Math.abs(currentBudget - desired.dailyBudgetUsd) > 0.00005) {
    add(
      actions,
      "UPDATE",
      "budget",
      options.environment,
      "Update the daily budget before deployment",
      { dailyBudgetUsd: desired.dailyBudgetUsd },
      { dailyBudgetUsd: currentBudget },
    );
  } else {
    add(
      actions,
      "NO_CHANGE",
      "budget",
      options.environment,
      "Daily budget already matches desired state",
      { dailyBudgetUsd: desired.dailyBudgetUsd },
    );
  }

  prerequisiteBlocked =
    compareResources(actions, desired.resources, remoteResources) ||
    prerequisiteBlocked;
  prerequisiteBlocked =
    compareSecrets(actions, desired.secrets, remoteSecrets) ||
    prerequisiteBlocked;
  if (project.config.assets) {
    const ready = remoteEnvironmentState?.webAppReady;
    if (ready === true) {
      add(actions, "NO_CHANGE", "routing", options.environment, "Web application has a dedicated hostname", undefined, {
        routingMode: remoteEnvironmentState?.routingMode,
        publicOrigin: remoteEnvironmentState?.publicOrigin,
      });
    } else {
      add(actions, "MANUAL", "routing", options.environment, remoteEnvironmentState
        ? "Static assets can be tested through the dispatch path, but root-relative URLs and OAuth callbacks require a dedicated hostname"
        : "Web hostname readiness will be checked after the Worker is created", undefined, {
        routingMode: remoteEnvironmentState?.routingMode || "UNKNOWN",
        publicBasePath: remoteEnvironmentState?.publicBasePath,
      });
    }
  }
  artifactAndDeployment(
    actions,
    project,
    remote,
    string(remoteEnvironmentState?.id),
    prerequisiteBlocked,
    remoteEnvironmentState,
    remoteResources,
    remoteSecrets,
    options.environment,
  );

  actions.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.key.localeCompare(b.key) ||
      a.operation.localeCompare(b.operation),
  );
  const summary = planSummary(actions);
  return {
    schemaVersion: 1,
    project: {
      rootDir: project.rootDir,
      configPath: project.configPath,
      ...(project.config.workerId ? { workerId: project.config.workerId } : {}),
      slug: project.config.worker.slug,
      build: {
        command: project.config.build.command,
        output: project.config.build.output,
        ...(project.config.build.main ? { main: project.config.build.main } : {}),
      },
    },
    environment: options.environment,
    remote: {
      linked: !!remote,
      ...(remote ? { workerId: string(remote.id) } : {}),
    },
    canApply: summary.BLOCKED === 0,
    summary,
    actions,
  };
}
