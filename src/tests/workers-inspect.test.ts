import { describe, expect, test } from "bun:test";
import {
  type WorkerInspectClient,
  inspectWorker,
} from "../workers-inspect.ts";
import { formatWorkerInspection } from "../workers-inspect-output.ts";

const clientOptions = { apiHost: "api.xapi.to", apiKey: "hidden-key" };

function client(
  overrides: Partial<WorkerInspectClient> = {},
): WorkerInspectClient {
  return {
    getWorker: async () => ({
      id: "worker-1",
      name: "Jev Autopilot",
      slug: "jev-autopilot",
      status: "ACTIVE",
      environments: [
        {
          id: "environment-preview",
          name: "PREVIEW",
          status: "ACTIVE",
          publicUrl: "https://jev-preview.xapi.men",
          routingMode: "CUSTOM_DOMAIN",
          webAppReady: true,
          activeDeploymentId: "deployment-1",
        },
      ],
      deployments: [
        {
          id: "deployment-1",
          environmentId: "environment-preview",
          artifactId: "artifact-1",
          status: "ACTIVE",
        },
      ],
      artifacts: [
        { id: "artifact-1", contentSha256: "abc", sizeBytes: 42 },
      ],
    }),
    listWorkerResources: async () => [
      { id: "resource-1", type: "R2_BUCKET", bindingName: "FILES", status: "ACTIVE" },
    ],
    listWorkerSecrets: async () => [
      { bindingName: "XAPI_KEY", version: 2, secretValue: "must-not-leak" },
    ],
    listWorkerDomains: async () => [
      { id: "domain-1", environmentId: "environment-preview", hostname: "jev-preview.xapi.men", status: "ACTIVE" },
      { id: "domain-2", environmentId: "environment-production", hostname: "jev.xapi.men", status: "ACTIVE" },
    ],
    workerBillingQuery: async () => ({
      snapshotId: "snapshot-1",
      snapshotTime: "2026-09-21T01:00:00.000Z",
      completeThrough: "2026-09-21T00:55:00.000Z",
      dataQuality: "COMPLETE",
      data: { lifecycleState: "ACTIVE", budgetRemainingUsd: "9.50" },
    }),
    ...overrides,
  };
}

describe("workers inspect", () => {
  test("aggregates a read-only environment report without secret values", async () => {
    const report = await inspectWorker({
      workerId: "worker-1",
      environment: "preview",
      clientOptions,
      client: client(),
    });

    expect(report.mode).toBe("READ_ONLY");
    expect(report.environment.publicUrl).toBe("https://jev-preview.xapi.men");
    expect(report.deployment?.id).toBe("deployment-1");
    expect(report.artifact?.id).toBe("artifact-1");
    expect(report.resources.items).toHaveLength(1);
    expect(report.secrets.items).toEqual([
      { bindingName: "XAPI_KEY", version: 2 },
    ]);
    expect(report.domains.items).toHaveLength(1);
    expect(report.billing.summary?.dataQuality).toBe("COMPLETE");
    expect(JSON.stringify(report)).not.toContain("must-not-leak");
    expect(JSON.stringify(report)).not.toContain("hidden-key");
    expect(formatWorkerInspection(report)).toContain("READ ONLY");
  });

  test("keeps optional read failures unknown instead of claiming zero", async () => {
    const unavailable = async () => {
      throw new Error("provider response that should not be surfaced");
    };
    const report = await inspectWorker({
      workerId: "worker-1",
      environment: "preview",
      clientOptions,
      client: client({
        listWorkerResources: unavailable,
        listWorkerSecrets: unavailable,
        listWorkerDomains: unavailable,
        workerBillingQuery: unavailable,
      }),
    });

    expect(report.resources).toEqual({ status: "UNKNOWN", items: [] });
    expect(report.secrets).toEqual({ status: "UNKNOWN", items: [] });
    expect(report.domains).toEqual({ status: "UNKNOWN", items: [] });
    expect(report.billing).toEqual({ status: "UNKNOWN" });
    expect(report.diagnostics.filter((item) => item.status === "UNKNOWN")).toHaveLength(4);
    expect(JSON.stringify(report)).not.toContain("provider response");
  });
});
