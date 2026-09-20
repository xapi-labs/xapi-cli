import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HttpError } from "../client.ts";
import { createWorkerPlan } from "../workers-plan.ts";
import { WORKER_PROJECT_SCHEMA_URL } from "../workers-project.ts";
import { deploymentPrefix } from "../workers-deployment-state.ts";

const roots: string[] = [];
const originalFetch = globalThis.fetch;
const workerId = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(options: { linked?: boolean; bundle?: string } = {}): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xapi-plan-")));
  roots.push(root);
  writeFileSync(
    join(root, "xapi.worker.json"),
    JSON.stringify(
      {
        $schema: WORKER_PROJECT_SCHEMA_URL,
        version: 1,
        ...(options.linked ? { workerId } : {}),
        worker: { name: "Plan Agent", slug: "plan-agent", template: "agent" },
        wrangler: "wrangler.jsonc",
        build: { command: "npm run build", output: "dist/worker.mjs" },
        environments: {
          preview: {
            dailyBudgetUsd: 0.25,
            healthCheck: "/health",
            resources: [{ type: "kv_namespace", bindingName: "STATE" }],
            secrets: ["MODEL_KEY"],
          },
          production: {
            dailyBudgetUsd: 2,
            healthCheck: "/health",
            resources: [],
            secrets: [],
          },
        },
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({ name: "plan-agent", main: "src/index.ts" }),
  );
  if (options.bundle !== undefined) {
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/worker.mjs"), options.bundle);
  }
  return root;
}

function unexpected(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`unexpected ${name}`);
  };
}

describe("workers plan", () => {
  test("shows native environment placement drift before deployment", async () => {
    const root = project({ linked: true });
    const path = join(root, "xapi.worker.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.environments.preview.defaultResourceLocation = "apac";
    config.environments.preview.placementMode = "smart";
    config.environments.preview.resources = [];
    config.environments.preview.secrets = [];
    writeFileSync(path, JSON.stringify(config));
    const plan = await createWorkerPlan({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: {
        listWorkers: unexpected("listWorkers"),
        getWorker: async () => ({
          id: workerId,
          slug: "plan-agent",
          environments: [{
            id: "env-preview",
            name: "PREVIEW",
            dailyBudgetUsd: 0.25,
            placementMode: "off",
          }],
          artifacts: [],
          deployments: [],
        }),
        listWorkerResources: async () => [],
        listWorkerSecrets: async () => [],
      },
    });
    expect(plan.actions).toContainEqual(expect.objectContaining({
      operation: "UPDATE",
      kind: "placement",
      desired: { defaultResourceLocation: "apac", placementMode: "smart" },
    }));
  });

  test("plan compares the current remote binding snapshot, not only code", async () => {
    const bundle = "export default {fetch(){return new Response('ok')}}";
    const root = project({ linked: true, bundle });
    const resources = [{ id: "resource", bindingName: "STATE", type: "KV_NAMESPACE", status: "ACTIVE", providerResourceId: "first" }];
    const secrets = [{ bindingName: "MODEL_KEY", version: 1 }];
    const environment = { id: "env-preview", name: "PREVIEW", dailyBudgetUsd: 0.25, activeDeploymentId: "live" };
    const prefix = deploymentPrefix(workerId, "preview", "artifact", {}, environment, resources, secrets);
    const client = {
      listWorkers: unexpected("listWorkers"),
      listWorkerResources: async () => resources,
      listWorkerSecrets: async () => secrets,
      getWorker: async () => ({ id: workerId, slug: "plan-agent", environments: [environment],
        artifacts: [{ id: "artifact", contentSha256: createHash("sha256").update(bundle).digest("hex") }],
        deployments: [{ id: "live", environmentId: environment.id, artifactId: "artifact", status: "ACTIVE", idempotencyKey: prefix + "prior" }] }),
    };
    const run = async () => (await createWorkerPlan({ cwd: root, environment: "preview", clientOptions: { apiHost: "localhost:3148", apiKey: "test" }, client })).actions.find(a => a.kind === "deployment")?.operation;
    expect(await run()).toBe("NO_CHANGE");
    resources[0].providerResourceId = "replacement";
    expect(await run()).toBe("CREATE");
    resources[0].providerResourceId = "first";
    const config = JSON.parse(readFileSync(join(root, "xapi.worker.json"), "utf8"));
    config.environments.preview.resources.push({ bindingName: "NEW_DB", type: "d1_database" });
    writeFileSync(join(root, "xapi.worker.json"), JSON.stringify(config));
    expect(await run()).toBe("CREATE");
  });
  test("blocks an in-place D1 location change and explains that migration is required", async () => {
    const bundle = "export default {fetch(){return new Response('ok')}}";
    const root = project({ linked: true, bundle });
    const config = JSON.parse(
      readFileSync(join(root, "xapi.worker.json"), "utf8"),
    );
    config.environments.preview.resources = [
      { type: "d1_database", bindingName: "DB", location: "apac" },
    ];
    writeFileSync(join(root, "xapi.worker.json"), JSON.stringify(config));
    const client = {
      listWorkers: unexpected("listWorkers"),
      getWorker: async () => ({
        id: workerId,
        slug: "plan-agent",
        environments: [
          {
            id: "env-preview",
            name: "PREVIEW",
            dailyBudgetUsd: 0.25,
          },
        ],
        artifacts: [],
        deployments: [],
      }),
      listWorkerResources: async () => [
        {
          bindingName: "DB",
          type: "D1_DATABASE",
          status: "ACTIVE",
          config: { created_in_region: "EEUR" },
        },
      ],
      listWorkerSecrets: async () => [],
    };
    const plan = await createWorkerPlan({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client,
    });
    expect(plan.canApply).toBe(false);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        operation: "BLOCKED",
        kind: "resource",
        key: "DB",
        message: expect.stringContaining("migrate data"),
        desired: expect.objectContaining({ location: "apac" }),
        current: expect.objectContaining({ effectiveLocation: "eeur" }),
      }),
    );
  });
  test("shows requested and effective placement when the resource matches", async () => {
    const bundle = "export default {fetch(){return new Response('ok')}}";
    const root = project({ linked: true, bundle });
    const config = JSON.parse(
      readFileSync(join(root, "xapi.worker.json"), "utf8"),
    );
    config.environments.preview.resources = [
      { type: "d1_database", bindingName: "DB", location: "apac" },
    ];
    writeFileSync(join(root, "xapi.worker.json"), JSON.stringify(config));
    const client = {
      listWorkers: unexpected("listWorkers"),
      getWorker: async () => ({
        id: workerId,
        slug: "plan-agent",
        environments: [
          {
            id: "env-preview",
            name: "PREVIEW",
            dailyBudgetUsd: 0.25,
          },
        ],
        artifacts: [],
        deployments: [],
      }),
      listWorkerResources: async () => [
        {
          bindingName: "DB",
          type: "D1_DATABASE",
          status: "ACTIVE",
          config: {
            requestedLocation: "apac",
            created_in_region: "APAC",
          },
        },
      ],
      listWorkerSecrets: async () => [],
    };
    const plan = await createWorkerPlan({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client,
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        operation: "NO_CHANGE",
        kind: "resource",
        key: "DB",
        current: expect.objectContaining({
          requestedLocation: "apac",
          effectiveLocation: "apac",
        }),
      }),
    );
  });
  test("rejects a missing Wrangler configuration before reading remote state", async () => {
    const root = project();
    rmSync(join(root, "wrangler.jsonc"));
    const client = {
      listWorkers: unexpected("listWorkers"),
      getWorker: unexpected("getWorker"),
      listWorkerResources: unexpected("listWorkerResources"),
      listWorkerSecrets: unexpected("listWorkerSecrets"),
    };

    await expect(
      createWorkerPlan({
        cwd: root,
        environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client,
      }),
    ).rejects.toMatchObject({
      code: "worker_project_wrangler_not_found",
    });
  });

  test("plans a new Worker deterministically without making any write call", async () => {
    const root = project();
    const calls: string[] = [];
    const client = {
      listWorkers: async () => {
        calls.push("listWorkers");
        return [];
      },
      getWorker: unexpected("getWorker"),
      listWorkerResources: unexpected("listWorkerResources"),
      listWorkerSecrets: unexpected("listWorkerSecrets"),
    };
    const options = {
      cwd: root,
      environment: "preview" as const,
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client,
    };
    const first = await createWorkerPlan(options);
    const second = await createWorkerPlan(options);
    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(1);
    expect(first.canApply).toBe(false);
    expect(first.actions).toContainEqual(
      expect.objectContaining({ operation: "CREATE", kind: "worker" }),
    );
    expect(first.actions).toContainEqual(
      expect.objectContaining({
        operation: "CREATE",
        kind: "resource",
        key: "STATE",
      }),
    );
    expect(first.actions).toContainEqual(
      expect.objectContaining({
        operation: "BLOCKED",
        kind: "secret",
        key: "MODEL_KEY",
      }),
    );
    expect(JSON.stringify(first)).not.toContain("secretValue");
    expect(calls).toEqual(["listWorkers", "listWorkers"]);
  });

  test("diffs linked budgets, resources, Secret metadata, Artifact and deployment", async () => {
    const bundle = "export default { fetch() { return new Response('ok') } };";
    const sha256 = createHash("sha256").update(bundle).digest("hex");
    const root = project({ linked: true, bundle });
    const client = {
      listWorkers: unexpected("listWorkers"),
      getWorker: async () => ({
        id: workerId,
        slug: "plan-agent",
        environments: [
          { id: "env-preview", name: "PREVIEW", dailyBudgetUsd: "0.50" },
        ],
        artifacts: [{ id: "artifact-matching", contentSha256: sha256 }],
        deployments: [
          {
            id: "deployment-active",
            environmentId: "env-preview",
            artifactId: "artifact-matching",
            status: "ACTIVE",
          },
        ],
      }),
      listWorkerResources: async () => [
        { bindingName: "STATE", type: "KV_NAMESPACE", status: "ACTIVE" },
        { bindingName: "OLD_DB", type: "D1_DATABASE", status: "ACTIVE" },
      ],
      listWorkerSecrets: async () => [
        { bindingName: "MODEL_KEY", version: 2 },
        { bindingName: "OLD_SECRET", version: 1 },
      ],
    };
    const plan = await createWorkerPlan({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client,
    });
    expect(plan.canApply).toBe(false);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ operation: "UPDATE", kind: "budget" }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        operation: "NO_CHANGE",
        kind: "resource",
        key: "STATE",
      }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        operation: "MANUAL",
        kind: "resource",
        key: "OLD_DB",
        message: expect.stringContaining("resources pull"),
      }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        operation: "NO_CHANGE",
        kind: "secret",
        key: "MODEL_KEY",
      }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        operation: "MANUAL",
        kind: "secret",
        key: "OLD_SECRET",
      }),
    );
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ operation: "NO_CHANGE", kind: "artifact" }),
    );
    expect(plan.actions).toContainEqual(
      // Legacy deployments have no configuration fingerprint: one safe redeploy.
      expect.objectContaining({ operation: "CREATE", kind: "deployment" }),
    );
  });

  test("uses only GET requests at the real HTTP client boundary", async () => {
    const root = project({ linked: true });
    const methods: string[] = [];
    globalThis.fetch = (async (input, init) => {
      methods.push(init?.method || "GET");
      const url = String(input);
      if (url.endsWith(`/workers/${workerId}`)) {
        return Response.json({
          id: workerId,
          slug: "plan-agent",
          environments: [
            { id: "env-preview", name: "PREVIEW", dailyBudgetUsd: 0.25 },
          ],
          artifacts: [],
          deployments: [],
        });
      }
      if (url.endsWith("/resources")) {
        return Response.json([
          { bindingName: "STATE", type: "KV_NAMESPACE", status: "ACTIVE" },
        ]);
      }
      if (url.endsWith("/secrets")) {
        return Response.json([{ bindingName: "MODEL_KEY", version: 1 }]);
      }
      return Response.json({ error: "unexpected" }, { status: 500 });
    }) as typeof fetch;
    const plan = await createWorkerPlan({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
    });
    expect(plan.canApply).toBe(true);
    expect(methods).toEqual(["GET", "GET", "GET"]);
  });

  test("propagates a safe hidden-instance 404 and performs no fallback lookup", async () => {
    const root = project({ linked: true });
    const calls: string[] = [];
    const client = {
      listWorkers: unexpected("listWorkers"),
      getWorker: async () => {
        calls.push("getWorker");
        throw new HttpError(404, "Worker not found");
      },
      listWorkerResources: unexpected("listWorkerResources"),
      listWorkerSecrets: unexpected("listWorkerSecrets"),
    };
    await expect(
      createWorkerPlan({
        cwd: root,
        environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client,
      }),
    ).rejects.toThrow("Worker not found");
    expect(calls).toEqual(["getWorker"]);
  });

  test("treats a declared Durable Object as deployable while it awaits its first deployment", async () => {
    const root = project({ linked: true });
    const path = join(root, "xapi.worker.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.environments.preview.resources = [
      {
        type: "durable_object",
        bindingName: "AGENT",
        className: "AgentState",
      },
    ];
    config.environments.preview.secrets = [];
    writeFileSync(path, JSON.stringify(config, null, 2));
    const plan = await createWorkerPlan({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: {
        listWorkers: unexpected("listWorkers"),
        getWorker: async () => ({
          id: workerId,
          slug: "plan-agent",
          environments: [
            { id: "env-preview", name: "PREVIEW", dailyBudgetUsd: 0.25 },
          ],
          artifacts: [],
          deployments: [],
        }),
        listWorkerResources: async () => [
          {
            bindingName: "AGENT",
            type: "DURABLE_OBJECT",
            status: "PROVISIONING",
            config: { className: "AgentState" },
          },
        ],
        listWorkerSecrets: async () => [],
      },
    });
    expect(plan.canApply).toBe(true);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        operation: "NO_CHANGE",
        kind: "resource",
        key: "AGENT",
      }),
    );
  });
});
