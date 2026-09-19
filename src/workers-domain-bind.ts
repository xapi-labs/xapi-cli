import { randomUUID } from "node:crypto";
import { actionCall, actionGet } from "./client.ts";
import { HttpError } from "./client.ts";
import type { ClientOptions } from "./client.ts";
import * as workers from "./workers-client.ts";

type Json = Record<string, unknown>;

function dataOf(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!current || typeof current !== "object" || Array.isArray(current)) break;
    const row = current as Json;
    if (row.error && typeof row.error === "object") {
      const error = row.error as Json;
      throw new Error(String(error.message || error.code || "xAPI action failed"));
    }
    if (!("data" in row)) break;
    current = row.data;
  }
  return current;
}

function domainName(value: unknown): string {
  const data = dataOf(value);
  if (!data || typeof data !== "object") throw new Error("domain.get returned no domain");
  const name = (data as Json).domainName;
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("domain.get did not return domainName");
  }
  return name.toLowerCase().replace(/\.$/, "");
}

function desiredHostname(apex: string, subdomain: string): string {
  const relative = subdomain.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
  if (!relative || relative === "@") return apex;
  if (!/^(?!.*\.\.)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.?)+$/.test(relative)) {
    throw new Error("--subdomain must be @ or a valid relative DNS name");
  }
  const hostname = `${relative}.${apex}`;
  if (hostname.length > 253) throw new Error("resulting hostname is too long");
  return hostname;
}

function challengeSubdomain(hostname: string, apex: string): string {
  if (hostname === apex) return "_xapi-worker-challenge";
  if (!hostname.endsWith(`.${apex}`)) throw new Error("hostname is outside the owned domain");
  return `_xapi-worker-challenge.${hostname.slice(0, -(apex.length + 1))}`;
}

function rowsOf(value: unknown): Json[] {
  const data = dataOf(value);
  if (Array.isArray(data)) return data.filter((item): item is Json => Boolean(item) && typeof item === "object");
  if (!data || typeof data !== "object") return [];
  const row = data as Json;
  for (const key of ["records", "items", "domains"]) {
    if (Array.isArray(row[key])) return (row[key] as unknown[]).filter((item): item is Json => Boolean(item) && typeof item === "object");
  }
  return [];
}

async function schema(actionId: string, options: ClientOptions) {
  const definition = await actionGet(actionId, options);
  if (!Array.isArray(definition) || definition.length === 0) {
    throw new Error(`xAPI action schema is unavailable: ${actionId}`);
  }
}

async function locateRecord(
  options: ClientOptions,
  domainId: string,
  subdomain: string,
  expectedValue: string,
  mutation: unknown,
) {
  let rows = rowsOf(mutation);
  if (!rows.length) {
    await schema("dns.list", options);
    rows = rowsOf(await actionCall("dns.list", { domain_id: domainId }, options));
  }
  return rows.find(
    (row) =>
      row.type === "TXT" &&
      row.subdomain === subdomain &&
      row.value === expectedValue &&
      typeof row.record_id === "string",
  );
}

function pending(error: unknown) {
  return error instanceof HttpError && error.status === 400 && error.message.includes("worker_domain_dns_challenge_pending");
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function bindXdomainWorker(input: {
  workerOptions: workers.WorkersClientOptions;
  actionOptions: ClientOptions;
  workerId: string;
  environment: "preview" | "production";
  domainId: string;
  subdomain: string;
  waitMs?: number;
}) {
  await schema("domain.get", input.actionOptions);
  const apex = domainName(
    await actionCall(
      "domain.get",
      { domain_id: input.domainId },
      input.actionOptions,
      undefined,
      2,
    ),
  );
  const hostname = desiredHostname(apex, input.subdomain);
  const challenge = await workers.createWorkerDomainChallenge(
    input.workerOptions,
    input.workerId,
    input.environment,
    hostname,
  );
  const relativeRecord = challengeSubdomain(hostname, apex);
  const dnsIdempotency = `worker-domain-${randomUUID()}`;
  await schema("dns.upsert", input.actionOptions);
  const mutation = await actionCall(
    "dns.upsert",
    {
      domain_id: input.domainId,
      idempotency_key: dnsIdempotency,
      subdomain: relativeRecord,
      type: "TXT",
      value: challenge.dns.value,
      ttl: 60,
      proxied: false,
      comment: "Temporary xAPI Worker domain ownership challenge",
    },
    input.actionOptions,
  );

  let cleanup: { deleted: boolean; recordId?: string; error?: string } = {
    deleted: false,
  };
  let attached: Record<string, unknown> | undefined;
  let attachError: unknown;
  try {
    const deadline = Date.now() + (input.waitMs ?? 120_000);
    while (!attached) {
      try {
        attached = await workers.attachWorkerDomain(
          input.workerOptions,
          input.workerId,
          challenge.challengeToken,
        );
      } catch (error) {
        if (!pending(error) || Date.now() >= deadline) throw error;
        await sleep(2_000);
      }
    }
  } catch (error) {
    attachError = error;
  } finally {
    // The ownership TXT is a short-lived proof, not the serving record. Clean
    // it even when attach times out or is rejected, without hiding that error.
    try {
      const record = await locateRecord(
        input.actionOptions,
        input.domainId,
        relativeRecord,
        challenge.dns.value,
        mutation,
      );
      if (record && typeof record.record_id === "string") {
        await schema("dns.delete", input.actionOptions);
        await actionCall(
          "dns.delete",
          {
            domain_id: input.domainId,
            record_id: record.record_id,
            idempotency_key: `worker-domain-cleanup-${randomUUID()}`,
            ...(typeof record.modified_on === "string"
              ? { record_modified_on: record.modified_on }
              : {}),
          },
          input.actionOptions,
        );
        cleanup = { deleted: true, recordId: record.record_id };
      } else {
        cleanup = {
          deleted: false,
          error: "challenge TXT record was not returned by dns.list",
        };
      }
    } catch (error) {
      cleanup = {
        deleted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (attachError) throw attachError;

  return {
    hostname,
    url: `https://${hostname}`,
    environment: input.environment,
    domain: attached,
    challengeCleanup: cleanup,
  };
}
