import { request } from "./client.ts";
import type { WorkerArtifactUploadRequest } from "./workers-artifact.ts";
import { scheme } from "./config.ts";

export interface WorkersClientOptions {
  apiHost: string;
  apiKey: string;
}

export function workerRetention(options: WorkersClientOptions, id: string, environment: string, path = "", body?: Record<string, unknown>) {
  return request<Record<string, any>>(url(options, `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/retention${path}`), {
    method: body ? "POST" : "GET",
    headers: headers(options, Boolean(body)),
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, 30_000, body ? 0 : 2);
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

export function deployWorker(
  options: WorkersClientOptions,
  id: string,
  input: Record<string, unknown>,
) {
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/deployments`),
    {
      method: "POST",
      headers: headers(options, true),
      body: JSON.stringify(input),
    },
    60_000,
  );
}

export function rollbackWorker(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  input: Record<string, unknown>,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/rollback`,
    ),
    {
      method: "POST",
      headers: headers(options, true),
      body: JSON.stringify(input),
    },
    60_000,
  );
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

export function uploadWorkerArtifact(
  options: WorkersClientOptions,
  id: string,
  input: WorkerArtifactUploadRequest,
) {
  if ("bundle" in input) {
    const form = new FormData();
    const files: Blob[] = [];
    const file = (content: string, encoding: "utf8" | "base64", type: string) => {
      const bytes = Buffer.from(content, encoding === "base64" ? "base64" : "utf8");
      const index = files.length;
      files.push(new Blob([bytes], { type }));
      return index;
    };
    const manifest = {
      version: 2,
      idempotencyKey: input.idempotencyKey,
      mainModule: input.bundle.mainModule,
      modules: input.bundle.modules.map((module) => ({
        path: module.path,
        contentType: module.contentType,
        fileIndex: file(module.content, module.encoding, module.contentType),
      })),
      ...(input.bundle.observability ? { observability: input.bundle.observability } : {}),
      ...(input.bundle.assets ? { assets: {
        files: input.bundle.assets.files.map((asset) => ({
          path: asset.path,
          contentType: asset.contentType,
          fileIndex: file(asset.content, "base64", asset.contentType),
        })),
        ...(input.bundle.assets.binding ? { binding: input.bundle.assets.binding } : {}),
        ...(input.bundle.assets.config ? { config: input.bundle.assets.config } : {}),
      } } : {}),
    };
    form.append("manifest", JSON.stringify(manifest));
    files.forEach((blob, index) => form.append("files", blob, `artifact-${index}`));
    return request<unknown>(
      url(options, `/${encodeURIComponent(id)}/artifacts/bundle`),
      { method: "POST", headers: headers(options), body: form },
      180_000,
    );
  }
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/artifacts`),
    {
      method: "POST",
      headers: headers(options, true),
      body: JSON.stringify(input),
    },
    60_000,
  );
}

export function updateWorkerEnvironment(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  input: {
    dailyBudgetUsd?: number;
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
  return request<unknown>(
    url(options, `/${encodeURIComponent(id)}/builds`),
    {
      method: "POST",
      headers: headers(options, true),
      body: JSON.stringify(input),
    },
    960_000,
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
  dailyBudgetUsd: number,
) {
  return updateWorkerEnvironment(options, id, environment, { dailyBudgetUsd });
}

export function deleteWorker(options: WorkersClientOptions, id: string) {
  return request<unknown>(url(options, `/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: headers(options),
  });
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
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/secrets/${encodeURIComponent(bindingName)}`,
    ),
    {
      method: "PUT",
      headers: headers(options, true),
      body: JSON.stringify({ value }),
    },
    60_000,
  );
}

export function deleteWorkerSecret(
  options: WorkersClientOptions,
  id: string,
  environment: string,
  bindingName: string,
) {
  return request<unknown>(
    url(
      options,
      `/${encodeURIComponent(id)}/environments/${encodeURIComponent(environment)}/secrets/${encodeURIComponent(bindingName)}`,
    ),
    { method: "DELETE", headers: headers(options) },
    60_000,
  );
}
