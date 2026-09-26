import { planWorkerVariables, readWorkerVariableState, workerVariableDeclaration, workerArtifactBindingNames, type WorkerVariableDecision, type WorkerVariableDeclaration, type WorkerVariableMetadata } from "./workers-variable-plan.ts";
import { nativeDeploymentPlan, publicNativeDeploymentPlan, type NativeDeploymentPlan } from './workers-native-deployment.ts';
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import type {
  WorkerBillingQueryKind,
  WorkersClientOptions,
} from "./workers-client.ts";
import * as workersClient from "./workers-client.ts";
import { WorkerArtifactError } from "./workers-artifact.ts";
import { deploymentPrefix, currentMatchingDeployment } from "./workers-deployment-state.ts";
import { readWranglerDeploymentSettings, readWranglerPublicVars } from "./workers-wrangler-import.ts";
import {
  type LoadedWorkerProject,
  type WorkerProjectConfig,
  WorkerProjectConfigError,
  loadWorkerProject,
  resolveWorkerProjectPath,
} from "./workers-project.ts";
import { remoteWorkerResourceState, resourceReadyForDeployment } from "./workers-resource-state.ts";
import {
  prepareWorkerProjectBundle,
  loadWorkerProjectBundle,
  WorkerProjectBuildError,
  type WorkerProjectBuildRunner,
} from "./workers-project-build.ts";
import type { LoadedWorkerArtifact } from "./workers-artifact.ts";

export type WorkerPlanOperation =
  | "CREATE"
  | "UPDATE"
  | "NO_CHANGE"
  | "MANUAL"
  | "BLOCKED";

export type WorkerPlanKind =
  | "worker"
  | "budget"
  | "placement"
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
  variables?: WorkerVariableDecision[];
  nativeSteps?: { migrations: Array<{ bindingName: string; table: string; name: string; sha256: string }>; consumers: unknown[]; crons: string[] };
  project: {
    rootDir: string;
    configPath: string;
    workerId?: string;
    slug: string;
    build: { command: string; output: string; main?: string };
  };
  environment: "preview" | "production";
  remote: { linked: boolean; workerId?: string; activeDeploymentId?: string | null };
  costImpact: {
    status: "AVAILABLE" | "PARTIAL" | "UNKNOWN";
    desiredDailyBudgetUsd: number;
    currentDailyBudgetUsd?: number;
    dailyBudgetDeltaUsd?: number;
    priceBook?: {
      version?: string;
      effectiveFrom?: string;
      rateCount: number;
    };
    meteredChanges: Array<{
      kind: "worker" | "resource";
      key: string;
      type?: string;
      effect: "USAGE_DEPENDENT";
    }>;
    notes: string[];
  };
  canApply: boolean;
  summary: Record<WorkerPlanOperation, number>;
  actions: WorkerPlanAction[];
}

export interface PlanClient {
  getWorkerVariableState(options: WorkersClientOptions, id: string, environment: "preview" | "production"): Promise<unknown>;
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
  workerBillingQuery?(
    options: WorkersClientOptions,
    id: string,
    environment: string,
    kind: WorkerBillingQueryKind,
  ): Promise<unknown>;
}

export interface CreateWorkerPlanOptions {
  cwd?: string;
  configPath?: string;
  environment: "preview" | "production";
  clientOptions: WorkersClientOptions;
  client?: PlanClient;
}

export interface PrepareWorkerPlanOptions extends CreateWorkerPlanOptions {
  runBuild?: WorkerProjectBuildRunner;
}

export interface PreparedWorkerPlan {
  plan: WorkerDeploymentPlan;
  bundle: LoadedWorkerArtifact;
  nativePlan: NativeDeploymentPlan;
  configContent: string;
}

type UnknownRecord = Record<string, unknown>;
type DesiredResource =
  WorkerProjectConfig["environments"]["preview"]["resources"][number];

const PUBLIC_RESOURCE_TYPES: Record<DesiredResource["type"], string> = {
  kv_namespace: "kv",
  d1_database: "d1",
  r2_bucket: "r2",
  durable_object: "do",
  queue: "queue",
  workflow: "workflow",
};

const KIND_ORDER: Record<WorkerPlanKind, number> = {
  worker: 0,
  budget: 1,
  placement: 2,
  resource: 3,
  secret: 4,
  routing: 5,
  artifact: 6,
  deployment: 7,
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
  environment: "preview" | "production",
  workerId?: string,
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
    if (remoteByName.has(name)) {
      throw new WorkerProjectConfigError(
        "worker_plan_invalid_response",
        `xAPI returned duplicate managed resource binding ${name}`,
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
      ...(resource.location ? { location: resource.location } : {}),
      ...(resource.readReplication
        ? { readReplication: resource.readReplication }
        : {}),
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
    const state = remoteWorkerResourceState(existing);
    const existingType = state.type;
    const existingClassName = state.className;
    const requestedLocation = state.requestedLocation;
    const effectiveLocation = state.effectiveLocation;
    const comparableLocation = requestedLocation || effectiveLocation;
    const existingReadReplication = state.readReplication;
    const currentPlacement = {
      ...(requestedLocation ? { requestedLocation } : {}),
      ...(effectiveLocation ? { effectiveLocation } : {}),
      ...(existingReadReplication
        ? { readReplication: existingReadReplication }
        : {}),
    };
    if (
      existingType !== resource.type ||
      (["durable_object", "workflow"].includes(resource.type) &&
        existingClassName !== resource.className)
    ) {
      blocked = true;
      add(
        actions,
        "BLOCKED",
        "resource",
        resource.bindingName,
        "A binding with the same name has a different type or resource class; automatic replacement is unsafe",
        desiredState,
        {
          type: existingType || string(existing.type) || "unknown",
          ...(existingClassName ? { className: existingClassName } : {}),
        },
      );
      continue;
    }
    if (
      (resource.location && comparableLocation !== resource.location) ||
      (resource.readReplication &&
        existingReadReplication !== resource.readReplication)
    ) {
      blocked = true;
      add(
        actions,
        "BLOCKED",
        "resource",
        resource.bindingName,
        resource.location && comparableLocation !== resource.location
          ? "The existing resource is in another location; create a new binding and migrate data before switching"
          : "The existing D1 read-replication mode differs and xAPI has no in-place resource update endpoint; create a new binding and migrate data before switching",
        desiredState,
        {
          type: existingType,
          ...currentPlacement,
        },
      );
      continue;
    }
    const status = state.status;
    const readyForDeployment = resourceReadyForDeployment(state);
    if (!readyForDeployment) {
      blocked = true;
      const config = record(existing.config);
      const cancelledBeforeDispatch = status === "ERROR" &&
        existing.errorCode === "worker_control_cancelled_before_dispatch" &&
        existing.providerResourceId === null &&
        config?.__xapiDeletionIntentV1 === undefined && !config?.controlDeletionRequested;
      add(
        actions,
        "BLOCKED",
        "resource",
        resource.bindingName,
        cancelledBeforeDispatch
          ? `Previous creation was cancelled before provider dispatch. Retry the same binding: xapi workers resources create ${workerId || "<worker-id>"} --env ${environment} --type ${PUBLIC_RESOURCE_TYPES[resource.type]} --binding ${resource.bindingName}${resource.className ? ` --class-name '${resource.className}'` : ""}${resource.location ? ` --location ${resource.location}` : ""}${resource.readReplication ? ` --read-replication ${resource.readReplication}` : ""} --retention-price-version <current-quote-version>; then rerun plan. Preserve the existing resource ID.`
          : `Managed resource is ${status}; inspect xapi workers resources list ${workerId || "<worker-id>"} --env ${environment} and workers audit ${workerId || "<worker-id>"} before retrying. No resource will be recreated automatically.`,
        desiredState,
        { status, ...currentPlacement },
      );
      continue;
    }
    add(
      actions,
      "NO_CHANGE",
      "resource",
      resource.bindingName,
      status === "PROVISIONING"
        ? "Resource declaration is prepared and will become ACTIVE with the next deployment"
        : "Managed resource already matches desired state",
      desiredState,
      { status, ...currentPlacement },
    );
  }
  for (const [name, existing] of [...remoteByName].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    add(
      actions,
      "NO_CHANGE",
      "resource",
      name,
      `Not referenced by this JSON: remove its Worker binding on deploy, retain the resource and its storage charges. Physical deletion requires resources destroy.`,
      undefined,
      {
        ...(string(existing.id) ? { resourceId: string(existing.id) } : {}),
        type:
          remoteWorkerResourceState(existing).type ||
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

async function localArtifact(project: LoadedWorkerProject, environment: "preview" | "production"): Promise<{
  sha256?: string;
  sizeBytes?: number;
  configuration?: Record<string, unknown>;
  variables?: WorkerVariableDeclaration;
  blocked?: string;
}> {
  const path = resolveWorkerProjectPath(
    project,
    project.config.build.output,
    "build.output",
  );
  if (!existsSync(path)) {
    const settings = readWranglerDeploymentSettings(project, environment);
    return { variables: workerVariableDeclaration({
      vars: readWranglerPublicVars(project, environment) as Record<string, unknown> | undefined,
      keepBindings: settings.keepBindings,
    }, workerArtifactBindingNames({ assets: project.config.assets, versionMetadata: settings.versionMetadata })) };
  }
  try {
    const artifact = await loadWorkerProjectBundle(project, environment);
    return {
      sha256: artifact.contentSha256,
      sizeBytes: artifact.sizeBytes,
      variables: "bundle" in artifact.upload
        ? workerVariableDeclaration(artifact.upload.bundle,
            workerArtifactBindingNames(artifact.upload.bundle))
        : workerVariableDeclaration({}),
      ...("bundle" in artifact.upload ? {
        configuration: {
          ...(artifact.upload.bundle.cacheOptions
            ? { cache: artifact.upload.bundle.cacheOptions } : {}),
          ...(artifact.upload.bundle.versionMetadata
            ? { version_metadata: artifact.upload.bundle.versionMetadata } : {}),
          ...(artifact.upload.bundle.observability
            ? { observability: artifact.upload.bundle.observability } : {}),
          sourceMaps: artifact.upload.bundle.modules
            .filter(module => module.contentType === "application/source-map")
            .map(module => module.path),
        },
      } : {}),
    };
  } catch (error) {
    if (error instanceof WorkerArtifactError || error instanceof WorkerProjectBuildError) {
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

async function artifactAndDeployment(
  actions: WorkerPlanAction[],
  project: LoadedWorkerProject,
  remote: UnknownRecord | undefined,
  environmentId: string | undefined,
  blockedBeforeDeployment: boolean,
  environmentState: UnknownRecord | undefined,
  resources: UnknownRecord[],
  secrets: UnknownRecord[],
  environmentName: "preview" | "production",
  local: Awaited<ReturnType<typeof localArtifact>>,
): Promise<void> {
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
      {
        sha256: local.sha256,
        sizeBytes: local.sizeBytes,
        ...(local.configuration ? { configuration: local.configuration } : {}),
      },
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
          ? {
              sha256: local.sha256,
              sizeBytes: local.sizeBytes,
              ...(local.configuration ? { configuration: local.configuration } : {}),
            }
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
            readWranglerDeploymentSettings(project, environmentName), environmentState, resources.filter(resource => project.config.environments[environmentName].resources.some(desired => desired.bindingName === resource.bindingName)), secrets))
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

function planCostImpact(
  actions: WorkerPlanAction[],
  desiredDailyBudgetUsd: number,
  currentDailyBudgetUsd: number | undefined,
  priceResponse: unknown,
): WorkerDeploymentPlan["costImpact"] {
  const envelope = record(priceResponse);
  const data = record(envelope?.data);
  const rates = Array.isArray(data?.rates) ? data.rates : undefined;
  const priceVersion = string(data?.version);
  const effectiveFrom = string(data?.effectiveFrom);
  const meteredChanges: WorkerDeploymentPlan["costImpact"]["meteredChanges"] =
    actions
      .filter(
        (action) =>
          ["CREATE", "UPDATE"].includes(action.operation) &&
          (action.kind === "worker" || action.kind === "resource"),
      )
      .map((action) => ({
        kind: action.kind as "worker" | "resource",
        key: action.key,
        ...(action.kind === "resource" && string(action.desired?.type)
          ? { type: string(action.desired?.type) }
          : {}),
        effect: "USAGE_DEPENDENT" as const,
      }));
  const notes = [
    "The daily budget is a risk-control target, not a hard spending cap or predicted charge; observation and edge propagation can delay enforcement.",
    "Worker and managed-resource charges depend on measured usage; plan does not invent traffic or storage assumptions.",
    "First release and new resources may require a refundable retention quote. Push checks it before provisioning; a new project must first save its empty Worker record to obtain the scoped quote. READY is not balance or provider admission.",
  ];
  if (!rates) {
    notes.push(
      "The active price book could not be read for this environment; inspect billing before production promotion.",
    );
  }
  return {
    status: rates
      ? currentDailyBudgetUsd === undefined
        ? "PARTIAL"
        : "AVAILABLE"
      : currentDailyBudgetUsd === undefined
        ? "UNKNOWN"
        : "PARTIAL",
    desiredDailyBudgetUsd,
    ...(currentDailyBudgetUsd !== undefined
      ? {
          currentDailyBudgetUsd,
          dailyBudgetDeltaUsd:
            Math.round(
              (desiredDailyBudgetUsd - currentDailyBudgetUsd) * 1_000_000,
            ) / 1_000_000,
        }
      : {}),
    ...(rates
      ? {
          priceBook: {
            ...(priceVersion ? { version: priceVersion } : {}),
            ...(effectiveFrom ? { effectiveFrom } : {}),
            rateCount: rates.length,
          },
        }
      : {}),
    meteredChanges,
    notes,
  };
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
  let remoteVariables: WorkerVariableMetadata[] = [];
  let prerequisiteBlocked = false;

  if (project.config.workerId) {
    // Authorization failures and hidden instance scopes propagate as the
    // backend's safe 404; do not fall back to a list that could reveal state.
    remote = remoteWorker(
      await api.getWorker(options.clientOptions, project.config.workerId),
    );
    remoteEnvironmentState = remoteEnvironment(remote, options.environment);
    [remoteResources, remoteSecrets, remoteVariables] = await Promise.all([
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
      api.getWorkerVariableState(options.clientOptions, project.config.workerId, options.environment)
        .then(value => readWorkerVariableState(value, options.environment, string(remoteEnvironmentState?.activeDeploymentId) || null)),
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

  const desiredPlacement = {
    ...(desired.defaultResourceLocation ? { defaultResourceLocation: desired.defaultResourceLocation } : {}),
    ...(desired.placementMode ? { placementMode: desired.placementMode } : {}),
  };
  if (Object.keys(desiredPlacement).length) {
    const currentPlacement = {
      ...(string(remoteEnvironmentState?.defaultResourceLocation)
        ? { defaultResourceLocation: string(remoteEnvironmentState?.defaultResourceLocation) }
        : {}),
      placementMode: string(remoteEnvironmentState?.placementMode) || "off",
    };
    const matches =
      (!desired.defaultResourceLocation || currentPlacement.defaultResourceLocation === desired.defaultResourceLocation) &&
      (!desired.placementMode || currentPlacement.placementMode === desired.placementMode);
    add(
      actions,
      remoteEnvironmentState ? (matches ? "NO_CHANGE" : "UPDATE") : "CREATE",
      "placement",
      options.environment,
      remoteEnvironmentState
        ? matches
          ? "Environment placement already matches desired state"
          : "Update native Cloudflare environment placement before deployment"
        : "Set native Cloudflare environment placement during Worker creation",
      desiredPlacement,
      remoteEnvironmentState ? currentPlacement : undefined,
    );
  }

  prerequisiteBlocked =
    compareResources(actions, desired.resources, remoteResources, options.environment, project.config.workerId) ||
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
  const local = await localArtifact(project, options.environment);
  const variables = local.variables ? planWorkerVariables(local.variables, remoteVariables, [
    ...desired.resources.map(resource => resource.bindingName),
    ...desired.secrets,
    ...remoteSecrets.map(secret => string(secret.bindingName)!),
  ], remoteEnvironmentState?.bindings) : undefined;
  await artifactAndDeployment(
    actions,
    project,
    remote,
    string(remoteEnvironmentState?.id),
    prerequisiteBlocked,
    remoteEnvironmentState,
    remoteResources,
    remoteSecrets,
    options.environment,
    local,
  );

  let priceResponse: unknown;
  if (remote && api.workerBillingQuery) {
    try {
      priceResponse = await api.workerBillingQuery(
        options.clientOptions,
        project.config.workerId!,
        options.environment,
        "prices",
      );
    } catch {
      // Price visibility is advisory. A transient billing read must not turn a
      // valid deployment diff into a false success or a false blocker.
    }
  }

  const native = nativeDeploymentPlan(project, options.environment);
  actions.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.key.localeCompare(b.key) ||
      a.operation.localeCompare(b.operation),
  );
  const summary = planSummary(actions);
  return {
    schemaVersion: 1,
    ...(variables ? { variables } : {}),
    nativeSteps: publicNativeDeploymentPlan(native),
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
      activeDeploymentId: string(remoteEnvironmentState?.activeDeploymentId) || null,
      ...(remote ? { workerId: string(remote.id) } : {}),
    },
    costImpact: planCostImpact(
      actions,
      desired.dailyBudgetUsd,
      currentBudget,
      priceResponse,
    ),
    canApply:
      summary.BLOCKED === 0 &&
      !actions.some(
        (action) =>
          action.operation === "MANUAL" && action.kind === "resource",
      ),
    summary,
    actions,
  };
}

/**
 * Build and validate the exact local bundle before calculating the remote diff.
 * This may update local build output, but it never writes to the xAPI control
 * plane. Both `workers plan` and `workers push` use this path so the reviewed
 * Artifact is the one that push will upload.
 */
export async function prepareWorkerPlan(
  options: PrepareWorkerPlanOptions,
): Promise<PreparedWorkerPlan> {
  const project = loadWorkerProject(options.cwd, options.configPath);
  const configContent = readFileSync(project.configPath, "utf8");
  validatePlanInputs(project);
  const bundle = await prepareWorkerProjectBundle(
    project,
    options.environment,
    options.runBuild,
  );
  const nativePlan = nativeDeploymentPlan(project, options.environment);
  const plan = await createWorkerPlan(options);
  if (readFileSync(project.configPath, "utf8") !== configContent)
    throw new WorkerProjectBuildError("Project configuration changed while planning; rerun the plan", { remoteChangesApplied: false });
  if (JSON.stringify(plan.nativeSteps) !== JSON.stringify(publicNativeDeploymentPlan(nativePlan)))
    throw new Error('Wrangler configuration or migrations changed while planning; rerun the plan');
  return { plan, bundle, nativePlan, configContent };
}
