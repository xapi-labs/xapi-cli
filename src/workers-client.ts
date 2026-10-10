import { request, uploadRequest, RequestTimeoutError } from "./client.ts";
import { MAX_WORKER_JSON_BYTES, workerArtifactNeedsMultipart, workerArtifactMultipart, type WorkerArtifactUploadRequest } from "./workers-artifact.ts";
import { HttpError } from "./client.ts";
import type { WorkerArtifactBundle } from "./workers-artifact.ts";
import { normalizeWorkerVariableOptions } from "./workers-artifact.ts";
import { scheme } from "./config.ts";
import { withWorkerTargetWait, type WorkerOperationWaitOptions } from './workers-operation-wait.ts';
import { uploadDirectWorkerArtifact } from './workers-direct-upload.ts';

export interface WorkersClientOptions {
  apiHost: string;
  apiKey: string;
  operationWait?: WorkerOperationWaitOptions;
  artifactUploadTimeoutMs?: number;
  artifactUploadProgress?: (message:string)=>void;
}

export async function workerRetention(options: WorkersClientOptions, id: string, environment: string, path = "", body?: Record<string, unknown>) {
  // These actions synchronously control several upstream resources. A lost
  // response does not cancel the action and must never trigger a write replay.
  const lifecycleAction = path === "/actions" && Boolean(body);
  try {
    return await request<Record<string, any>>(url(options, `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/retention${path}`), {
      method: body ? "POST" : "GET",
      headers: headers(options, Boolean(body)),
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, lifecycleAction ? 120_000 : 30_000, body ? 0 : 2);
  } catch (error) {
    if (lifecycleAction && error instanceof RequestTimeoutError) {
      throw new Error(`Worker retention action result is UNKNOWN: ${error.message}. The server may still complete it; no write was retried. Check with: xapi workers retention show ${id} --env ${environment} --format json`, { cause: error });
    }
    throw error;
  }
}

export type WorkerBillingQueryKind =
  | "prices"
  | "overview"
  | "usage"
  | "ledger"
  | "forecast"
  | "risk"
  | "lifecycle";

export interface WorkerBillingQuery {
  snapshotTime?: string;
  from?: string;
  to?: string;
  metric?: string;
  resourceId?: string;
  cursor?: string;
  limit?: string;
}

function url(options: WorkersClientOptions, path = ""): string {
  return `${scheme(options.apiHost)}://${options.apiHost}/api/v1/workers${path}`;
}

function headers(options: WorkersClientOptions, json = false): HeadersInit {
  return {
    "XAPI-KEY": options.apiKey,
    Accept: "application/json",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function coordinatedWrite(
  options: WorkersClientOptions, id: string, target: string, init: RequestInit,
) {
  // Capture the body/key once: waiting never regenerates deployment identity.
  return withWorkerTargetWait(
    () => request<unknown>(target, { ...init, signal: options.operationWait?.signal }, 60_000, 0),
    (operationId, timeoutMs) => request<unknown>(
      url(options, `/${encodeURIComponent(id)}/control-operations/${encodeURIComponent(operationId)}`),
      { headers: headers(options), signal: options.operationWait?.signal }, timeoutMs, 0,
    ),
    options.operationWait,
  );
}

export function listWorkers(options: WorkersClientOptions) {
  return request<unknown>(
    url(options),
    { headers: headers(options) },
    30_000,
    2,
  );
}

export function getWorker(options: WorkersClientOptions, id: string) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}`),
    {
      headers: headers(options),
    },
    30_000,
    2,
  );
}

export function createWorker(
  options: WorkersClientOptions,
  input: Record<string, unknown>,
) {
  return request<unknown>(url(options), {
    method: "POST",
    headers: headers(options, true),
    body: JSON.stringify(input),
  });
}

export function getWorkerVariableState(options: WorkersClientOptions, id: string, environment: string) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/variables`),
    { headers: headers(options) }, 30_000, 2,
  );
}

export function getWorkerArtifactVariableConfiguration(options: WorkersClientOptions, id: string, artifactId: string) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}/variable-configuration`),
    { headers: headers(options) }, 30_000, 2,
  );
}

export function deployWorker(
  options: WorkersClientOptions,
  id: string,
  input: Record<string, unknown>,
) {
  return coordinatedWrite(options, id,
    url(options, `/${encodeURIComponent(id)}/deployments`),
    {
      method: "POST",
      headers: headers(options, true),
      body: JSON.stringify(input),
    },
  );
}

export function rollbackWorker(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  input: Record<string, unknown>,
) {
  return coordinatedWrite(options, id,
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/rollback`,
    ),
    {
      method: "POST",
      headers: headers(options, true),
      body: JSON.stringify(input),
    },
  );
}

export function workerArtifactUploadStatus(options:WorkersClientOptions,id:string,uploadId:string) {
  return request<unknown>(url(options,`/${encodeURIComponent(id)}/artifact-uploads/${encodeURIComponent(uploadId)}/status`),
    {headers:headers(options)},30_000,2);
}

export function listWorkerArtifacts(options: WorkersClientOptions, id: string) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/artifacts`),
    {
      headers: headers(options),
    },
    30_000,
    2,
  );
}

export async function uploadWorkerArtifact(
  options: WorkersClientOptions,
  id: string,
  input: WorkerArtifactUploadRequest,
) {
  const provider=await workerArtifactProviderStatus(options) as {directUpload?:boolean};
  if(provider?.directUpload===true)
    return uploadDirectWorkerArtifact(input,url(options,`/${encodeURIComponent(id)}/artifact-uploads`),
      headers(options,true),options.artifactUploadTimeoutMs,options.operationWait?.signal,options.artifactUploadProgress);
  const multipart = workerArtifactNeedsMultipart(input);
  return uploadRequest<unknown>(
    url(options, `/${encodeURIComponent(id)}/artifacts${multipart ? "/bundle" : ""}`),
    {
      method: "POST",
      headers: headers(options, !multipart),
      body: multipart ? workerArtifactMultipart(input) : JSON.stringify(input),
      signal: options.operationWait?.signal,
    },
  );
}

export function updateWorkerEnvironment(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  input: {
    dailyBudgetUsd?: number | null;
    defaultResourceLocation?: "wnam" | "enam" | "weur" | "eeur" | "apac" | "oc";
    placementMode?: "off" | "smart";
  },
) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}`),
    { method: "PATCH", headers: headers(options, true), body: JSON.stringify(input) },
  );
}

export function listWorkerBuilds(options: WorkersClientOptions, id: string) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/builds`),
    {
      headers: headers(options),
    },
    30_000,
    2,
  );
}

export function createWorkerBuild(
  options: WorkersClientOptions,
  id: string,
  input: Record<string, unknown>,
) {
  const seconds = input.buildTimeoutSeconds ?? 600;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(seconds * 1000 + 360_000)) throw new Error('Invalid build timeout');
  const body = JSON.stringify(input);
  if (Buffer.byteLength(body, "utf8") > MAX_WORKER_JSON_BYTES) throw new Error("Worker build JSON exceeds the backend 18 MiB transport budget; build locally and upload the resulting artifact through multipart");
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/builds`),
    {
      method: "POST",
      headers: headers(options, true),
      body,
    },
    seconds * 1000 + 360_000,
    0,
    'idle',
  );
}

export function workerBuildProviderStatus(options: WorkersClientOptions) {
  return request<unknown>(
    url(options, "/build-provider/status"),
    {
      headers: headers(options),
    },
    30_000,
    2,
  );
}

export function workerArtifactProviderStatus(options: WorkersClientOptions) {
  return request<unknown>(
    url(options, "/artifact-provider/status"),
    {
      headers: headers(options),
    },
    30_000,
    2,
  );
}

export function updateWorkerBudget(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  dailyBudgetUsd: number | null,
) {
  return updateWorkerEnvironment(options, id, environment, { dailyBudgetUsd });
}

export async function deleteWorker(options: WorkersClientOptions, id: string) {
  try {
    return await request<unknown>(url(options, `/${encodeURIComponent(id)}`), {
      method: "DELETE",
      headers: headers(options),
    }, 120_000, 0);
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      throw new Error(`Worker deletion result is UNKNOWN: ${error.message}. The server may still complete it; no write was retried. Check with: xapi workers get ${id} --format json`, { cause: error });
    }
    throw error;
  }
}

export function workerAuditLogs(options: WorkersClientOptions, id: string) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/audit-logs`),
    {
      headers: headers(options),
    },
    30_000,
    2,
  );
}

export function workerInvocationLogs(
  options: WorkersClientOptions,
  id: string,
  environment: string,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/invocations`,
    ),
    { headers: headers(options) },
    30_000,
    2,
  );
}

export function workerRuntimeLogs(
  options: WorkersClientOptions,
  id: string,
  environment: string,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/runtime-logs`,
    ),
    { headers: headers(options) },
    30_000,
    2,
  );
}

export function workerUsage(
  options: WorkersClientOptions,
  id: string,
  environment?: string,
) {
  const suffix = environment
    ? `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/usage`
    : `/${encodeURIComponent(id)}/usage`;
  return request<unknown>(
    url(options, suffix),
    { headers: headers(options) },
    30_000,
    2,
  );
}

export function workerBillingStatus(options: WorkersClientOptions) {
  return request<unknown>(
    url(options, "/billing/status"),
    { headers: headers(options) },
    30_000,
    2,
  );
}

export function workerMeteredUsage(options: WorkersClientOptions, id: string, environment: string) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/metered-usage`),
    { headers: headers(options) }, 30_000, 2,
  );
}

export function workerBillingQuery(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  kind: WorkerBillingQueryKind,
  query: WorkerBillingQuery = {},
) {
  const target = new URL(
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/billing/${kind}`,
    ),
  );
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) target.searchParams.set(key, value);
  }
  return request<unknown>(
    target.toString(),
    { headers: headers(options) },
    30_000,
    2,
  );
}

export function listWorkerDomains(options: WorkersClientOptions, id: string) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/domains`),
    { headers: headers(options) },
    30_000,
    2,
  );
}

export interface WorkerDomainChallenge {
  challengeToken: string;
  expiresAt: string;
  hostname: string;
  environment: string;
  dns: { type: "TXT"; name: string; value: string; ttl: number };
}

export function createWorkerDomainChallenge(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  hostname: string,
) {
  return request<WorkerDomainChallenge>(
    url(options, `/${encodeURIComponent(id)}/domains/challenges`),
    {
      method: "POST",
      headers: headers(options, true),
      body: JSON.stringify({ environment, hostname }),
    },
    30_000,
  );
}

export function attachWorkerDomain(
  options: WorkersClientOptions,
  id: string,
  challengeToken: string,
) {
  return request<Record<string, unknown>>(
    url(options, `/${encodeURIComponent(id)}/domains`),
    {
      method: "POST",
      headers: headers(options, true),
      body: JSON.stringify({ challengeToken }),
    },
    60_000,
  );
}

export function deleteWorkerDomain(
  options: WorkersClientOptions,
  id: string,
  domainId: string,
) {
  return request<{ id: string; deleted: boolean }>(
    url(
      options,
      `/${encodeURIComponent(id)}/domains/${encodeURIComponent(domainId)}`,
    ),
    { method: "DELETE", headers: headers(options) },
    60_000,
  );
}

export function retryWorkerDomain(
  options: WorkersClientOptions,
  id: string,
  domainId: string,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/domains/${encodeURIComponent(domainId)}/retry`,
    ),
    { method: "POST", headers: headers(options) },
    60_000,
  );
}

export function listWorkerSchedules(options: WorkersClientOptions, id: string) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/schedules`),
    {
      headers: headers(options),
    },
  );
}

export function createWorkerSchedule(
  options: WorkersClientOptions,
  id: string,
  input: Record<string, unknown>,
) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/schedules`),
    {
      method: "POST",
      headers: headers(options, true),
      body: JSON.stringify(input),
    },
  );
}

export function updateWorkerSchedule(
  options: WorkersClientOptions,
  id: string,
  scheduleId: string,
  input: Record<string, unknown>,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/schedules/${encodeURIComponent(scheduleId)}`,
    ),
    {
      method: "PATCH",
      headers: headers(options, true),
      body: JSON.stringify(input),
    },
  );
}

export function workerScheduleRuns(
  options: WorkersClientOptions,
  id: string,
  scheduleId: string,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/schedules/${encodeURIComponent(scheduleId)}/runs`,
    ),
    { headers: headers(options) },
  );
}

export function runWorkerScheduleNow(
  options: WorkersClientOptions,
  id: string,
  scheduleId: string,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/schedules/${encodeURIComponent(scheduleId)}/run`,
    ),
    { method: "POST", headers: headers(options) },
    180_000,
  );
}

export function deleteWorkerSchedule(
  options: WorkersClientOptions,
  id: string,
  scheduleId: string,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/schedules/${encodeURIComponent(scheduleId)}`,
    ),
    { method: "DELETE", headers: headers(options) },
  );
}

export function workerBindingCatalog(options: WorkersClientOptions) {
  return request<unknown>(
    url(options, "/bindings/catalog"),
    {
      headers: headers(options),
    },
    30_000,
    2,
  );
}

export function workerProviderStatus(options: WorkersClientOptions) {
  return request<unknown>(
    url(options, "/provider/status"),
    {
      headers: headers(options),
    },
    30_000,
    2,
  );
}

export function workerProviderCapabilities(options: WorkersClientOptions) {
  return request<unknown>(
    url(options, "/provider/capabilities"),
    {
      headers: headers(options),
    },
    30_000,
    2,
  );
}

export function listWorkerResources(
  options: WorkersClientOptions,
  id: string,
  environment: string,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/resources`,
    ),
    { headers: headers(options) },
    30_000,
    2,
  );
}

export function createWorkerResource(
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
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/resources`,
    ),
    {
      method: "POST",
      headers: headers(options, true),
      body: JSON.stringify(input),
    },
    60_000,
  );
}

export function deleteWorkerResource(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  resourceId: string,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/resources/${encodeURIComponent(resourceId)}`,
    ),
    { method: "DELETE", headers: headers(options) },
    60_000,
  );
}

export function listWorkerSecrets(
  options: WorkersClientOptions,
  id: string,
  environment: string,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/secrets`,
    ),
    { headers: headers(options) },
    30_000,
    2,
  );
}

export function putWorkerSecret(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  bindingName: string,
  value: string,
) {
  return coordinatedWrite(options, id,
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/secrets/${encodeURIComponent(bindingName)}`,
    ),
    {
      method: "PUT",
      headers: headers(options, true),
      body: JSON.stringify({ value }),
    },
  );
}

export function applyWorkerSecrets(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  secrets: Array<{ name: string; value?: string; delete?: boolean }>,
) {
  return coordinatedWrite(options, id,
    url(options,`/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/secrets`),
    {
      method: "PATCH",
      headers: headers(options,true),
      body: JSON.stringify({secrets}),
    },
  );
}

export function workerSecretProviderStatus(
  options: WorkersClientOptions,
  id: string,
  environment: string,
) {
  return request<unknown>(
    url(options,`/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/secrets/provider-status`),
    {headers:headers(options)},
    30_000,
    2,
  );
}

export function deleteWorkerSecret(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  bindingName: string,
) {
  return coordinatedWrite(options, id,
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/secrets/${encodeURIComponent(bindingName)}`,
    ),
    { method: "DELETE", headers: headers(options) },
  );
}

export function applyWorkerD1Migration(options: WorkersClientOptions, id: string, environment: string,
  resourceId: string, input: Record<string, unknown>) {
  return request<unknown>(url(options, `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/resources/${encodeURIComponent(resourceId)}/d1/migrations`), {
    method: 'POST', headers: headers(options, true), body: JSON.stringify(input),
  });
}

export function configureWorkerQueueConsumer(options: WorkersClientOptions, id: string, environment: string, resourceId: string, input: Record<string,unknown>) {
  return request<unknown>(url(options,`/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/resources/${encodeURIComponent(resourceId)}/queue-consumer`),{
    method:"PUT",headers:headers(options,true),body:JSON.stringify(input),
  },60_000);
}
export function disableWorkerQueueConsumer(options: WorkersClientOptions, id: string, environment: string, resourceId: string) {
  return request<unknown>(url(options,`/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/resources/${encodeURIComponent(resourceId)}/queue-consumer`),{
    method:"DELETE",headers:headers(options),
  },60_000);
}

/** Pull changes message visibility and ack/retry changes leases; neither retries. */
export function workerQueueMessages(options:WorkersClientOptions,id:string,environment:string,resourceId:string,
  action:'pull'|'ack',input:Record<string,unknown>) {
  return request<unknown>(url(options,`/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/resources/${encodeURIComponent(resourceId)}/queue/messages/${action}`),{
    method:'POST',headers:headers(options,true),body:JSON.stringify(input),
  },60_000);
}

export function workerControlOperations(options: WorkersClientOptions, id: string,query:{cursor?:string;limit?:string}={}) {
  const search=new URLSearchParams();if(query.cursor)search.set('cursor',query.cursor);if(query.limit)search.set('limit',query.limit);
  return request<unknown>(url(options, `/${encodeURIComponent(id)}/control-operations`)+(search.size?'?'+search:''), { headers: headers(options) });
}
export function recoverWorkerControlOperation(options: WorkersClientOptions, id: string, operationId: string) {
  return request<unknown>(url(options, `/${encodeURIComponent(id)}/control-operations/${encodeURIComponent(operationId)}/recover`), { method: "POST", headers: headers(options) }, 60_000);
}

export function workerDeploymentConfiguration(options:WorkersClientOptions,id:string,environment:string) {
  return request<unknown>(url(options,`/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/deployment-configuration`),
    {headers:headers(options)},30_000,2);
}
