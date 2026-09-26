import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mergeResourceChanges, resourceSyncState, sameResource } from "./workers-resource-sync.ts";
import {
  loadWorkerProject,
  type WorkerProjectConfig,
  WorkerProjectConfigError,
  workerManagedResourceSchema,
  workerProjectConfigSchema,
} from "./workers-project.ts";
import type { WorkersClientOptions } from "./workers-client.ts";
import * as workersClient from "./workers-client.ts";
import {
  desiredResourceFromRemote,
  remoteWorkerResourceState,
  resourceReadyForDeployment,
  type WorkerDesiredResource,
} from "./workers-resource-state.ts";

type EnvironmentName = "preview" | "production";
type Resource = WorkerProjectConfig["environments"]["preview"]["resources"][number];
type UnknownRecord = Record<string, unknown>;

export interface PullResourceClient {
  listWorkerResources(
    options: WorkersClientOptions,
    workerId: string,
    environment: string,
  ): Promise<unknown>;
}

export interface DestroyResourceClient extends PullResourceClient {
  deleteWorkerResource(
    options: WorkersClientOptions,
    workerId: string,
    environment: string,
    resourceId: string,
  ): Promise<unknown>;
}

export interface PullProjectResourcesOptions {
  cwd?: string;
  configPath?: string;
  environments: EnvironmentName[];
  clientOptions: WorkersClientOptions;
  client?: PullResourceClient;
}

export interface PullProjectResourcesResult {
  changed: boolean;
  configPath: string;
  workerId: string;
  environments: Array<{
    name: EnvironmentName;
    added: string[];
    updated: string[];
    unchanged: string[];
    removed: string[];
  }>;
  nextSteps: string[];
}

export interface EditProjectResourceOptions {
  cwd?: string;
  configPath?: string;
  environments: EnvironmentName[];
  resource?: Resource;
  bindingName?: string;
}

export interface EditProjectResourceResult {
  changed: boolean;
  configPath: string;
  environments: EnvironmentName[];
  bindingName: string;
  nextSteps: string[];
}

export interface DestroyProjectResourceOptions {
  cwd?: string;
  configPath?: string;
  environment: EnvironmentName;
  bindingName: string;
  clientOptions: WorkersClientOptions;
  client?: DestroyResourceClient;
}

export interface DestroyProjectResourceResult {
  changed: boolean;
  configPath: string;
  workerId: string;
  environment: EnvironmentName;
  bindingName: string;
  resourceId?: string;
  localDeclarationRemoved: boolean;
  remoteDeletionRequested: boolean;
  remote?: unknown;
  nextSteps: string[];
}

function writeConfig(path: string, config: WorkerProjectConfig): void {
  const parsed = workerProjectConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_edit_invalid",
      `Resource edit produced an invalid project: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`,
    );
  }
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(parsed.data, null, 2)}\n`, {
    encoding: "utf8",
    mode: statSync(path).mode & 0o777,
    flag: "wx",
  });
  renameSync(temporary, path);
}

function steps(environments: EnvironmentName[]): string[] {
  const result: string[] = [];
  if (environments.includes("preview")) {
    result.push("xapi workers plan --env preview");
    result.push("xapi workers push --env preview");
  }
  if (environments.includes("production")) {
    result.push("xapi workers plan --env production");
    result.push("xapi workers promote --to production");
  }
  return result;
}

function bindingName(value: string | undefined): string {
  if (!value || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value)) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_binding_invalid",
      "Binding name must start with A-Z or a-z and contain only letters, 0-9, and underscore",
    );
  }
  return value;
}

function records(value: unknown): UnknownRecord[] {
  const raw = Array.isArray(value)
    ? value
    : value &&
        typeof value === "object" &&
        Array.isArray((value as UnknownRecord).items)
      ? ((value as UnknownRecord).items as unknown[])
      : undefined;
  if (!raw || raw.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_pull_invalid_response",
      "xAPI returned an invalid managed resource list",
    );
  }
  return raw as UnknownRecord[];
}

function sameOrConflict(
  local: Resource,
  remote: WorkerDesiredResource,
  state: ReturnType<typeof remoteWorkerResourceState>,
  environment: EnvironmentName,
): Resource {
  const comparableLocation = state.requestedLocation || state.effectiveLocation;
  const conflicts =
    local.type !== remote.type ||
    (["durable_object", "workflow"].includes(local.type) && local.className !== remote.className) ||
    (local.location && local.location !== comparableLocation) ||
    (local.readReplication &&
      local.readReplication !== state.readReplication);
  if (conflicts) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_pull_conflict",
      `${environment} binding ${local.bindingName} differs between xapi.worker.json and the live resource; resolve it with plan before pulling`,
    );
  }
  return {
    ...local,
    ...(remote.className && !local.className
      ? { className: remote.className }
      : {}),
    ...(remote.location && !local.location ? { location: remote.location } : {}),
    ...(remote.readReplication && !local.readReplication
      ? { readReplication: remote.readReplication }
      : {}),
  };
}

export async function pullProjectResources(
  options: PullProjectResourcesOptions,
): Promise<PullProjectResourcesResult> {
  const project = loadWorkerProject(options.cwd, options.configPath);
  const workerId = project.config.workerId;
  if (!workerId) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_pull_unlinked",
      "This project has no workerId. Run `xapi workers push --env preview` once before pulling remote resources",
    );
  }
  const api = options.client || workersClient;
  const originalConfig = readFileSync(project.configPath, "utf8");
  const sync = resourceSyncState(project.configPath, options.clientOptions.apiHost, workerId);
  const liveByEnvironment = await Promise.all(
    options.environments.map(async (environment) => ({
      environment,
      resources: records(
        await api.listWorkerResources(
          options.clientOptions,
          workerId,
          environment,
        ),
      ),
    })),
  );
  const config = structuredClone(project.config);
  const result: PullProjectResourcesResult["environments"] = [];
  let changed = false;

  // Pull updates declarations only, never the provider. A previous observation
  // and local snapshot preserve deliberate local removals and pending changes.
  for (const { environment, resources } of liveByEnvironment) {
    const seen = new Set<string>();
    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const removed: string[] = [];
    const desired = config.environments[environment].resources;
    const observed: Resource[] = [];
    const baseline = sync.state.environments[environment];
    for (const raw of [...resources].sort((left, right) => {
      const leftName = remoteWorkerResourceState(left).bindingName || "";
      const rightName = remoteWorkerResourceState(right).bindingName || "";
      return leftName.localeCompare(rightName);
    })) {
      const state = remoteWorkerResourceState(raw);
      const remote = desiredResourceFromRemote(state);
      if (!state.bindingName) {
        throw new WorkerProjectConfigError(
          "worker_project_resource_pull_invalid_response",
          `xAPI returned a ${environment} resource without bindingName`,
        );
      }
      if (seen.has(state.bindingName)) {
        throw new WorkerProjectConfigError(
          "worker_project_resource_pull_duplicate",
          `xAPI returned duplicate ${environment} binding ${state.bindingName}`,
        );
      }
      seen.add(state.bindingName);
      const ready =
        resourceReadyForDeployment(state);
      if (!ready) {
        throw new WorkerProjectConfigError(
          "worker_project_resource_pull_not_ready",
          `${environment} binding ${state.bindingName} is ${state.status}; repair or wait for it before pulling`,
        );
      }
      if (!remote) {
        throw new WorkerProjectConfigError(
          "worker_project_resource_pull_unsupported",
          `${environment} binding ${state.bindingName} has unsupported type ${state.rawType || "UNKNOWN"} or incomplete Durable Object metadata`,
        );
      }
      observed.push(remote);
      if (baseline) continue;
      const index = desired.findIndex(
        (item) => item.bindingName === remote.bindingName,
      );
      if (index < 0) {
        desired.push(remote);
        added.push(remote.bindingName);
        changed = true;
        continue;
      }
      const merged = sameOrConflict(
        desired[index],
        remote,
        state,
        environment,
      );
      if (JSON.stringify(merged) !== JSON.stringify(desired[index])) {
        desired[index] = merged;
        updated.push(remote.bindingName);
        changed = true;
      } else {
        unchanged.push(remote.bindingName);
      }
    }
    if (baseline) {
      const merged = mergeResourceChanges(desired, observed, baseline, environment);
      for (const item of merged) {
        const prior = desired.find(row => row.bindingName === item.bindingName);
        if (!prior) added.push(item.bindingName);
        else if (!sameResource(prior, item)) updated.push(item.bindingName);
        else unchanged.push(item.bindingName);
      }
      for (const item of desired) if (!merged.some(row => row.bindingName === item.bindingName)) removed.push(item.bindingName);
      config.environments[environment].resources = merged;
      changed ||= !!(added.length || updated.length || removed.length);
    }
    sync.state.environments[environment] = { local: structuredClone(config.environments[environment].resources), remote: observed };
    result.push({ name: environment, added, updated, unchanged, removed });
  }

  if (readFileSync(project.configPath, "utf8") !== originalConfig)
    throw new WorkerProjectConfigError("worker_project_config_changed", "Project JSON changed during pull; no changes were written. Run pull again");
  sync.assertUnchanged();
  if (changed) writeConfig(project.configPath, config);
  sync.save();
  return {
    changed,
    configPath: project.configPath,
    workerId,
    environments: result,
    nextSteps: steps(options.environments),
  };
}

export function addProjectResource(
  options: EditProjectResourceOptions,
): EditProjectResourceResult {
  const project = loadWorkerProject(options.cwd, options.configPath);
  const parsedResource = workerManagedResourceSchema.safeParse(options.resource);
  if (!parsedResource.success) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_invalid",
      parsedResource.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
    );
  }
  const config = structuredClone(project.config);
  let changed = false;
  for (const environment of options.environments) {
    const resources = config.environments[environment].resources;
    const existing = resources.find(
      (item) => item.bindingName === parsedResource.data.bindingName,
    );
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(parsedResource.data)) {
        throw new WorkerProjectConfigError(
          "worker_project_resource_binding_conflict",
          `${environment} already declares ${existing.type} at binding ${existing.bindingName}`,
        );
      }
      continue;
    }
    resources.push(parsedResource.data);
    changed = true;
  }
  if (changed) writeConfig(project.configPath, config);
  return {
    changed,
    configPath: project.configPath,
    environments: options.environments,
    bindingName: parsedResource.data.bindingName,
    nextSteps: steps(options.environments),
  };
}

export function updateProjectResource(
  options: EditProjectResourceOptions,
): EditProjectResourceResult {
  const project = loadWorkerProject(options.cwd, options.configPath);
  const parsedResource = workerManagedResourceSchema.safeParse(options.resource);
  if (!parsedResource.success) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_invalid",
      parsedResource.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; "),
    );
  }
  const config = structuredClone(project.config);
  let changed = false;
  for (const environment of options.environments) {
    const resources = config.environments[environment].resources;
    const index = resources.findIndex(
      (item) => item.bindingName === parsedResource.data.bindingName,
    );
    if (index < 0) {
      throw new WorkerProjectConfigError(
        "worker_project_resource_not_declared",
        `${environment} does not declare binding ${parsedResource.data.bindingName}; use resources add first`,
      );
    }
    const existing = resources[index];
    if (
      project.config.workerId &&
      existing.type !== parsedResource.data.type
    ) {
      throw new WorkerProjectConfigError(
        "worker_project_resource_type_change",
        `${environment} binding ${existing.bindingName} is ${existing.type}; changing a resource type in place is unsafe, so create a new binding and migrate data`,
      );
    }
    if (
      project.config.workerId &&
      ["durable_object", "workflow"].includes(existing.type) &&
      existing.className !== parsedResource.data.className
    ) {
      throw new WorkerProjectConfigError(
        "worker_project_resource_class_change",
        `${environment} ${existing.type} ${existing.bindingName} uses class ${existing.className}; create a new binding and migrate state instead of changing the class in place`,
      );
    }
    if (JSON.stringify(existing) !== JSON.stringify(parsedResource.data)) {
      resources[index] = parsedResource.data;
      changed = true;
    }
  }
  if (changed) writeConfig(project.configPath, config);
  return {
    changed,
    configPath: project.configPath,
    environments: options.environments,
    bindingName: parsedResource.data.bindingName,
    nextSteps: steps(options.environments),
  };
}

export function removeProjectResource(
  options: EditProjectResourceOptions,
): EditProjectResourceResult {
  const project = loadWorkerProject(options.cwd, options.configPath);
  const selectedBinding = bindingName(options.bindingName);
  const config = structuredClone(project.config);
  let changed = false;
  for (const environment of options.environments) {
    const resources = config.environments[environment].resources;
    const remaining = resources.filter(
      (item) => item.bindingName !== selectedBinding,
    );
    if (remaining.length !== resources.length) {
      config.environments[environment].resources = remaining;
      changed = true;
    }
  }
  if (!changed) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_not_declared",
      `No selected environment declares binding ${selectedBinding}`,
    );
  }
  writeConfig(project.configPath, config);
  return {
    changed,
    configPath: project.configPath,
    environments: options.environments,
    bindingName: selectedBinding,
    nextSteps: project.config.workerId
      ? [
          ...steps(options.environments),
          "Deployment removes the binding; the remote resource and its storage charges remain until explicit destruction",
          ...options.environments.flatMap((environment) => [
            `Delete its data after backup: xapi workers resources destroy --env ${environment} --binding ${selectedBinding} --yes`,
          ]),
        ]
      : steps(options.environments),
  };
}

export async function destroyProjectResource(
  options: DestroyProjectResourceOptions,
): Promise<DestroyProjectResourceResult> {
  const project = loadWorkerProject(options.cwd, options.configPath);
  const selectedBinding = bindingName(options.bindingName);
  const workerId = project.config.workerId;
  if (!workerId) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_destroy_unlinked",
      "This project has no workerId. Use `resources remove` for an undeployed local declaration",
    );
  }
  const api = options.client || workersClient;
  const remote = records(
    await api.listWorkerResources(
      options.clientOptions,
      workerId,
      options.environment,
    ),
  ).filter(
    (item) => remoteWorkerResourceState(item).bindingName === selectedBinding,
  );
  if (remote.length > 1) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_destroy_duplicate",
      `xAPI returned duplicate ${options.environment} binding ${selectedBinding}; no deletion was attempted`,
    );
  }
  const config = structuredClone(project.config);
  const resources = config.environments[options.environment].resources;
  const remaining = resources.filter(
    (item) => item.bindingName !== selectedBinding,
  );
  const localDeclarationRemoved = remaining.length !== resources.length;
  if (!localDeclarationRemoved && !remote.length) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_not_found",
      `Binding ${selectedBinding} does not exist in ${options.environment} desired or live state`,
    );
  }
  if (localDeclarationRemoved) {
    config.environments[options.environment].resources = remaining;
    writeConfig(project.configPath, config);
  }
  if (!remote.length) {
    return {
      changed: localDeclarationRemoved,
      configPath: project.configPath,
      workerId,
      environment: options.environment,
      bindingName: selectedBinding,
      localDeclarationRemoved,
      remoteDeletionRequested: false,
      nextSteps: steps([options.environment]),
    };
  }
  const resourceId =
    typeof remote[0].id === "string" && remote[0].id ? remote[0].id : undefined;
  if (!resourceId) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_destroy_invalid_response",
      `Live binding ${selectedBinding} has no resource ID. The local declaration was removed; run resources pull to restore it before retrying`,
    );
  }
  let deletion: unknown;
  try {
    deletion = await api.deleteWorkerResource(
      options.clientOptions,
      workerId,
      options.environment,
      resourceId,
    );
  } catch (error) {
    throw new WorkerProjectConfigError(
      "worker_project_resource_destroy_failed",
      `Deletion request failed for ${selectedBinding}. The local declaration was removed so it cannot be recreated accidentally; run \`xapi workers resources pull --env ${options.environment}\` to restore desired state before retrying. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    changed: true,
    configPath: project.configPath,
    workerId,
    environment: options.environment,
    bindingName: selectedBinding,
    resourceId,
    localDeclarationRemoved,
    remoteDeletionRequested: true,
    remote: deletion,
    nextSteps: [
      `Wait until binding ${selectedBinding} is absent from \`xapi workers resources list ${workerId} --env ${options.environment}\``,
      ...steps([options.environment]),
    ],
  };
}
