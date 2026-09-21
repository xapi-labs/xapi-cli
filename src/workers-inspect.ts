import type { WorkersClientOptions } from "./workers-client.ts";
import * as workersClient from "./workers-client.ts";

type UnknownRecord = Record<string, unknown>;

export interface WorkerInspectClient {
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
  listWorkerDomains(options: WorkersClientOptions, id: string): Promise<unknown>;
  workerBillingQuery(
    options: WorkersClientOptions,
    id: string,
    environment: string,
    kind: "overview",
  ): Promise<unknown>;
}

export interface WorkerInspection {
  schemaVersion: 1;
  mode: "READ_ONLY";
  controlPlane: string;
  worker: UnknownRecord;
  environment: UnknownRecord;
  deployment?: UnknownRecord;
  artifact?: UnknownRecord;
  resources: { status: "AVAILABLE" | "UNKNOWN"; items: UnknownRecord[] };
  secrets: { status: "AVAILABLE" | "UNKNOWN"; items: UnknownRecord[] };
  domains: { status: "AVAILABLE" | "UNKNOWN"; items: UnknownRecord[] };
  billing: { status: "AVAILABLE" | "UNKNOWN"; summary?: UnknownRecord };
  diagnostics: Array<{
    status: "PASS" | "WARN" | "UNKNOWN";
    check: string;
    message: string;
  }>;
  nextSteps: string[];
}

function record(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function items(value: unknown): UnknownRecord[] {
  const source = Array.isArray(value)
    ? value
    : Array.isArray(record(value)?.items)
      ? (record(value)?.items as unknown[])
      : [];
  return source.map(record).filter((item): item is UnknownRecord => !!item);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function selectedFields(
  source: UnknownRecord | undefined,
  names: string[],
): UnknownRecord {
  const result: UnknownRecord = {};
  for (const name of names) {
    if (source?.[name] !== undefined) result[name] = source[name];
  }
  return result;
}

function settledItems(
  result: PromiseSettledResult<unknown>,
  fields: string[],
): { status: "AVAILABLE" | "UNKNOWN"; items: UnknownRecord[] } {
  if (result.status === "rejected") return { status: "UNKNOWN", items: [] };
  return {
    status: "AVAILABLE",
    items: items(result.value).map((item) => selectedFields(item, fields)),
  };
}

export async function inspectWorker(options: {
  workerId: string;
  environment: "preview" | "production";
  clientOptions: WorkersClientOptions;
  client?: WorkerInspectClient;
}): Promise<WorkerInspection> {
  const api = options.client || workersClient;
  const workerValue = await api.getWorker(options.clientOptions, options.workerId);
  const worker = record(workerValue);
  if (!worker || text(worker.id) !== options.workerId) {
    throw new Error("xAPI returned an invalid Worker inspection response");
  }

  const environment = items(worker.environments).find(
    (item) => text(item.name)?.toLowerCase() === options.environment,
  );
  if (!environment) {
    throw new Error(`Worker is missing its ${options.environment} environment`);
  }

  const [resourceResult, secretResult, domainResult, billingResult] =
    await Promise.allSettled([
      api.listWorkerResources(
        options.clientOptions,
        options.workerId,
        options.environment,
      ),
      api.listWorkerSecrets(
        options.clientOptions,
        options.workerId,
        options.environment,
      ),
      api.listWorkerDomains(options.clientOptions, options.workerId),
      api.workerBillingQuery(
        options.clientOptions,
        options.workerId,
        options.environment,
        "overview",
      ),
    ]);

  const resources = settledItems(resourceResult, [
    "id",
    "type",
    "bindingName",
    "status",
    "requestedLocation",
    "effectiveLocation",
    "readReplication",
  ]);
  const secrets = settledItems(secretResult, [
    "bindingName",
    "version",
    "status",
    "updatedAt",
  ]);
  const environmentId = text(environment.id);
  const domains = settledItems(domainResult, [
    "id",
    "environment",
    "environmentId",
    "hostname",
    "status",
    "url",
    "errorCode",
  ]);
  domains.items = domains.items.filter(
    (item) =>
      (text(item.environmentId)
        ? text(item.environmentId) === environmentId
        : !text(item.environment) ||
          text(item.environment)?.toLowerCase() === options.environment),
  );

  const activeDeploymentId = text(environment.activeDeploymentId);
  const deployments = items(worker.deployments);
  const deployment =
    deployments.find((item) => text(item.id) === activeDeploymentId) ||
    deployments.find(
      (item) =>
        text(item.environmentId) === environmentId &&
        text(item.status)?.toUpperCase() === "ACTIVE",
    );
  const artifact = items(worker.artifacts).find(
    (item) => text(item.id) === text(deployment?.artifactId),
  );
  const environmentStatus =
    text(environment.status) ||
    (text(deployment?.status)?.toUpperCase() === "ACTIVE" ? "ACTIVE" : undefined);

  const billingEnvelope =
    billingResult.status === "fulfilled" ? record(billingResult.value) : undefined;
  const billingData = record(billingEnvelope?.data);
  const billing = billingEnvelope
    ? {
        status: "AVAILABLE" as const,
        summary: {
          ...selectedFields(billingEnvelope, [
            "snapshotId",
            "snapshotTime",
            "completeThrough",
            "dataQuality",
          ]),
          ...selectedFields(billingData, [
            "lifecycleState",
            "dailyBudgetUsd",
            "budgetRemainingUsd",
            "settledUsd",
            "estimatedUsd",
            "exposureUsd",
            "providerOutage",
            "reasonCodes",
          ]),
        },
      }
    : { status: "UNKNOWN" as const };

  const diagnostics: WorkerInspection["diagnostics"] = [];
  diagnostics.push({
    status: environmentStatus?.toUpperCase() === "ACTIVE" ? "PASS" : "UNKNOWN",
    check: "environment",
    message: `Environment status is ${environmentStatus || "unknown"}`,
  });
  diagnostics.push({
    status: deployment ? "PASS" : "WARN",
    check: "deployment",
    message: deployment
      ? `Active deployment ${text(deployment.id) || "is present"}`
      : "No active deployment was found",
  });
  for (const [check, result] of [
    ["resources", resources],
    ["secrets", secrets],
    ["domains", domains],
    ["billing", billing],
  ] as const) {
    diagnostics.push({
      status: result.status === "AVAILABLE" ? "PASS" : "UNKNOWN",
      check,
      message:
        result.status === "AVAILABLE"
          ? `${check} metadata is available`
          : `${check} metadata could not be read`,
    });
  }
  const billingQuality = text(billing.summary?.dataQuality);
  if (billing.status === "AVAILABLE" && billingQuality !== "COMPLETE") {
    diagnostics.push({
      status: billingQuality ? "WARN" : "UNKNOWN",
      check: "billing_freshness",
      message: `Billing data quality is ${billingQuality || "unknown"}`,
    });
  }

  const environmentSummary = selectedFields(environment, [
    "id",
    "name",
    "status",
    "dailyBudgetUsd",
    "publicUrl",
    "dispatchUrl",
    "customDomainUrl",
    "routingMode",
    "webAppReady",
    "activeDeploymentId",
  ]);
  if (!environmentSummary.status && environmentStatus) {
    environmentSummary.status = environmentStatus;
  }

  return {
    schemaVersion: 1,
    mode: "READ_ONLY",
    controlPlane: options.clientOptions.apiHost,
    worker: selectedFields(worker, ["id", "name", "slug", "status"]),
    environment: environmentSummary,
    ...(deployment
      ? {
          deployment: selectedFields(deployment, [
            "id",
            "status",
            "artifactId",
            "createdAt",
            "activatedAt",
          ]),
        }
      : {}),
    ...(artifact
      ? {
          artifact: selectedFields(artifact, [
            "id",
            "contentSha256",
            "sizeBytes",
            "createdAt",
          ]),
        }
      : {}),
    resources,
    secrets,
    domains,
    billing,
    diagnostics,
    nextSteps: [
      `xapi workers plan --env ${options.environment}`,
      `xapi workers logs ${options.workerId} --env ${options.environment} --since 10m`,
      `xapi workers billing overview ${options.workerId} --env ${options.environment}`,
    ],
  };
}
