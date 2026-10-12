import { planWorkerNativeEvents } from "./workers-native-events.ts";
import { planWorkerVariables, readWorkerVariableState, readWorkerArtifactVariableConfiguration, workerVariableDeclaration, type WorkerVariableDecision } from "./workers-variable-plan.ts";
import { remoteWorkerResourceState, resourceReadyForDeployment } from "./workers-resource-state.ts";
import { nativeDeploymentPlan, publicNativeDeploymentPlan, applyNativeDeploymentPhase, NativeDeploymentError, type NativeDeploymentClient, type NativeDeploymentPlan } from './workers-native-deployment.ts';
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
import { workerEnvironmentContainers, loadWorkerProject } from "./workers-project.ts";
import { readWranglerDeploymentSettings, type WranglerConfigurationSettings } from "./workers-wrangler-import.ts";
import { conflictingWorkerSecretBinding } from "./workers-binding-validation.ts";
import type { WorkerVariableType } from "./workers-artifact.ts";

type UnknownRecord = Record<string, unknown>;

export interface PromotionClient extends DeploymentClient, ManagedResourceClient, NativeDeploymentClient {
  getWorkerArtifact?(options: WorkersClientOptions, id: string, artifactId: string): Promise<unknown>;
  getWorkerVariableState(options: WorkersClientOptions, id: string, environment: "preview" | "production"): Promise<unknown>;
  getWorkerArtifactVariableConfiguration(options: WorkersClientOptions, id: string, artifactId: string): Promise<unknown>;
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
  | "UPDATE"
  | "NO_CHANGE"
  | "MANUAL"
  | "BLOCKED";

export interface WorkerPromotionCheck {
  status: PromotionCheckStatus;
  kind: "budget" | "placement" | "resource" | "secret" | "routing" | "event";
  key: string;
  message: string;
  command?: string;
}

export interface WorkerPromotionPlan {
  schemaVersion: 1;
  variables?: WorkerVariableDecision[];
  nativeMetadata?: Record<string, unknown>;
  workerId: string;
  to: "production";
  previewDeployment: { id: string; artifactId: string; deployedAt?: string };
  artifact: { id: string; contentSha256: string; sizeBytes?: number };
  production: {
    activeDeploymentId?: string | null;
    checks: WorkerPromotionCheck[];
    dataRisk: string[];
  };
  nativeSteps: ReturnType<typeof publicNativeDeploymentPlan>;
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
  nativeReceipts: unknown[];
  events: {queueConsumers:string[]; crons:string[]};
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
    "Promotion deploys the selected Worker Artifact and the displayed local Wrangler event plan; it does not snapshot, copy, or roll back production data",
  ];
  const currentBudget = remoteEnvironment.dailyBudgetUsd === null ? null : amount(remoteEnvironment.dailyBudgetUsd);
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
    (desired.dailyBudgetUsd === null ? currentBudget !== null : currentBudget === null || Math.abs(currentBudget - desired.dailyBudgetUsd) > 0.00005)
  ) {
    checks.push({
      status: "BLOCKED",
      kind: "budget",
      key: "production",
      message: `Production budget is ${currentBudget ?? "unknown"}; desired is ${desired.dailyBudgetUsd === null ? "none" : desired.dailyBudgetUsd}`,
      command: `xapi workers budget ${workerId} production --daily-usd ${desired.dailyBudgetUsd === null ? "none" : desired.dailyBudgetUsd}`,
    });
  } else {
    checks.push({
      status: "NO_CHANGE",
      kind: "budget",
      key: "production",
      message: "Production daily budget matches desired state",
    });
  }

  const currentDefaultLocation = text(remoteEnvironment.defaultResourceLocation);
  const currentPlacementMode = text(remoteEnvironment.placementMode) || "off";
  const placementMismatch =
    (desired.defaultResourceLocation && currentDefaultLocation !== desired.defaultResourceLocation) ||
    (desired.placementMode && currentPlacementMode !== desired.placementMode);
  if (placementMismatch) {
    const flags = [
      desired.defaultResourceLocation ? `--data-location ${desired.defaultResourceLocation}` : "",
      desired.placementMode ? `--placement ${desired.placementMode}` : "",
    ].filter(Boolean).join(" ");
    checks.push({
      status: "BLOCKED",
      kind: "placement",
      key: "production",
      message: "Production environment placement differs from desired state",
      command: `xapi workers environment ${workerId} production ${flags}`,
    });
  } else if (desired.defaultResourceLocation || desired.placementMode) {
    checks.push({
      status: "NO_CHANGE",
      kind: "placement",
      key: "production",
      message: "Production environment placement matches desired state",
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
    const statusReady = resourceReadyForDeployment(remoteWorkerResourceState(current));
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
      status: "NO_CHANGE",
      kind: "resource",
      key: bindingName,
      message:
        "Not referenced by this JSON: remove its Worker binding on deploy; preserve the resource and storage charges. Physical deletion requires resources destroy",
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
      ({ routing: 0, budget: 1, placement: 2, resource: 3, secret: 4, event: 5 })[a.kind] -
        { routing: 0, budget: 1, placement: 2, resource: 3, secret: 4, event: 5 }[b.kind] ||
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
    output: process.stderr,
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
  nativePlan: NativeDeploymentPlan;
  compatibility: WranglerConfigurationSettings;
  sourceCompatibility: WranglerConfigurationSettings;
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
  let compatibility = readWranglerDeploymentSettings(project, "production", text(artifact.mediaType), {localAssets:false});
  const sourceCompatibility = compatibility;
  // Promotion reuses the preview Artifact; it cannot supply native output from
  // a production build for configuration outside the existing desired state.
  if (compatibility.nativeBundleRequired?.length) {
    throw new WorkerPushError(
      'Cannot represent production Wrangler configuration when promoting the preview Artifact: ' +
        compatibility.nativeBundleRequired.join(', '),
      {
        errorCode: 'worker_production_configuration_unrepresentable',
        fields: compatibility.nativeBundleRequired,
        remoteChangesApplied: false,
        supportedNativeFields: ['placement', 'limits', 'logpush', 'observability',
          'cache_options', 'cache', 'keep_assets', 'keep_vars', 'tags', 'version_metadata', 'tail_consumers'],
        next: 'Use xapi workers pull --env production to compare the active snapshot; review the listed fields and supported native mappings before promotion',
      },
    );
  }
  const checkSecretBindings = (artifactBindings: string[] = []) => {
    const collision = conflictingWorkerSecretBinding(compatibility.requiredSecrets || [], [
      ...project.config.environments.production.resources.map(resource => resource.bindingName),
      ...(compatibility.assets?.binding ? [compatibility.assets.binding] : []),
      ...artifactBindings,
    ]);
    if (collision) throw new WorkerPushError(`Duplicate Worker binding: ${collision}`, { remoteChangesApplied: false });
  };
  checkSecretBindings();
  const [resources, secrets, currentVariables, declaration] = await Promise.all([
    api
      .listWorkerResources(options.clientOptions, workerId, "production")
      .then((value) => records(value, "production resources")),
    api
      .listWorkerSecrets(options.clientOptions, workerId, "production")
      .then((value) => records(value, "production Secret metadata")),
    api.getWorkerVariableState(options.clientOptions, workerId, "production")
      .then(value => readWorkerVariableState(value, "production", text(production.activeDeploymentId) || null)),
    api.getWorkerArtifactVariableConfiguration(options.clientOptions, workerId, artifactId)
      .then(value => readWorkerArtifactVariableConfiguration(value, artifactId, contentSha256)),
  ]);
  // This affirmative capability belongs to the queried server, after its
  // Artifact ID/SHA are verified. Old DTOs may silently drop unknown fields.
  const complete = declaration.nativeMetadataCompleteSupported === true;
  if (complete) compatibility = {...compatibility,
    nativeMetadata: {...(compatibility.nativeMetadata || {})}, nativeMetadataIsComplete: true};
  const metadata = compatibility.nativeMetadata;
  const resetsMetadata = metadata !== undefined && !Object.keys(metadata).length;
  let bindingNames = declaration.bindingNames;
  if (declaration.bindings !== undefined && metadata !== undefined) {
    // Assets remain part of the immutable Artifact; effective metadata replaces
    // only the version binding. Preserve type records even for a shared name.
    const changesVersion = complete || resetsMetadata || metadata.version_metadata !== undefined;
    const version = declaration.bindings.find(binding => binding.type === 'version_metadata');
    if (version && !changesVersion) throw new WorkerPushError(
      'Production native metadata cannot remove the selected Artifact version binding while applying other native settings', {
        errorCode: 'worker_production_configuration_unrepresentable', fields: ['version_metadata'],
        artifactId, remoteChangesApplied: false,
        next: 'Inspect xapi workers pull --env production; deploy the backend complete-native-metadata contract to preserve this production intent',
      });
    bindingNames = declaration.bindings.filter(binding => !changesVersion || binding.type === 'assets').map(binding => binding.name);
  } else if (bindingNames.length && metadata !== undefined) {
    const provider = previewDeployment.providerResult as UnknownRecord | undefined;
    const snapshot = provider?.deploymentSnapshot as UnknownRecord | undefined;
    const native = snapshot?.nativeMetadata as UnknownRecord | undefined;
    const version = native?.version_metadata as { binding?: unknown } | undefined;
    // A confirmed version binding cannot collide with immutable assets. If it
    // matches an Artifact name in this exact snapshot, its binding kind is known.
    let artifactVersion: string | undefined;
    const matchesSnapshot = snapshot?.version === 1 && snapshot.artifactId === artifactId &&
      snapshot.sourceSha256 === contentSha256;
    if (matchesSnapshot && typeof version?.binding === 'string' &&
        bindingNames.includes(version.binding)) artifactVersion = version.binding;
    const previewOverride = provider?.nativeMetadataOverrides;
    // Absence proves no Artifact version only if preview did not reset metadata.
    // The existing backend records explicit {} overrides in providerResult.
    const preservesVersion = provider?.nativeMetadataIsComplete !== true && (previewOverride === undefined || (previewOverride !== null &&
      typeof previewOverride === 'object' && !Array.isArray(previewOverride) && Object.keys(previewOverride).length > 0));
    const knownNoVersion = matchesSnapshot && native !== null && typeof native === 'object' &&
      !Array.isArray(native) && version === undefined && preservesVersion;
    if (!artifactVersion && !knownNoVersion) {
      const readArtifact = api.getWorkerArtifact;
      if (!readArtifact) throw new WorkerPushError('Cannot read immutable Artifact binding metadata', {
        remoteChangesApplied: false,
      });
      const details = record(await readArtifact.call(api, options.clientOptions, workerId, artifactId), 'Artifact');
      if (details.id !== artifactId || details.contentSha256 !== contentSha256 ||
          !Number.isInteger(details.assetCount) || Number(details.assetCount) < 0 ||
          (details.assetCount === 0 && bindingNames.length !== 1)) {
        throw new WorkerPushError('xAPI returned missing or mismatched Artifact asset metadata', {
          remoteChangesApplied: false,
        });
      }
      // The immutable query proves that a no-assets bundle has only its version
      // binding. Never infer historical binding kinds from local Wrangler files.
      if (details.assetCount === 0) artifactVersion = bindingNames[0];
    }
    const changesVersion = complete || resetsMetadata || metadata.version_metadata !== undefined;
    // The current immutable query returns only assets and version binding
    // names. Two distinct names prove a version exists even without its kind.
    if (!changesVersion && (artifactVersion || bindingNames.length === 2)) throw new WorkerPushError(
      'Production native metadata cannot remove the selected Artifact version binding while applying other native settings', {
        errorCode: 'worker_production_configuration_unrepresentable',
        fields: ['version_metadata'], artifactId, remoteChangesApplied: false,
        next: 'Inspect the selected Artifact and xapi workers pull --env production; the deployment API needs complete native metadata replacement to preserve this production intent',
      });
    if (!changesVersion && !knownNoVersion && !artifactVersion) throw new WorkerPushError(
      'Cannot classify Artifact bindings to verify complete production native metadata', {
        errorCode: 'worker_artifact_binding_metadata_unavailable',
        fields: ['version_metadata'], artifactId, remoteChangesApplied: false,
        next: 'Read the selected Artifact and its variable-configuration through the Workers API; binding types are needed to rule out retained preview version metadata',
      });
    if (changesVersion) {
      if (artifactVersion) bindingNames = bindingNames.filter(name => name !== artifactVersion);
      else if (!knownNoVersion) {
        // Without proof, an overlapping name might be immutable assets. Include
        // the desired version name as well as Secrets/vars in this ambiguity.
        const requestedNames = new Set([
          ...(compatibility.requiredSecrets || []), ...Object.keys(compatibility.variables?.vars || {}),
          ...currentVariables.map(variable => variable.name),
          ...((metadata.version_metadata as { binding?: string } | undefined)?.binding
            ? [(metadata.version_metadata as { binding: string }).binding] : []),
        ]);
        const ambiguous = bindingNames.filter(name => requestedNames.has(name));
        if (ambiguous.length) throw new WorkerPushError(
          'Cannot distinguish immutable assets from cleared or replaced version bindings: ' + ambiguous.join(', '), {
            errorCode: 'worker_artifact_binding_metadata_unavailable',
            artifactId, remoteChangesApplied: false,
            next: 'Read the selected Artifact and its variable-configuration through the Workers API; promotion needs binding types to verify this collision',
          });
      }
    }
  }
  if (metadata?.version_metadata !== undefined) {
    const versionBinding = (metadata.version_metadata as { binding: string }).binding;
    if (bindingNames.includes(versionBinding)) throw new WorkerPushError(`Duplicate Worker binding: ${versionBinding}`, {
      remoteChangesApplied: false,
    });
    bindingNames = [...bindingNames, versionBinding];
  }
  checkSecretBindings(bindingNames);
  const checked = productionChecks(
    workerId,
    {...project.config.environments.production, secrets: compatibility.requiredSecrets || []},
    production,
    resources,
    secrets,
    Boolean(compatibility.assets),
  );
  // Match backend order: a variables override clears Artifact public retention,
  // then nativeMetadata can reset or explicitly restore the retained types.
  let keepBindings = compatibility.variables === undefined ? declaration.keepBindings : [];
  if (resetsMetadata || complete) keepBindings = [];
  if (Array.isArray(metadata?.keep_bindings)) keepBindings = metadata.keep_bindings
    .filter((type): type is WorkerVariableType => type === 'plain_text' || type === 'json');
  const effectiveDeclaration = {
    ...declaration,
    bindingNames,
    keepBindings,
    variables: compatibility.variables === undefined ? declaration.variables
      : workerVariableDeclaration(compatibility.variables).variables,
  };
  const nativePlan = nativeDeploymentPlan(project, "production");
  for (const event of await planWorkerNativeEvents(project,"production",resources,api,options.clientOptions))
    checked.checks.push({status:event.operation,kind:"event",key:event.key,message:event.message});
  checked.dataRisk.push("D1 SQL is not executed by promotion. Apply database migrations explicitly when needed; Queue/Cron configuration runs after code. Code rollback does not roll back SQL.");
  const plan: WorkerPromotionPlan = {
    schemaVersion: 1,
    ...(metadata !== undefined ? {nativeMetadata: structuredClone(metadata)} : {}),
    variables: planWorkerVariables(effectiveDeclaration, currentVariables, [
      ...project.config.environments.production.resources.map(resource => resource.bindingName),
      ...(compatibility.requiredSecrets || []),
      ...secrets.map(secret => text(secret.bindingName)!),
    ], production.bindings).map(variable => compatibility.variables === undefined ? variable : {
      ...variable,
      message: variable.message.replace("the Artifact", "the production configuration"),
    }),
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
    production: {...checked, activeDeploymentId: text(production.activeDeploymentId) || null},
    nativeSteps: publicNativeDeploymentPlan(nativePlan),
    canPromote: !checked.checks.some(
      (item) =>
        item.status === "BLOCKED" ||
        (item.status === "MANUAL" && item.kind === "resource"),
    ),
  };
  return { plan, worker, artifact, nativePlan, compatibility, sourceCompatibility };
}

export async function promoteWorkerProject(
  options: PromoteWorkerProjectOptions,
): Promise<WorkerPromotionResult> {
  const api = options.client || (workersClient as PromotionClient);
  const project = loadWorkerProject(options.cwd, options.configPath);
  const prepared = await createWorkerPromotionPlan({ ...options, client: api });
  const compatibility = prepared.compatibility;
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
  if (JSON.stringify(loadWorkerProject(project.rootDir, project.configPath).config) !== JSON.stringify(project.config) ||
      JSON.stringify(readWranglerDeploymentSettings(project, "production", text(prepared.artifact.mediaType), {localAssets:false})) !== JSON.stringify(prepared.sourceCompatibility))
    throw new WorkerPushError("Production configuration changed after plan; rerun promote to review it before applying changes");
  const wait =
    options.sleep ||
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const nativeReceipts: unknown[] = [];
  let releasedDeploymentId: string | undefined;
  try {
    const currentWorker = record(await api.getWorker(options.clientOptions, prepared.plan.workerId), "Worker");
    if (prepared.plan.production.activeDeploymentId !== (text(environment(currentWorker, "production").activeDeploymentId) || null))
      throw new WorkerPushError("Production deployment changed after plan; rerun promote before replacing it");
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
      options.retentionPriceVersion,
      project.config.environments.production.resources.map(resource => resource.bindingName),
      prepared.plan.production.activeDeploymentId,
      false,
      workerEnvironmentContainers(project.config,"production"),
    );
    releasedDeploymentId = text(deployed.deployment.id);
    nativeReceipts.push(...await applyNativeDeploymentPhase(api, options.clientOptions, prepared.plan.workerId, "production", prepared.nativePlan, "AFTER_CODE"));
    const deploymentId = releasedDeploymentId;
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
      nativeReceipts,
      events: {queueConsumers:prepared.nativePlan.consumers.map(item=>item.bindingName),crons:prepared.nativePlan.crons},
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
        releasedDeploymentId,
        nativeReceipts: [...nativeReceipts, ...(error instanceof NativeDeploymentError ? error.completed : [])],
        ...(error instanceof NativeDeploymentError ? { failedPhase: error.phase } : {}),
        ...error.recovery,
      });
    }
    throw new WorkerPushError(
      error instanceof Error ? error.message : "Production promotion failed",
      {
        workerId: prepared.plan.workerId,
        artifactId: prepared.plan.artifact.id,
        productionResourcesPreserved: true,
        releasedDeploymentId,
        nativeReceipts: [...nativeReceipts, ...(error instanceof NativeDeploymentError ? error.completed : [])],
        ...(error instanceof NativeDeploymentError ? { failedPhase: error.phase } : {}),
      },
    );
  }
}
