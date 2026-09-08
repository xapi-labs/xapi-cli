import { createHash } from "node:crypto";
import { isRetryableRequestError } from "./client.ts";
import type { WorkersClientOptions } from "./workers-client.ts";
import * as workersClient from "./workers-client.ts";
import { WorkerPushError } from "./workers-push.ts";

type UnknownRecord = Record<string, unknown>;

export interface WorkerLogsClient {
  getWorker(options: WorkersClientOptions, id: string): Promise<unknown>;
  workerRuntimeLogs(
    options: WorkersClientOptions,
    id: string,
    environment: string,
  ): Promise<unknown>;
}

export interface WorkerLogsOptions {
  workerId: string;
  environment: "preview" | "production";
  clientOptions: WorkersClientOptions;
  since?: string;
  level?: string;
  requestId?: string;
  deploymentId?: string;
  client?: WorkerLogsClient;
  now?: () => number;
}

export interface TailWorkerLogsOptions extends WorkerLogsOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  onBatch: (batch: WorkerLogsResult) => void;
  onTransientError?: () => void;
  maxPolls?: number;
}

export interface WorkerLogsResult {
  schemaVersion: 1;
  workerId: string;
  environment: "preview" | "production";
  items: UnknownRecord[];
  rows: number;
  sampled: boolean;
  filters: {
    since?: string;
    level?: string;
    requestId?: string;
    deploymentId?: string;
  };
  contentPolicy?: unknown;
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

function eventTime(item: UnknownRecord): number | undefined {
  const raw = Number(item.eventTimestamp);
  if (Number.isFinite(raw) && raw > 0) return raw < 1e12 ? raw * 1_000 : raw;
  const parsed = Date.parse(text(item.timestamp) || "");
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseLogSince(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const matched = value.match(/^(\d+)(s|m|h)$/);
  if (!matched || Number(matched[1]) <= 0) {
    throw new WorkerPushError(
      "--since must be a positive duration using s, m, or h (for example 30s, 10m, or 2h)",
    );
  }
  const unit = { s: 1_000, m: 60_000, h: 3_600_000 }[matched[2]]!;
  return Number(matched[1]) * unit;
}

function validateLevel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase();
  if (
    !["debug", "info", "log", "warn", "warning", "error"].includes(normalized)
  ) {
    throw new WorkerPushError(
      "--level must be debug, info, log, warn, warning, or error",
    );
  }
  return normalized === "warning" ? "warn" : normalized;
}

function deploymentTimeline(
  worker: UnknownRecord,
  environmentName: "preview" | "production",
  requestedDeploymentId?: string,
): Array<{ id: string; deployedAt: number }> {
  const environment = records(worker.environments, "Worker environments").find(
    (item) => text(item.name)?.toLowerCase() === environmentName,
  );
  const environmentId = text(environment?.id);
  if (!environmentId) {
    throw new WorkerPushError(
      `Worker is missing its ${environmentName} environment`,
    );
  }
  const candidates = records(worker.deployments || [], "Worker deployments")
    .filter((item) => item.environmentId === environmentId)
    .map((item) => ({
      id: text(item.id),
      deployedAt: Date.parse(
        text(item.deployedAt) || text(item.createdAt) || "",
      ),
    }))
    .filter(
      (item): item is { id: string; deployedAt: number } =>
        !!item.id && Number.isFinite(item.deployedAt),
    )
    .sort((a, b) => a.deployedAt - b.deployedAt);
  if (
    requestedDeploymentId &&
    !candidates.some((item) => item.id === requestedDeploymentId)
  ) {
    throw new WorkerPushError(
      "--deployment is not a visible deployment in the selected Worker environment",
    );
  }
  return candidates;
}

function correlateDeployment(
  item: UnknownRecord,
  timeline: Array<{ id: string; deployedAt: number }>,
): string | undefined {
  const timestamp = eventTime(item);
  if (timestamp === undefined) return undefined;
  let matched: string | undefined;
  for (const deployment of timeline) {
    if (deployment.deployedAt > timestamp) break;
    matched = deployment.id;
  }
  return matched;
}

function filters(options: WorkerLogsOptions) {
  const sinceMs = parseLogSince(options.since);
  const level = validateLevel(options.level);
  if (options.requestId !== undefined && !options.requestId) {
    throw new WorkerPushError("--request-id must not be empty");
  }
  if (options.deploymentId !== undefined && !options.deploymentId) {
    throw new WorkerPushError("--deployment must not be empty");
  }
  return { sinceMs, level };
}

export async function readWorkerLogs(
  options: WorkerLogsOptions,
): Promise<WorkerLogsResult> {
  const checked = filters(options);
  const api = options.client || (workersClient as WorkerLogsClient);
  const [rawLogs, rawWorker] = await Promise.all([
    api.workerRuntimeLogs(
      options.clientOptions,
      options.workerId,
      options.environment,
    ),
    api.getWorker(options.clientOptions, options.workerId),
  ]);
  const envelope = record(rawLogs, "Worker logs");
  const worker = record(rawWorker, "Worker");
  const timeline = deploymentTimeline(
    worker,
    options.environment,
    options.deploymentId,
  );
  const cutoff = checked.sinceMs
    ? (options.now || Date.now)() - checked.sinceMs
    : undefined;
  const items = records(envelope.items, "Worker log items")
    .map((item) => {
      const deploymentId = correlateDeployment(item, timeline);
      return deploymentId ? { ...item, deploymentId } : item;
    })
    .filter((item) => {
      const timestamp = eventTime(item);
      return (
        (cutoff === undefined ||
          (timestamp !== undefined && timestamp >= cutoff)) &&
        (!checked.level || text(item.level)?.toLowerCase() === checked.level) &&
        (!options.requestId || item.requestId === options.requestId) &&
        (!options.deploymentId || item.deploymentId === options.deploymentId)
      );
    });
  return {
    schemaVersion: 1,
    workerId: options.workerId,
    environment: options.environment,
    items,
    rows: items.length,
    sampled: envelope.sampled === true,
    filters: {
      ...(options.since ? { since: options.since } : {}),
      ...(checked.level ? { level: checked.level } : {}),
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.deploymentId ? { deploymentId: options.deploymentId } : {}),
    },
    ...(envelope.contentPolicy !== undefined
      ? { contentPolicy: envelope.contentPolicy }
      : {}),
  };
}

function logIdentity(item: UnknownRecord): string {
  return createHash("sha256").update(JSON.stringify(item)).digest("hex");
}

async function waitForNextPoll(
  milliseconds: number,
  signal: AbortSignal | undefined,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  if (!signal) return sleep(milliseconds);
  if (signal.aborted) return;
  let stop: (() => void) | undefined;
  try {
    await Promise.race([
      sleep(milliseconds),
      new Promise<void>((resolve) => {
        stop = () => resolve();
        signal.addEventListener("abort", stop, { once: true });
      }),
    ]);
  } finally {
    if (stop) signal.removeEventListener("abort", stop);
  }
}

export async function tailWorkerLogs(
  options: TailWorkerLogsOptions,
): Promise<{ polls: number; emitted: number; stopped: boolean }> {
  filters(options);
  const seen = new Set<string>();
  let polls = 0;
  let emitted = 0;
  while (!options.signal?.aborted) {
    polls += 1;
    try {
      const result = await readWorkerLogs(options);
      const fresh = [...result.items].reverse().filter((item) => {
        const identity = logIdentity(item);
        if (seen.has(identity)) return false;
        seen.add(identity);
        if (seen.size > 20_000) {
          const oldest = seen.values().next().value as string | undefined;
          if (oldest) seen.delete(oldest);
        }
        return true;
      });
      if (fresh.length) {
        emitted += fresh.length;
        options.onBatch({ ...result, items: fresh, rows: fresh.length });
      }
    } catch (error) {
      if (error instanceof WorkerPushError || !isRetryableRequestError(error)) {
        throw error;
      }
      options.onTransientError?.();
    }
    if (options.maxPolls !== undefined && polls >= options.maxPolls) break;
    if (options.signal?.aborted) break;
    await waitForNextPoll(
      options.pollIntervalMs ?? 2_000,
      options.signal,
      options.sleep ||
        ((milliseconds) =>
          new Promise<void>((resolve) => setTimeout(resolve, milliseconds))),
    );
  }
  return { polls, emitted, stopped: !!options.signal?.aborted };
}
