import { request, uploadRequest, RequestTimeoutError } from "./client.ts";
import { MAX_WORKER_JSON_BYTES, workerArtifactNeedsMultipart, workerArtifactMultipart, type WorkerArtifactUploadRequest } from "./workers-artifact.ts";
import { HttpError } from "./client.ts";
import type { WorkerArtifactBundle } from "./workers-artifact.ts";
import { normalizeWorkerVariableOptions } from "./workers-artifact.ts";
import { scheme } from "./config.ts";
import { withWorkerTargetWait, type WorkerOperationWaitOptions } from './workers-operation-wait.ts';
import { uploadDirectWorkerArtifact } from './workers-direct-upload.ts';
import { collectWorkerBillingUsage } from './workers-billing-usage.ts';

export interface WorkersClientOptions {
  apiHost: string;
  apiKey: string;
  operationWait?: WorkerOperationWaitOptions;
  artifactUploadTimeoutMs?: number;
  artifactUploadProgress?: (message:string)=>void;
}

/** A write may have reached the server before the transport lost its response. */
export class WorkerWriteUnknownError extends Error {
  constructor(subject: string, recovery: string, cause: Error, public readonly code?: string) {
    super(`${subject} result is UNKNOWN: ${cause.message}${code ? ` (${code})` : ''}. The server may still complete it; no write was retried. Check with: ${recovery}`, { cause });
    this.name = 'WorkerWriteUnknownError';
  }
}

function unknownWriteError(error: unknown, subject: string, recovery: string): WorkerWriteUnknownError | undefined {
  if (!(error instanceof Error) || error instanceof HttpError || error.name === 'AbortError') return;
  const seen = new Set<Error>();
  let code: string | undefined;
  let knownTransport = false;
  for (let current: unknown = error; current instanceof Error && !seen.has(current); current = current.cause) {
    seen.add(current);
    const candidate = (current as Error & { code?: unknown }).code;
    if (typeof candidate === 'string' && /^(UND_ERR_(INVALID_ARG|INVALID_RETURN_VALUE|NOT_SUPPORTED)|ERR_INVALID_ARG_(TYPE|VALUE)|ERR_INVALID_URL|ERR_MISSING_ARGS|ERR_OUT_OF_RANGE)$/.test(candidate)) return;
    if (typeof candidate === 'string' && /^(UND_ERR_(SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH)$/.test(candidate)) {
      code = candidate;
      knownTransport = true;
    }
    // A new transport code does not prove that the write was never sent.
    // Preserve it and still inspect the fetch failure, including deeper causes.
    if (typeof candidate === 'string' && !code) code = candidate;
  }
  // Do not turn validation/programming errors or definite HTTP rejections into
  // ambiguous results. The original error chain is retained for diagnostics.
  if (error instanceof RequestTimeoutError || knownTransport ||
      (error instanceof TypeError && /^(fetch failed|terminated|network error)$/i.test(error.message))) {
    return new WorkerWriteUnknownError(subject, recovery, error, code);
  }
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
    if (lifecycleAction) {
      const unknown = unknownWriteError(error, 'Worker retention action',
        `xapi workers retention show ${id} --env ${environment} --format json`);
      if (unknown) throw unknown;
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

export function getWorkerArtifact(options: WorkersClientOptions, id: string, artifactId: string) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(artifactId)}`),
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
    const unknown = unknownWriteError(error, 'Worker deletion', `xapi workers get ${id} --format json`);
    if (unknown) throw unknown;
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
  const fetchPage = (pageQuery: WorkerBillingQuery) => {
    const target = new URL(
      url(options, `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/billing/${kind}`),
    );
    for (const [key, value] of Object.entries(pageQuery)) {
      if (value !== undefined) target.searchParams.set(key, value);
    }
    return request<unknown>(target.toString(),
      {headers:headers(options),signal:options.operationWait?.signal}, 30_000, 2);
  };
  return kind === 'usage' ? collectWorkerBillingUsage(fetchPage, query, options.operationWait?.signal,
    {workerId:id,environment:environment.toLowerCase()}) : fetchPage(query);
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

/** Data export POSTs are deliberately never replayed, including descriptor requests. */
export function workerDataExportRequest(options: WorkersClientOptions, id: string, environment: string,
  resourceId: string, path: string, body?: Record<string, unknown>, timeoutMs = 30_000) {
  return request<unknown>(url(options, `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/resources/${encodeURIComponent(resourceId)}${path}`), {
    method: body === undefined ? 'GET' : 'POST', headers: headers(options, body !== undefined),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }, timeoutMs, 0);
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
