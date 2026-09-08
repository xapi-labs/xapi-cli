import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestTimeoutError } from "../client.ts";
import {
  type PromotionClient,
  createWorkerPromotionPlan,
  promoteWorkerProject,
} from "../workers-promote.ts";
import { WorkerPushError } from "../workers-push.ts";
import { WORKER_PROJECT_SCHEMA_URL } from "../workers-project.ts";

const roots: string[] = [];
const workerId = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xapi-promote-")));
  roots.push(root);
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({
      name: "promote-agent",
      main: "src/index.ts",
      compatibility_date: "2026-08-26",
      env: {
        production: {
          compatibility_date: "2026-08-25",
          compatibility_flags: ["nodejs_compat"],
        },
      },
    }),
  );
  writeFileSync(
    join(root, "xapi.worker.json"),
    JSON.stringify(
      {
        $schema: WORKER_PROJECT_SCHEMA_URL,
        version: 1,
        workerId,
        worker: {
          name: "Promote Agent",
          slug: "promote-agent",
          template: "agent",
        },
        wrangler: "wrangler.jsonc",
        build: { command: "never-run", output: "dist/worker.mjs" },
        environments: {
          preview: {
            dailyBudgetUsd: 0.25,
            healthCheck: "/health",
            resources: [],
            secrets: [],
          },
          production: {
            dailyBudgetUsd: 2,
            healthCheck: "/health",
            resources: [{ type: "kv_namespace", bindingName: "STATE" }],
            secrets: ["MODEL_KEY"],
          },
        },
      },
      null,
      2,
    ),
  );
  return root;
}

function fakePlatform(
  options: {
    budget?: number;
    resources?: Array<Record<string, unknown>>;
    secrets?: string[];
    failDeployOnce?: boolean;
  } = {},
) {
  const previewDeployments: Array<Record<string, unknown>> = [
    {
      id: "preview-latest",
      artifactId: "artifact-latest",
      environmentId: "env-preview",
      status: "ACTIVE",
      deployedAt: "2026-08-26T10:00:00.000Z",
    },
    {
      id: "preview-older",
      artifactId: "artifact-older",
      environmentId: "env-preview",
      status: "ACTIVE",
      deployedAt: "2026-08-25T10:00:00.000Z",
    },
  ];
  const productionDeployments: Array<Record<string, unknown>> = [];
  const artifacts = [
    {
      id: "artifact-latest",
      contentSha256: "a".repeat(64),
      sizeBytes: 123,
    },
    {
      id: "artifact-older",
      contentSha256: "b".repeat(64),
      sizeBytes: 100,
    },
  ];
  let productionReads = 0;
  let failDeploy = !!options.failDeployOnce;
  const calls = { deploy: 0, health: 0 };
  const snapshot = () => {
    if (productionDeployments.length) {
      productionReads += 1;
      if (productionReads >= 2) productionDeployments[0].status = "ACTIVE";
    }
    return {
      id: workerId,
      slug: "promote-agent",
      environments: [
        {
          id: "env-preview",
          name: "PREVIEW",
          dailyBudgetUsd: 0.25,
          publicUrl: "https://agent.example.test/w/ref/preview",
        },
        {
          id: "env-production",
          name: "PRODUCTION",
          activeDeploymentId: productionDeployments.find(item => item.status === "ACTIVE")?.id,
          dailyBudgetUsd: options.budget ?? 2,
          publicUrl: "https://agent.example.test/w/ref/production",
        },
      ],
      artifacts,
      deployments: [...previewDeployments, ...productionDeployments],
    };
  };
  const client: PromotionClient = {
    getWorker: async () => snapshot(),
    listWorkerResources: async () =>
      options.resources || [
        { bindingName: "STATE", type: "KV_NAMESPACE", status: "ACTIVE" },
      ],
    listWorkerSecrets: async () =>
      (options.secrets ?? ["MODEL_KEY"]).map((bindingName) => ({
        bindingName,
        version: 1,
      })),
    deployWorker: async (_api, _id, input) => {
      calls.deploy += 1;
      const deployment = {
        id: "production-deployment",
        artifactId: input.artifactId,
        environmentId: "env-production",
        idempotencyKey: input.idempotencyKey,
        status: "DEPLOYING",
      };
      productionDeployments.push(deployment);
      if (failDeploy) {
        failDeploy = false;
        throw new RequestTimeoutError(60_000);
      }
      return deployment;
    },
  };
  return { client, calls, productionDeployments };
}

describe("workers promote", () => {
  test("promotes the exact latest ACTIVE preview Artifact, waits, health-checks, and repeats safely", async () => {
    const root = fixture();
    const platform = fakePlatform({ failDeployOnce: true });
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetchPublic = (async (input, init) => {
      platform.calls.health += 1;
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const plans: unknown[] = [];
    const first = await promoteWorkerProject({
      cwd: root,
      to: "production",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      confirm: async () => true,
      onPlan: (plan) => plans.push(plan),
      fetchPublic,
      sleep: async () => undefined,
    });
    expect(first.status).toBe("ACTIVE");
    expect(first.artifact).toEqual({
      id: "artifact-latest",
      contentSha256: "a".repeat(64),
      sizeBytes: 123,
    });
    expect(first.deployment.status).toBe("ACTIVE");
    expect(platform.productionDeployments[0].artifactId).toBe(
      "artifact-latest",
    );
    expect(first.health.url).toBe(
      "https://agent.example.test/w/ref/production/health",
    );
    expect(requests[0].headers.has("XAPI-KEY")).toBe(false);
    expect(requests[0].headers.has("Authorization")).toBe(false);
    expect(platform.calls.deploy).toBe(1);
    expect(plans).toHaveLength(1);

    const second = await promoteWorkerProject({
      cwd: root,
      to: "production",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      nonInteractive: true,
      fetchPublic,
      sleep: async () => undefined,
    });
    expect(second.deployment.id).toBe("production-deployment");
    expect(platform.calls.deploy).toBe(1);
  });

  test("allows explicit selection only from an ACTIVE preview deployment", async () => {
    const root = fixture();
    const platform = fakePlatform();
    const selected = await createWorkerPromotionPlan({
      cwd: root,
      to: "production",
      artifactId: "artifact-older",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
    });
    expect(selected.plan.previewDeployment.id).toBe("preview-older");
    expect(selected.plan.artifact.id).toBe("artifact-older");
    await expect(
      createWorkerPromotionPlan({
        cwd: root,
        to: "production",
        artifactId: "artifact-never-previewed",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
      }),
    ).rejects.toThrow("no visible ACTIVE preview deployment");
  });

  test("blocks budget, resource, and Secret gaps without deploying", async () => {
    const root = fixture();
    const platform = fakePlatform({
      budget: 1,
      resources: [],
      secrets: [],
    });
    let caught: WorkerPushError | undefined;
    try {
      await promoteWorkerProject({
        cwd: root,
        to: "production",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        nonInteractive: true,
      });
    } catch (error) {
      caught = error as WorkerPushError;
    }
    expect(caught?.message).toContain("preflight is blocked");
    const recovery = JSON.stringify(caught?.recovery);
    expect(recovery).toContain("workers budget");
    expect(recovery).toContain("resources create");
    expect(recovery).toContain("secrets set");
    expect(platform.calls.deploy).toBe(0);
    expect(platform.calls.health).toBe(0);
  });

  test("shows extra production state as MANUAL data risk and cancellation is mutation-free", async () => {
    const root = fixture();
    const platform = fakePlatform({
      resources: [
        { bindingName: "STATE", type: "KV_NAMESPACE", status: "ACTIVE" },
        { bindingName: "OLD_DB", type: "D1_DATABASE", status: "ACTIVE" },
      ],
    });
    const prepared = await createWorkerPromotionPlan({
      cwd: root,
      to: "production",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
    });
    expect(prepared.plan.canPromote).toBe(true);
    expect(prepared.plan.production.checks).toContainEqual(
      expect.objectContaining({
        status: "MANUAL",
        kind: "resource",
        key: "OLD_DB",
      }),
    );
    expect(
      prepared.plan.production.dataRisk.some((risk) =>
        risk.includes("does not copy preview data"),
      ),
    ).toBe(true);
    await expect(
      promoteWorkerProject({
        cwd: root,
        to: "production",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        confirm: async () => false,
      }),
    ).rejects.toThrow("cancelled");
    expect(platform.calls.deploy).toBe(0);
  });
});
