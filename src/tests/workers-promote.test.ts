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

function fixture(options: { assets?: boolean } = {}): string {
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
        ...(options.assets
          ? {
              assets: {
                directory: "dist/client",
                binding: "ASSETS",
                notFoundHandling: "single-page-application",
              },
            }
          : {}),
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
    bindings?: Array<Record<string, unknown>>;
    resources?: Array<Record<string, unknown>>;
    secrets?: string[];
    failDeployOnce?: boolean;
    webAppReady?: boolean;
    defaultResourceLocation?: string;
    placementMode?: string;
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
  const productionResources: Array<Record<string, unknown>> = options.resources
    ? options.resources.map((resource, index) => ({ id: `resource-${index}`, ...resource }))
    : [{ id: "resource-state", bindingName: "STATE", type: "KV_NAMESPACE", status: "ACTIVE" }];
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
  const calls = { createResource: 0, deploy: 0, health: 0 };
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
          bindings: options.bindings,
          activeDeploymentId: productionDeployments.find(item => item.status === "ACTIVE")?.id,
          dailyBudgetUsd: options.budget ?? 2,
          publicUrl: "https://agent.example.test/w/ref/production",
          webAppReady: options.webAppReady,
          defaultResourceLocation: options.defaultResourceLocation,
          placementMode: options.placementMode,
        },
      ],
      artifacts,
      deployments: [...previewDeployments, ...productionDeployments],
    };
  };
  const client: PromotionClient = {
    getWorkerVariableState: async () => ({ environment: "production", activeDeploymentId: productionDeployments.find(item => item.status === "ACTIVE")?.id || null, exists: productionDeployments.some(item => item.status === "ACTIVE"), variables: [] }),
    getWorkerArtifactVariableConfiguration: async (_options, _id, artifactId) => ({ artifactId, contentSha256: artifacts.find(item => item.id === artifactId)!.contentSha256, keepBindings: [], variables: [], bindingNames: [] }),
    getWorker: async () => snapshot(),
    listWorkerResources: async () => productionResources,
    createWorkerResource: async (_api, _id, _environment, input) => {
      calls.createResource += 1;
      const created = { id: `resource-${calls.createResource}`, ...input, status: "ACTIVE" };
      productionResources.push(created);
      return created;
    },
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
  test("uses selected immutable Artifact vars against production state, independent of local preview vars", async () => {
    const root = fixture();
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ name: "promote-agent", vars: { LOCAL_ONLY: "private-marker" }, keep_vars: false }));
    const platform = fakePlatform({ bindings: [{ name: "ENV_CONFIG", type: "plain_text", text: "private-env-marker" }] });
    const calls: string[] = [];
    platform.client.getWorkerVariableState = async (_options, id, environment) => {
      calls.push(`${id}:${environment}`);
      return { environment, activeDeploymentId: null, exists: true,
        variables: [{ name: "RETAIN_JSON", type: "json" }, { name: "REMOVE_TEXT", type: "plain_text" },
          ...["STATE", "MODEL_KEY", "ASSETS", "VERSION"].map(name => ({ name, type: "json" }))] };
    };
    platform.client.getWorkerArtifactVariableConfiguration = async (_options, id, artifactId) => {
      calls.push(`${id}:${artifactId}`);
      return { artifactId, contentSha256: "b".repeat(64), keepBindings: ["json"],
        variables: [{ name: "JSON_STRING", type: "json" }], bindingNames: ["ASSETS", "VERSION"] };
    };
    const { plan } = await createWorkerPromotionPlan({ cwd: root, to: "production", artifactId: "artifact-older",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test" }, client: platform.client });
    expect(calls).toEqual([`${workerId}:production`, `${workerId}:artifact-older`]);
    expect(plan.variables?.map(({ name, decision }) => ({ name, decision }))).toEqual([
      { name: "ASSETS", decision: "REPLACE" }, { name: "ENV_CONFIG", decision: "SET" }, { name: "JSON_STRING", decision: "SET" },
      { name: "MODEL_KEY", decision: "REPLACE" }, { name: "REMOVE_TEXT", decision: "REMOVE" },
      { name: "RETAIN_JSON", decision: "RETAIN" }, { name: "STATE", decision: "REPLACE" }, { name: "VERSION", decision: "REPLACE" },
    ]);
    expect(plan.variables).toContainEqual(expect.objectContaining({ name: "JSON_STRING", type: "json" }));
    expect(JSON.stringify(plan)).not.toContain("LOCAL_ONLY");
    expect(JSON.stringify(plan)).not.toContain("private-marker");
    expect(JSON.stringify(plan)).not.toContain("private-env-marker");
    expect(plan.canPromote).toBe(true);
    expect(platform.calls.deploy).toBe(0);
  });

  test("fails before promotion on unreadable state, deployment race or wrong immutable declaration", async () => {
    const root = fixture();
    const platform = fakePlatform();
    const options = { cwd: root, to: "production" as const, nonInteractive: true,
      clientOptions: { apiHost: "localhost:3003", apiKey: "test" }, client: platform.client };
    const readState = platform.client.getWorkerVariableState;
    const failure = new Error("state unavailable");
    platform.client.getWorkerVariableState = async () => { throw failure; };
    await expect(promoteWorkerProject(options)).rejects.toBe(failure);
    platform.client.getWorkerVariableState = async () => ({ environment: "production", activeDeploymentId: "raced", exists: true, variables: [] });
    await expect(promoteWorkerProject(options)).rejects.toThrow("deployment changed");
    platform.client.getWorkerVariableState = readState;
    platform.client.getWorkerArtifactVariableConfiguration = async () => ({ artifactId: "artifact-latest", contentSha256: "b".repeat(64), keepBindings: [], variables: [], bindingNames: [] });
    await expect(promoteWorkerProject(options)).rejects.toThrow("selected immutable Artifact");
    platform.client.getWorkerArtifactVariableConfiguration = async () => { throw failure; };
    await expect(promoteWorkerProject(options)).rejects.toBe(failure);
    expect(platform.calls.deploy).toBe(0);
    expect(platform.calls.createResource).toBe(0);
  });

  test("blocks production promotion until declared placement matches", async () => {
    const root = fixture();
    const path = join(root, "xapi.worker.json");
    const config = JSON.parse(await Bun.file(path).text());
    config.environments.production.defaultResourceLocation = "apac";
    config.environments.production.placementMode = "smart";
    writeFileSync(path, JSON.stringify(config));
    const prepared = await createWorkerPromotionPlan({
      cwd: root,
      to: "production",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: fakePlatform({ placementMode: "off" }).client,
    });
    expect(prepared.plan.canPromote).toBe(false);
    expect(prepared.plan.production.checks).toContainEqual(expect.objectContaining({
      status: "BLOCKED",
      kind: "placement",
      command: expect.stringContaining("--data-location apac --placement smart"),
    }));
  });

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

  test("blocks budget and Secret gaps before creating a planned production resource", async () => {
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
    expect(recovery).toContain('"status":"CREATE"');
    expect(recovery).toContain("secrets set");
    expect(platform.calls.deploy).toBe(0);
    expect(platform.calls.health).toBe(0);
    expect(platform.calls.createResource).toBe(0);
  });

  test("creates missing production resources after confirmation and before deployment", async () => {
    const root = fixture();
    const platform = fakePlatform({ resources: [] });
    const result = await promoteWorkerProject({
      cwd: root,
      to: "production",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      retentionPriceVersion: "accepted-production-v1",
      confirm: async (plan) => {
        expect(plan.production.checks).toContainEqual(
          expect.objectContaining({
            status: "CREATE",
            kind: "resource",
            key: "STATE",
          }),
        );
        return true;
      },
      fetchPublic: (async () =>
        Response.json({ ok: true })) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.resources).toEqual({ created: ["STATE"], unchanged: [] });
    expect(platform.calls.createResource).toBe(1);
    expect(platform.calls.deploy).toBe(1);
  });

  test("surfaces path-fallback review without blocking compatible static web apps", async () => {
    const root = fixture({ assets: true });
    const fallback = fakePlatform({ webAppReady: false });
    const blocked = await createWorkerPromotionPlan({
      cwd: root,
      to: "production",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: fallback.client,
    });
    expect(blocked.plan.canPromote).toBe(true);
    expect(blocked.plan.production.checks).toContainEqual(
      expect.objectContaining({
        status: "MANUAL",
        kind: "routing",
        key: "production",
      }),
    );

    const dedicated = fakePlatform({ webAppReady: true });
    const ready = await createWorkerPromotionPlan({
      cwd: root,
      to: "production",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: dedicated.client,
    });
    expect(ready.plan.canPromote).toBe(true);
  });

  test("unreferenced production resources are retained; cancellation remains mutation-free", async () => {
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
        status: "NO_CHANGE",
        kind: "resource",
        key: "OLD_DB",
      }),
    );
    expect(
      prepared.plan.production.dataRisk.some((risk) =>
        risk.includes("does not copy preview data"),
      ),
    ).toBe(true);
    let confirmations = 0;
    await expect(
      promoteWorkerProject({
        cwd: root,
        to: "production",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        confirm: async () => {
          confirmations += 1;
          return false;
        },
      }),
    ).rejects.toThrow("promotion cancelled");
    expect(confirmations).toBe(1);
    expect(platform.calls.deploy).toBe(0);
  });
});
