import type { WorkerProjectConfig } from "./workers-project.ts";

export type WorkerDesiredResource =
  WorkerProjectConfig["environments"]["preview"]["resources"][number];

type UnknownRecord = Record<string, unknown>;

const REMOTE_RESOURCE_TYPES: Record<string, WorkerDesiredResource["type"]> = {
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

export interface RemoteWorkerResourceState {
  bindingName?: string;
  type?: WorkerDesiredResource["type"];
  rawType?: string;
  status: string;
  className?: string;
  nativeWorkflowPrepared?: boolean;
  requestedLocation?: WorkerDesiredResource["location"];
  effectiveLocation?: WorkerDesiredResource["location"];
  readReplication?: WorkerDesiredResource["readReplication"];
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function location(value: unknown): WorkerDesiredResource["location"] {
  const parsed = text(value)?.toLowerCase();
  return parsed && ["wnam", "enam", "weur", "eeur", "apac", "oc"].includes(parsed)
    ? (parsed as WorkerDesiredResource["location"])
    : undefined;
}

function replication(
  value: unknown,
): WorkerDesiredResource["readReplication"] {
  const parsed = text(value)?.toLowerCase();
  return parsed === "auto" || parsed === "disabled" ? parsed : undefined;
}

export function remoteWorkerResourceState(
  value: UnknownRecord,
): RemoteWorkerResourceState {
  const config = record(value.config) || {};
  const rawType = text(value.type);
  const rawReplication = config.readReplication ?? config.read_replication;
  return {
    bindingName: text(value.bindingName),
    type: rawType ? REMOTE_RESOURCE_TYPES[rawType] : undefined,
    rawType,
    status: text(value.status) || "UNKNOWN",
    className: text(record(config.nativeWorkflow)?.className ?? config.className ?? config.class_name ?? value.className),
    nativeWorkflowPrepared: rawType?.toLowerCase() === "workflow" && record(config.nativeWorkflow)?.prepared === true,
    requestedLocation: location(
      config.requestedLocation ?? config.requested_location,
    ),
    effectiveLocation: location(
      config.created_in_region ??
        config.running_in_region ??
        config.effectiveLocation ??
        config.location,
    ),
    readReplication: replication(
      rawReplication && typeof rawReplication === "object"
        ? record(rawReplication)?.mode
        : rawReplication,
    ),
  };
}

export function desiredResourceFromRemote(
  state: RemoteWorkerResourceState,
): WorkerDesiredResource | undefined {
  if (!state.bindingName || !state.type) return undefined;
  if (state.type === "durable_object" && !state.className) return undefined;
  return {
    type: state.type,
    bindingName: state.bindingName,
    ...(state.className ? { className: state.className } : {}),
    ...(state.requestedLocation
      ? { location: state.requestedLocation }
      : {}),
    ...(state.readReplication
      ? { readReplication: state.readReplication }
      : {}),
  } as WorkerDesiredResource;
}

export function resourceReadyForDeployment(state: RemoteWorkerResourceState): boolean {
  return state.status === "ACTIVE" || (state.status === "PROVISIONING" &&
    (state.type === "durable_object" || (state.type === "workflow" && Boolean(state.className) && state.nativeWorkflowPrepared === true)));
}
