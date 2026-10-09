import { attachWorkerNativeMetadata } from './workers-artifact.ts';
import { requestDeadline } from './request-deadline.ts';
import { applyWorkerNativeEvents } from "./workers-native-events.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { HttpError, isRetryableRequestError } from "./client.ts";
import {
  type LoadedWorkerArtifact,
  loadWorkerArtifactInput,
  attachWorkerObservability,
  attachWorkerPublicVariables,
  validateNativeDeploymentMetadata,
  WorkerArtifactError,
  type WorkerArtifactUploadRequest,
} from "./workers-artifact.ts";
import type { WorkersClientOptions } from "./workers-client.ts";
import * as workersClient from "./workers-client.ts";
import {
  type LoadedWorkerProject,
  WorkerProjectConfigError,
  loadWorkerProject,
  resolveWorkerProjectPath,
  workerProjectConfigSchema,
  workerEnvironmentContainers,
} from "./workers-project.ts";
import {
  createWorkerPlan,
  type PlanClient,
  type WorkerDeploymentPlan,
} from "./workers-plan.ts";
import { readWranglerDeploymentSettings, readWranglerNativeEvents } from "./workers-wrangler-import.ts";
import { remoteWorkerResourceState } from "./workers-resource-state.ts";
import { deploymentPrefix, deploymentKey, currentMatchingDeployment, deploymentBindingResources } from "./workers-deployment-state.ts";

const WORKER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const DEPLOYMENT_TIMEOUT_MS = 3 * 60_000;
const HEALTH_ATTEMPTS = 10;
const HEALTH_INTERVAL_MS = 1_000;

type UnknownRecord = Record<string, unknown>;

export interface DeploymentClient {
  workerControlOperations?(options: WorkersClientOptions, id: string): Promise<unknown>;
  recoverWorkerControlOperation?(options: WorkersClientOptions, id: string, operationId: string): Promise<unknown>;
  listWorkerResources(options: WorkersClientOptions, id: string, environment: string): Promise<unknown>;
  listWorkerSecrets(options: WorkersClientOptions, id: string, environment: string): Promise<unknown>;
  getWorker(options: WorkersClientOptions, id: string): Promise<unknown>;
  deployWorker(
    options: WorkersClientOptions,
    id: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface PushClient extends PlanClient, DeploymentClient {
  createWorker(
    options: WorkersClientOptions,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  updateWorkerBudget(
    options: WorkersClientOptions,
    id: string,
    environment: string,
    dailyBudgetUsd: number | null,
  ): Promise<unknown>;
  createWorkerResource(
    options: WorkersClientOptions,
    id: string,
    environment: string,
    input: {
      type: string;
      bindingName: string;
      className?: string;
      workflowName?: string;
      location?: string;
      readReplication?: string;
      retentionPriceVersion?: string;
    },
  ): Promise<unknown>;
  listWorkerArtifacts(
    options: WorkersClientOptions,
    id: string,
  ): Promise<unknown>;
  uploadWorkerArtifact(
    options: WorkersClientOptions,
    id: string,
    input: WorkerArtifactUploadRequest,
  ): Promise<unknown>;
}

export interface ManagedResourceClient {
  listWorkerResources(
    options: WorkersClientOptions,
    id: string,
    environment: string,
  ): Promise<unknown>;
  createWorkerResource(
    options: WorkersClientOptions,
    id: string,
    environment: string,
    input: {
      type: string;
      bindingName: string;
      className?: string;
      workflowName?: string;
      location?: string;
      readReplication?: string;
      retentionPriceVersion?: string;
    },
  ): Promise<unknown>;
}

export interface PushWorkerProjectOptions {
  cwd?: string;
  configPath?: string;
  environment: "preview";
  clientOptions: WorkersClientOptions;
  nonInteractive?: boolean;
  retentionPriceVersion?: string;
  client?: PushClient;
  confirm?: (plan: WorkerDeploymentPlan) => Promise<boolean>;
  onPlan?: (plan: WorkerDeploymentPlan) => void;
  buildTimeoutMs?: number;
  runBuild?: (command: string, cwd: string, timeoutMs: number) => Promise<void>;
  fetchPublic?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface WorkerPushResult {
  schemaVersion: 1;
  status: "ACTIVE";
  initialPlan: WorkerDeploymentPlan;
  worker: { id: string; created: boolean; configLinked: boolean };
  resources: { created: string[]; unchanged: string[] };
  events?: { queueConsumers: string[]; crons: string[] };
  artifact: { id: string; contentSha256: string; sizeBytes: number };
  deployment: { id: string; status: "ACTIVE"; idempotencyKey: string; containerRollout?: Record<string, unknown> };
  publicUrl: string;
  routing?: { mode?: string; webAppReady: boolean; publicOrigin?: string; publicBasePath?: string };
  health: { url: string; status: number; attempts: number };
  commands: { logs: string; promote: string };
}

export class WorkerPushError extends Error {
  constructor(
    message: string,
    public readonly recovery: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkerPushError";
  }
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkerPushError(`xAPI returned an invalid ${label} response`);
  }
  return value as UnknownRecord;
}

function records(value: unknown, label: string): UnknownRecord[] {
  const raw = Array.isArray(value)
    ? value
    : Array.isArray(
          value && typeof value === "object"
            ? (value as UnknownRecord).items
            : undefined,
        )
      ? ((value as UnknownRecord).items as unknown[])
      : undefined;
  if (!raw)
    throw new WorkerPushError(`xAPI returned an invalid ${label} response`);
  return raw.map((item) => record(item, `${label} item`));
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function amount(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableKey(...parts: string[]): string {
  return sha256(parts.join("\0"));
}

/**
 * A write carrying a stable idempotency key must reconcile after any 5xx.
 * The server may have committed the write before returning an internal error;
 * a read determines whether the same key should be reused safely.
 */
function shouldReconcileWrite(error: unknown): boolean {
  return (
    isRetryableRequestError(error) ||
    (error instanceof HttpError && error.status >= 500)
  );
}

function sanitizedBuildEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:$|_)/i.test(
          name,
        ) && name !== "XAPI_KEY",
    ),
  );
}

async function defaultRunBuild(command: string, cwd: string, timeoutMs = BUILD_TIMEOUT_MS): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: sanitizedBuildEnvironment(),
      shell: true,
      // Build programs may print arbitrary text. Keep the CLI result channel
      // machine-readable, without buffering or suppressing build diagnostics.
      stdio: ["inherit", process.stderr, process.stderr],
    });
    const timer = requestDeadline(() => {
      child.kill("SIGTERM");
      reject(
        new WorkerPushError(
          `Build exceeded the selected ${timeoutMs}ms timeout; use --build-timeout to change it`,
        ),
      );
    }, timeoutMs);
    child.once("error", (error) => {
      timer.dispose();
      reject(new WorkerPushError(`Unable to start build: ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      timer.dispose();
      if (code === 0) resolve();
      else {
        reject(
          new WorkerPushError(
            code === 127
              ? "Build command could not run because a required executable was not found"
              : `Build failed${signal ? ` with ${signal}` : ` with exit code ${code}`}`,
            {
              buildCommand: command,
              projectRoot: cwd,
              ...(code === 127
                ? {
                    next: "Install the package manager used by build.command, then rerun workers push",
                  }
                : {}),
            },
          ),
        );
      }
    });
  });
}

async function terminalConfirm(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new WorkerPushError(
      "Interactive confirmation requires a TTY; review workers plan and rerun with --non-interactive in CI",
    );
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await prompt.question("Apply this preview plan? [y/N] ");
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function validateBundle(project: LoadedWorkerProject, environment: 'preview' | 'production'): Promise<LoadedWorkerArtifact> {
  const path = resolveWorkerProjectPath(
    project,
    project.config.build.output,
    "build.output",
  );
  try {
    return await loadWorkerArtifactInput(
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
      workerEnvironmentContainers(project.config, environment),
    );
  } catch (error) {
    if (error instanceof WorkerArtifactError) {
      throw new WorkerPushError(error.message);
    }
    throw error;
  }
}

function environmentOf(
  worker: UnknownRecord,
  environment: "preview" | "production",
): UnknownRecord {
  const environments = records(worker.environments, "Worker environments");
  const selected = environments.find(
    (item) => text(item.name)?.toLowerCase() === environment,
  );
  if (!selected || !text(selected.id)) {
    throw new WorkerPushError(`xAPI Worker is missing ${environment}`);
  }
  return selected;
}

function validateWorkerId(value: unknown): string {
  const id = text(value);
  if (!id || !WORKER_ID.test(id)) {
    throw new WorkerPushError("xAPI returned an invalid Worker ID");
  }
  return id;
}

function persistWorkerId(
  project: LoadedWorkerProject,
  expectedConfigSha256: string,
  workerId: string,
): void {
  const current = readFileSync(project.configPath, "utf8");
  if (sha256(current) !== expectedConfigSha256) {
    throw new WorkerPushError(
      "Worker was created, but xapi.worker.json changed concurrently and was not overwritten",
      {
        workerId,
        configPath: project.configPath,
        repair: `Set top-level workerId to ${workerId}, then rerun workers plan`,
      },
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(current);
  } catch {
    throw new WorkerPushError(
      "Worker was created, but xapi.worker.json is no longer valid JSON",
      { workerId, configPath: project.configPath },
    );
  }
  const candidate = workerProjectConfigSchema.safeParse({
    ...(raw as UnknownRecord),
    workerId,
  });
  if (!candidate.success) {
    throw new WorkerPushError(
      "Worker was created, but the updated project configuration did not validate",
      { workerId, configPath: project.configPath },
    );
  }
  const temporary = `${project.configPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(candidate.data, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: statSync(project.configPath).mode & 0o777,
    });
    renameSync(temporary, project.configPath);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function ensureWorker(
  project: LoadedWorkerProject,
  initialConfigSha256: string,
  api: PushClient,
  options: WorkersClientOptions,
): Promise<{ worker: UnknownRecord; id: string; created: boolean }> {
  if (project.config.workerId) {
    const worker = record(
      await api.getWorker(options, project.config.workerId),
      "Worker",
    );
    const id = validateWorkerId(worker.id);
    if (id !== project.config.workerId) {
      throw new WorkerPushError(
        "xAPI returned a different Worker than requested",
      );
    }
    return { worker, id, created: false };
  }
  const desired = project.config;
  let created: UnknownRecord | undefined;
  try {
    created = record(
      await api.createWorker(options, {
        name: desired.worker.name,
        slug: desired.worker.slug,
        description: desired.worker.description,
        template: desired.worker.template,
        previewDailyBudgetUsd: desired.environments.preview.dailyBudgetUsd,
        productionDailyBudgetUsd:
          desired.environments.production.dailyBudgetUsd,
      }),
      "created Worker",
    );
  } catch (error) {
    if (!shouldReconcileWrite(error)) throw error;
    const matches = records(
      await api.listWorkers(options),
      "Workers list",
    ).filter(
      (item) =>
        item.slug === desired.worker.slug && item.name === desired.worker.name,
    );
    if (matches.length !== 1) throw error;
    created = matches[0];
  }
  const id = validateWorkerId(created.id);
  persistWorkerId(project, initialConfigSha256, id);
  return { worker: created, id, created: true };
}

async function ensureBudget(
  api: PushClient,
  options: WorkersClientOptions,
  workerId: string,
  desired: number | null,
): Promise<void> {
  let worker = record(await api.getWorker(options, workerId), "Worker");
  let environment = environmentOf(worker, "preview");
  if (
    (desired === null ? environment.dailyBudgetUsd === null : Math.abs((amount(environment.dailyBudgetUsd) ?? NaN) - desired) <= 0.00005)
  ) {
    return;
  }
  try {
    await api.updateWorkerBudget(options, workerId, "preview", desired);
  } catch (error) {
    if (!shouldReconcileWrite(error)) throw error;
    worker = record(await api.getWorker(options, workerId), "Worker");
    environment = environmentOf(worker, "preview");
    if (
      !(desired === null ? environment.dailyBudgetUsd === null : Math.abs((amount(environment.dailyBudgetUsd) ?? NaN) - desired) <= 0.00005)
    ) {
      throw error;
    }
  }
}

export function resourceMatches(
  remote: UnknownRecord,
  desired: UnknownRecord,
): boolean {
  const state = remoteWorkerResourceState(remote);
  const remoteLocation = state.requestedLocation || state.effectiveLocation;
  return (
    state.type === desired.type &&
    (!['durable_object', 'workflow'].includes(String(desired.type)) || state.className === desired.className) &&
    (desired.type !== 'workflow' || !desired.workflowName || state.workflowName === desired.workflowName) &&
    (!desired.location || remoteLocation === desired.location) &&
    (!desired.readReplication ||
      state.readReplication === desired.readReplication)
  );
}

export async function ensureManagedResources(
  api: ManagedResourceClient,
  options: WorkersClientOptions,
  workerId: string,
  environment: "preview" | "production",
  desired: LoadedWorkerProject["config"]["environments"]["preview"]["resources"],
  retentionPriceVersion?: string,
): Promise<{ created: string[]; unchanged: string[] }> {
  let remote = records(
    await api.listWorkerResources(options, workerId, environment),
    "managed resources",
  );
  const remoteBindings = new Set<string>();
  for (const item of remote) {
    const bindingName = text(item.bindingName);
    if (!bindingName) {
      throw new WorkerPushError("xAPI returned a managed resource without bindingName", {
        workerId,
      });
    }
    if (remoteBindings.has(bindingName)) {
      throw new WorkerPushError(
        `xAPI returned duplicate managed resource binding ${bindingName}`,
        { workerId, bindingName },
      );
    }
    remoteBindings.add(bindingName);
  }
  const created: string[] = [];
  const unchanged: string[] = [];
  for (const resource of [...desired].sort((a, b) =>
    a.bindingName.localeCompare(b.bindingName),
  )) {
    let existing = remote.find(
      (item) => item.bindingName === resource.bindingName,
    );
    if (existing) {
      if (!resourceMatches(existing, resource)) {
        throw new WorkerPushError(
          `Binding ${resource.bindingName} already exists with incompatible state`,
          { workerId, bindingName: resource.bindingName },
        );
      }
      unchanged.push(resource.bindingName);
      continue;
    }
    try {
      await api.createWorkerResource(options, workerId, environment, {
        ...resource,
        ...(retentionPriceVersion ? { retentionPriceVersion } : {}),
      });
    } catch (error) {
      if (!shouldReconcileWrite(error)) throw error;
      remote = records(
        await api.listWorkerResources(options, workerId, environment),
        "managed resources",
      );
      existing = remote.find(
        (item) => item.bindingName === resource.bindingName,
      );
      if (!existing || !resourceMatches(existing, resource)) throw error;
    }
    created.push(resource.bindingName);
    remote.push({ ...resource, status: "ACTIVE" });
  }
  return { created: created.sort(), unchanged: unchanged.sort() };
}

async function missingSecrets(
  api: PushClient,
  options: WorkersClientOptions,
  workerId: string,
  desired: string[],
): Promise<string[]> {
  const remote = records(
    await api.listWorkerSecrets(options, workerId, "preview"),
    "Secret metadata",
  );
  const existing = new Set(remote.map((item) => text(item.bindingName)));
  return desired.filter((name) => !existing.has(name)).sort();
}

async function ensureArtifact(
  api: PushClient,
  options: WorkersClientOptions,
  workerId: string,
  bundle: Awaited<ReturnType<typeof validateBundle>>,
): Promise<UnknownRecord> {
  const idempotencyKey = stableKey(
    "xapi-worker-artifact-v1",
    workerId,
    bundle.contentSha256,
  );
  const find = async () =>
    records(await api.listWorkerArtifacts(options, workerId), "Artifacts").find(
      (item) => item.contentSha256 === bundle.contentSha256,
    );
  const prior = await find();
  if (prior) return prior;
  try {
    return record(
      await api.uploadWorkerArtifact(options, workerId, {
        ...bundle.upload,
        idempotencyKey,
      }),
      "Artifact",
    );
  } catch (error) {
    if (!shouldReconcileWrite(error)) throw error;
    const reconciled = await find();
    if (reconciled) return reconciled;
    throw error;
  }
}

async function deploymentFromWorker(
  api: DeploymentClient,
  options: WorkersClientOptions,
  workerId: string,
  idempotencyKey: string,
): Promise<UnknownRecord | undefined> {
  const worker = record(await api.getWorker(options, workerId), "Worker");
  return records(worker.deployments || [], "Deployments").find(
    (item) => item.idempotencyKey === idempotencyKey,
  );
}

async function waitForActiveDeployment(
  api: DeploymentClient,
  options: WorkersClientOptions,
  workerId: string,
  deployment: UnknownRecord,
  idempotencyKey: string,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<UnknownRecord> {
  const started = Date.now();
  let current = deployment;
  while (true) {
    const status = text(current.status);
    if (status === "ACTIVE") return current;
    if (status === "FAILED") {
      throw new WorkerPushError("Worker deployment failed", {
        workerId,
        deploymentId: text(current.id),
        errorCode: text(current.errorCode),
        errorMessage: text(current.errorMessage),
        outcome: current.outcome,
        automaticReplay: false,
        recovery: `xapi workers get ${workerId}`,
      });
    }
    if (status !== "DEPLOYING") {
      throw new WorkerPushError(
        `Worker deployment returned status ${status || "UNKNOWN"}`,
        {
          workerId,
          deploymentId: text(current.id),
        },
      );
    }
    if (Date.now() - started >= DEPLOYMENT_TIMEOUT_MS) {
      throw new WorkerPushError(
        "Timed out waiting for deployment to become ACTIVE",
        {
          workerId,
          deploymentId: text(current.id),
          recovery: `xapi workers get ${workerId}`,
        },
      );
    }
    await sleep(1_000);
    const reconciled = await deploymentFromWorker(
      api,
      options,
      workerId,
      idempotencyKey,
    );
    if (reconciled) current = reconciled;
  }
}

export async function ensureActiveDeployment(
  api: DeploymentClient,
  options: WorkersClientOptions,
  workerId: string,
  artifactId: string,
  environment: "preview" | "production",
  compatibility: ReturnType<typeof readWranglerDeploymentSettings>,
  sleep: (milliseconds: number) => Promise<void>,
  retentionPriceVersion?: string,
  desiredBindingNames?: string[],
  containerOverrides?: import("./workers-artifact.ts").WorkerContainerInput[],
): Promise<{ deployment: UnknownRecord; idempotencyKey: string }> {
  const currentWorker = record(
    await api.getWorker(options, workerId),
    "Worker",
  );
  const environmentState = environmentOf(currentWorker, environment);
  const [resourceState, secretState] = await Promise.all([
    api.listWorkerResources(options, workerId, environment),
    api.listWorkerSecrets(options, workerId, environment),
  ]);
  const resourceIds = records(resourceState, "managed resources").filter(resource => {
    if (resource.type === "CONTAINER_APPLICATION") return false;
    if (desiredBindingNames && !desiredBindingNames.includes(String(resource.bindingName))) return false;
    const config = resource.config as UnknownRecord | undefined;
    return resource.status === "ACTIVE" || (resource.status === "PROVISIONING" &&
      (resource.type === "DURABLE_OBJECT" || (config?.nativeWorkflow as UnknownRecord | undefined)?.prepared === true));
  }).map(resource => text(resource.id)).filter((id): id is string => Boolean(id)).sort();
  const prefix = deploymentPrefix(workerId, environment, artifactId, {...compatibility, ...(containerOverrides !== undefined ? {containers:containerOverrides} : {})},
    environmentState, deploymentBindingResources(records(resourceState, "managed resources"), desiredBindingNames), records(secretState, "Secrets"));
  const alreadyActive = currentMatchingDeployment(records(currentWorker.deployments || [], "Deployments"),
    environmentState, artifactId, prefix);
  if (alreadyActive) {
    return { deployment: alreadyActive, idempotencyKey: text(alreadyActive.idempotencyKey)! };
  }
  // Match immutable intent first. A new explicit run may retry an unsent or rejected
  // attempt, but it must reconcile a possibly dispatched operation by identity.
  const matching = records(currentWorker.deployments || [], "Deployments")
    .filter(item => item.environmentId === environmentState.id && item.artifactId === artifactId &&
      typeof item.idempotencyKey === "string" && item.idempotencyKey.startsWith(prefix) && item.status !== "ACTIVE")
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  let deployment: UnknownRecord | undefined = matching[0];
  let idempotencyKey = text(deployment?.idempotencyKey) || deploymentKey(prefix, environmentState);
  if (deployment?.status === "FAILED") {
    let outcome = deployment.outcome as UnknownRecord | null;
    const providerResult = deployment.providerResult as UnknownRecord | undefined;
    const operationId = text(outcome?.operationId) || text(providerResult?.controlOperationId);
    if (!outcome && operationId && api.workerControlOperations) {
      const history = record(await api.workerControlOperations(options, workerId), "Control operation history");
      const operation = records(history.operations, "Control operations").find(item => item.id === operationId);
      outcome = operation?.outcome as UnknownRecord | null;
    }
    if (["NOT_DISPATCHED", "REJECTED"].includes(String(outcome?.providerEffect)) && text(outcome?.operationId)) {
      // Keep one identity throughout this invocation, including lost-response
      // reconciliation. Unchanged successful deployments still reuse ACTIVE.
      idempotencyKey = prefix + createHash("sha256").update(JSON.stringify([environmentState.activeDeploymentId || "initial", deployment.id, outcome?.operationId])).digest("hex").slice(0,32);
      deployment = undefined;
    } else if (operationId && api.recoverWorkerControlOperation) {
      await api.recoverWorkerControlOperation(options, workerId, operationId);
      deployment = await deploymentFromWorker(api, options, workerId, idempotencyKey);
      if (!deployment) throw new WorkerPushError("The original deployment journal could not be reconciled; no new deployment was sent", {workerId, operationId, idempotencyKey, automaticReplay:false});
      const observed=deployment.outcome as UnknownRecord | undefined;
      if(deployment.status==='FAILED' && observed?.providerEffect==='ALL_WRITES_CONFIRMED' &&
        (observed.observation as UnknownRecord | undefined)?.status==='MATCH') {
        // This explicit invocation can publish again only after all prior writes
        // are known complete. The old UNKNOWN operation is never replayed.
        idempotencyKey=prefix+createHash('sha256').update(JSON.stringify([
          environmentState.activeDeploymentId || 'initial',deployment.id,operationId,'native-confirmed-explicit-publish'])).digest('hex').slice(0,32);
        deployment=undefined;
      }
    }
  }
  if (!deployment) {
    try {
      deployment = record(
        await api.deployWorker(options, workerId, {
          environment,
          artifactId,
          resourceIds,
          idempotencyKey,
          compatibilityDate: compatibility.compatibilityDate,
          compatibilityFlags: compatibility.compatibilityFlags,
          ...(compatibility.requiredSecrets !== undefined ? { requiredSecrets: compatibility.requiredSecrets } : {}),
          ...(compatibility.queueBindingAliases !== undefined ? {queueBindingAliases: compatibility.queueBindingAliases} : {}),
          ...(compatibility.variables !== undefined ? {variables: compatibility.variables} : {}),
          ...(compatibility.nativeMetadata !== undefined ? {nativeMetadata:compatibility.nativeMetadata} : {}),
          ...(containerOverrides !== undefined ? {containers:containerOverrides} : {}),
          ...(retentionPriceVersion ? { retentionPriceVersion } : {}),
        }),
        "Deployment",
      );
    } catch (error) {
      if (!shouldReconcileWrite(error)) throw error;
      deployment = await deploymentFromWorker(
        api,
        options,
        workerId,
        idempotencyKey,
      );
      if (!deployment) throw error;
    }
  }
  return {
    deployment: await waitForActiveDeployment(
      api,
      options,
      workerId,
      deployment,
      idempotencyKey,
      sleep,
    ),
    idempotencyKey,
  };
}

export async function checkWorkerHealth(
  worker: UnknownRecord,
  environmentName: "preview" | "production",
  path: string,
  fetchPublic: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<{ url: string; status: number; attempts: number }> {
  const environment = environmentOf(worker, environmentName);
  const publicUrl = text(environment.publicUrl);
  if (!publicUrl)
    throw new WorkerPushError("ACTIVE deployment has no publicUrl");
  let target: URL;
  try {
    target = new URL(publicUrl);
    const suffix = new URL(path, "https://health-path.invalid");
    target.pathname = `${target.pathname.replace(/\/$/, "")}${suffix.pathname}`;
    target.search = suffix.search;
    target.hash = suffix.hash;
  } catch {
    throw new WorkerPushError("xAPI returned an invalid Worker publicUrl");
  }
  if (target.protocol !== "https:" && target.hostname !== "localhost") {
    throw new WorkerPushError("Worker health URL must use HTTPS");
  }
  let lastStatus = 0;
  // A just-published permit can still be hidden by CF KV's negative cache.
  // Observe readiness only; never upload or activate code again here.
  let deadline = Infinity;
  let propagationObserved = false;
  let attempts = 0;
  for (let attempt = 1; attempt <= (propagationObserved ? 21 : HEALTH_ATTEMPTS) && Date.now() < deadline; attempt += 1) {
    attempts = attempt;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(10_000, Math.max(1, deadline - Date.now())));
    try {
      const response = await fetchPublic(target, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
      lastStatus = response.status;
      if (response.ok) {
        await response.body?.cancel();
        return {
          url: target.toString(),
          status: response.status,
          attempts: attempt,
        };
      }
      if (response.status === 503 && response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.json().catch(() => null) as { error?: { code?: string } } | null;
        if (!propagationObserved && body?.error?.code === 'workers_postpaid_state_unavailable') {
          propagationObserved = true;
          deadline = Date.now() + 60_000;
        }
      } else {
        await response.body?.cancel();
      }
    } catch {
      lastStatus = 0;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < (propagationObserved ? 21 : HEALTH_ATTEMPTS) && Date.now() < deadline)
      await sleep(Math.min(propagationObserved ? 3_000 : HEALTH_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  throw new WorkerPushError(
    "Deployment is ACTIVE but its public health check is not ready",
    {
      publicUrl,
      healthUrl: target.toString(),
      lastStatus,
      attempts,
      deploymentStatus: 'ACTIVE',
      publicAccessStatus: 'UNVERIFIED',
      billingPropagationObserved: propagationObserved,
      recovery: `xapi workers logs ${text(worker.id) || "<worker-id>"} --env ${environmentName}`,
    },
  );
}

function unsafePlanBlockers(
  plan: WorkerDeploymentPlan,
  unlinked: boolean,
): string[] {
  return plan.actions
    .filter(
      (action) =>
        action.operation === "BLOCKED",
    )
    .filter(
      (action) =>
        !(
          unlinked &&
          (action.kind === "secret" || action.kind === "deployment")
        ),
    )
    .map((action) => `${action.kind}:${action.key}`);
}

export async function pushWorkerProject(
  options: PushWorkerProjectOptions,
): Promise<WorkerPushResult> {
  if (options.environment !== "preview") {
    throw new WorkerPushError(
      "workers push only accepts --env preview; use workers promote for production",
    );
  }
  if (options.buildTimeoutMs != null && (!Number.isSafeInteger(options.buildTimeoutMs) || options.buildTimeoutMs <= 0)) throw new WorkerPushError('Invalid build timeout');
  const api = options.client || (workersClient as PushClient);
  const project = loadWorkerProject(options.cwd, options.configPath);
  const initialConfig = readFileSync(project.configPath, "utf8");
  const initialConfigSha256 = sha256(initialConfig);
  const compatibility = readWranglerDeploymentSettings(project, "preview");
  const initialPlan = await createWorkerPlan({
    cwd: project.rootDir,
    configPath: project.configPath,
    environment: "preview",
    clientOptions: options.clientOptions,
    client: api,
  });
  options.onPlan?.(initialPlan);
  const blockers = unsafePlanBlockers(initialPlan, !project.config.workerId);
  if (blockers.length || (options.nonInteractive && !initialPlan.canApply)) {
    throw new WorkerPushError(
      "Preview plan requires reconciliation and no changes were applied",
      {
        blockers:
          blockers.length > 0
            ? blockers
            : initialPlan.actions
                .filter(
                  (action) =>
                    action.operation === "BLOCKED" ||
                    (action.operation === "MANUAL" &&
                      action.kind === "resource"),
                )
                .map((action) => `${action.kind}:${action.key}`),
        next: "Resolve BLOCKED and MANUAL resource items, then rerun xapi workers plan --env preview",
      },
    );
  }
  if (!options.nonInteractive) {
    const confirmed = await (options.confirm || terminalConfirm)(initialPlan);
    if (!confirmed)
      throw new WorkerPushError(
        "Preview push cancelled; no changes were applied",
      );
  }

  let workerState: { worker: UnknownRecord; id: string; created: boolean };
  try {
    workerState = await ensureWorker(
      project,
      initialConfigSha256,
      api,
      options.clientOptions,
    );
  } catch (error) {
    if (error instanceof WorkerPushError) throw error;
    throw new WorkerPushError(
      error instanceof Error
        ? error.message
        : "Unable to create or read Worker",
    );
  }
  const linkedProject = loadWorkerProject(project.rootDir, project.configPath);
  try {
    await ensureBudget(
      api,
      options.clientOptions,
      workerState.id,
      linkedProject.config.environments.preview.dailyBudgetUsd,
    );
    const resources = await ensureManagedResources(
      api,
      options.clientOptions,
      workerState.id,
      "preview",
      linkedProject.config.environments.preview.resources,
      options.retentionPriceVersion,
    );
    const missing = await missingSecrets(
      api,
      options.clientOptions,
      workerState.id,
      linkedProject.config.environments.preview.secrets,
    );
    if (missing.length) {
      throw new WorkerPushError(
        "Worker prerequisites were saved, but required Secrets are missing; build and deployment were not started",
        {
          workerId: workerState.id,
          missingSecrets: missing,
          commands: missing.map(
            (name) =>
              `xapi workers secrets set ${workerState.id} ${name} --env preview --from-env ${name}`,
          ),
        },
      );
    }
    await (options.runBuild || defaultRunBuild)(
      linkedProject.config.build.command,
      linkedProject.rootDir,
      options.buildTimeoutMs ?? BUILD_TIMEOUT_MS,
    );
    const bundle = attachWorkerPublicVariables(
      attachWorkerObservability(await validateBundle(linkedProject, options.environment), undefined, compatibility.queueBindingAliases),
      compatibility.variables);
    const nativeBundle = attachWorkerNativeMetadata(bundle, compatibility.nativeMetadata);
    validateNativeDeploymentMetadata(nativeBundle, compatibility, linkedProject.config.environments.preview.resources);
    readWranglerNativeEvents(linkedProject, "preview");
    const artifact = await ensureArtifact(
      api,
      options.clientOptions,
      workerState.id,
      nativeBundle,
    );
    const artifactId = text(artifact.id);
    if (!artifactId)
      throw new WorkerPushError("xAPI returned an Artifact without id");
    if (artifact.contentSha256 !== nativeBundle.contentSha256) {
      throw new WorkerPushError(
        "xAPI Artifact hash does not match the local bundle",
        {
          artifactId,
        },
      );
    }
    const deployed = await ensureActiveDeployment(
      api,
      options.clientOptions,
      workerState.id,
      artifactId,
      "preview",
      {...compatibility,...('bundle' in nativeBundle.upload && nativeBundle.upload.bundle.nativeMetadata !== undefined ? {nativeMetadata:nativeBundle.upload.bundle.nativeMetadata} : {})},
      options.sleep ||
        ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds))),
      options.retentionPriceVersion,
      project.config.environments.preview.resources.map(resource => resource.bindingName),
      workerEnvironmentContainers(project.config, 'preview'),
    );
    const deploymentId = text(deployed.deployment.id);
    if (!deploymentId) {
      throw new WorkerPushError("ACTIVE deployment response is missing id");
    }
    let events;
    try { events = await applyWorkerNativeEvents(linkedProject, "preview", workerState.id, api, options.clientOptions); }
    catch (error) { throw new WorkerPushError(`Worker deployment is ACTIVE, but native event configuration failed: ${error instanceof Error ? error.message : String(error)}`, {workerId:workerState.id, deploymentId, deploymentStatus:"ACTIVE", recovery:`xapi workers plan --env preview`}); }
    const finalWorker = record(
      await api.getWorker(options.clientOptions, workerState.id),
      "Worker",
    );
    const health = await checkWorkerHealth(
      finalWorker,
      "preview",
      linkedProject.config.environments.preview.healthCheck,
      options.fetchPublic || fetch,
      options.sleep ||
        ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds))),
    );
    const publicUrl = text(environmentOf(finalWorker, "preview").publicUrl)!;
    const finalEnvironment = environmentOf(finalWorker, "preview");
    return {
      schemaVersion: 1,
      status: "ACTIVE",
      initialPlan,
      worker: {
        id: workerState.id,
        created: workerState.created,
        configLinked: linkedProject.config.workerId === workerState.id,
      },
      resources,
      ...((events.queueConsumers.length || events.crons.length) ? {events} : {}),
      artifact: {
        id: artifactId,
        contentSha256: nativeBundle.contentSha256,
        sizeBytes: nativeBundle.sizeBytes,
      },
      deployment: {
        id: deploymentId,
        status: "ACTIVE",
        idempotencyKey: deployed.idempotencyKey,
        ...(deployed.deployment.containerRollout && typeof deployed.deployment.containerRollout === "object"
          ? { containerRollout: deployed.deployment.containerRollout as Record<string, unknown> } : {}),
      },
      publicUrl,
      ...(linkedProject.config.assets ? { routing: {
        mode: text(finalEnvironment.routingMode),
        webAppReady: finalEnvironment.webAppReady === true,
        publicOrigin: text(finalEnvironment.publicOrigin),
        publicBasePath: text(finalEnvironment.publicBasePath),
      } } : {}),
      health,
      commands: {
        logs: `xapi workers logs ${workerState.id} --env preview`,
        promote: "xapi workers promote --to production",
      },
    };
  } catch (error) {
    if (error instanceof WorkerPushError) {
      throw new WorkerPushError(error.message, {
        workerId: workerState.id,
        resourcesPreserved: true,
        ...error.recovery,
      });
    }
    throw new WorkerPushError(
      error instanceof Error ? error.message : "Preview push failed",
      {
        workerId: workerState.id,
        resourcesPreserved: true,
        recovery: `xapi workers plan --env preview`,
      },
    );
  }
}
