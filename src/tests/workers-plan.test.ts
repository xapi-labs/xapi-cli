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
import { createWorkerPlan, prepareWorkerPlan } from "../workers-plan.ts";
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
  test.each(["Chat", "constructor", "prototype", "toString", "hasOwnProperty"].flatMap(name =>
    [true, false].map(exists => ({ name, exists }))))("plans exact binding identities without inherited-object collisions: %p", async ({ name, exists }) => {
    const root = project({ linked: true, bundle: "export default {fetch(){return new Response('ok')}}" });
    const path = join(root, "xapi.worker.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.environments.preview.resources = [
      { type: "durable_object", bindingName: name, className: "Chat" },
      { type: "kv_namespace", bindingName: "CHAT" },
    ];
    config.environments.preview.secrets = [];
    writeFileSync(path, JSON.stringify(config));
    const plan = await createWorkerPlan({ cwd: root, environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test" },
      client: {
        listWorkers: unexpected("listWorkers"),
        getWorker: async () => ({ id: workerId, slug: "plan-agent",
          environments: [{ id: "preview", name: "PREVIEW", dailyBudgetUsd: 0.25 }], artifacts: [], deployments: [] }),
        getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
        listWorkerResources: async () => [
          ...(exists ? [{ id: "existing-chat", bindingName: name, type: "DURABLE_OBJECT", status: "ACTIVE", config: { className: "Chat" } }] : []),
          { id: "existing-uppercase", bindingName: "CHAT", type: "KV_NAMESPACE", status: "ACTIVE" },
        ],
        listWorkerSecrets: async () => [],
      },
    });
    expect(plan.canApply).toBe(true);
    const resources = plan.actions.filter(a => a.kind === "resource");
    expect(resources).toHaveLength(2);
    expect(resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: exists ? "NO_CHANGE" : "CREATE", key: name }),
      expect.objectContaining({ operation: "NO_CHANGE", key: "CHAT" }),
    ]));
  });

  test("explains public vars and explicit binding replacement without values or a drift lock", async () => {
    const root = project({ linked: true, bundle: "export default {fetch(){return new Response('ok')}}" });
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ name: "plan-agent", keep_vars: true,
      version_metadata: { binding: "VERSION" }, env: { preview: { vars: { SET: "private-marker", CHANGE: 42 } } } }));
    const client = {
      listWorkers: unexpected("listWorkers"),
      getWorker: async () => ({ id: workerId, slug: "plan-agent",
        environments: [{ id: "preview", name: "PREVIEW", dailyBudgetUsd: 0.25, activeDeploymentId: "live" }], artifacts: [], deployments: [] }),
      getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: "live", exists: true,
        variables: ["KEEP", "CHANGE", "STATE", "MODEL_KEY", "VERSION"].map(name => ({ name, type: "plain_text" })) }),
      listWorkerResources: async () => [{ bindingName: "STATE", type: "KV_NAMESPACE", status: "ACTIVE" }],
      listWorkerSecrets: async () => [{ bindingName: "MODEL_KEY", version: 1 }],
    };
    const options = { cwd: root, environment: "preview" as const, clientOptions: { apiHost: "localhost:3003", apiKey: "test" }, client };
    const plan = await createWorkerPlan(options);
    expect(plan.canApply).toBe(true);
    expect(plan.variables?.map(({ name, decision }) => ({ name, decision }))).toEqual([
      { name: "CHANGE", decision: "REPLACE" }, { name: "KEEP", decision: "RETAIN" },
      { name: "MODEL_KEY", decision: "REPLACE" }, { name: "SET", decision: "SET" },
      { name: "STATE", decision: "REPLACE" }, { name: "VERSION", decision: "REPLACE" },
    ]);
    expect(JSON.stringify(plan)).not.toContain("private-marker");
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ name: "plan-agent" }));
    const removal = await createWorkerPlan(options);
    expect(removal.variables).toContainEqual(expect.objectContaining({ name: "KEEP", decision: "REMOVE" }));
    expect(removal.canApply).toBe(true);
    client.listWorkerSecrets = async () => [];
    expect((await createWorkerPlan(options)).canApply).toBe(false);
    client.listWorkerResources = async () => [{ bindingName: "STATE", type: "D1_DATABASE", status: "ACTIVE" }];
    expect((await createWorkerPlan(options)).canApply).toBe(false);
  });

  test("propagates variable read errors and rejects a different active deployment", async () => {
    const root = project({ linked: true });
    const failure = new Error("native variable read failed");
    const client = {
      listWorkers: unexpected("listWorkers"),
      getWorker: async () => ({ id: workerId, slug: "plan-agent",
        environments: [{ id: "preview", name: "PREVIEW", dailyBudgetUsd: 0.25, activeDeploymentId: "live" }] }),
      listWorkerResources: async () => [], listWorkerSecrets: async () => [],
      getWorkerVariableState: async (): Promise<unknown> => { throw failure; },
    };
    const options = { cwd: root, environment: "preview" as const, clientOptions: { apiHost: "localhost:3003", apiKey: "test" }, client };
    await expect(createWorkerPlan(options)).rejects.toBe(failure);
    client.getWorkerVariableState = async () => ({ environment: "preview", activeDeploymentId: "newer", exists: true, variables: [] });
    await expect(createWorkerPlan(options)).rejects.toThrow("deployment changed");
    client.getWorkerVariableState = async () => ({ environment: "preview", activeDeploymentId: "live", exists: false, variables: [] });
    await expect(createWorkerPlan(options)).rejects.toThrow("state is missing");
  });

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
        getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
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

  test("builds and validates the exact Artifact before presenting the final plan", async () => {
    const root = project();
    const events: string[] = [];
    const prepared = await prepareWorkerPlan({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: {
        getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
        listWorkers: async () => {
          events.push("read-live-state");
          return [];
        },
        getWorker: unexpected("getWorker"),
        listWorkerResources: unexpected("listWorkerResources"),
        listWorkerSecrets: unexpected("listWorkerSecrets"),
      },
      runBuild: async () => {
        events.push("build");
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(
          join(root, "dist/worker.mjs"),
          "export default {fetch(){return new Response('ok')}};",
        );
      },
    });
    expect(events).toEqual(["build", "read-live-state"]);
    expect(prepared.plan.actions).toContainEqual(
      expect.objectContaining({
        operation: "CREATE",
        kind: "artifact",
        desired: expect.objectContaining({
          sha256: prepared.bundle.contentSha256,
          sizeBytes: prepared.bundle.sizeBytes,
        }),
      }),
    );
  });

  test("plan compares the current remote binding snapshot, not only code", async () => {
    const bundle = "export default {fetch(){return new Response('ok')}}";
    const root = project({ linked: true, bundle });
    const resources = [{ id: "resource", bindingName: "STATE", type: "KV_NAMESPACE", status: "ACTIVE", providerResourceId: "first" }];
    const secrets = [{ bindingName: "MODEL_KEY", version: 1 }];
    const environment = { id: "env-preview", name: "PREVIEW", dailyBudgetUsd: 0.25, activeDeploymentId: "live", bindings: [{ name: "ENV_CONFIG", type: "json", json: "private-marker" }] };
    const prefix = deploymentPrefix(workerId, "preview", "artifact", {}, environment, resources, secrets);
    const client = {
      getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: "live", exists: true, variables: [{ name: "EXTERNAL_VAR", type: "plain_text" }] }),
      listWorkers: unexpected("listWorkers"),
      listWorkerResources: async () => resources,
      listWorkerSecrets: async () => secrets,
      getWorker: async () => ({ id: workerId, slug: "plan-agent", environments: [environment],
        artifacts: [{ id: "artifact", contentSha256: createHash("sha256").update(bundle).digest("hex") }],
        deployments: [{ id: "live", environmentId: environment.id, artifactId: "artifact", status: "ACTIVE", idempotencyKey: prefix + "prior" }] }),
    };
    const run = async () => (await createWorkerPlan({ cwd: root, environment: "preview", clientOptions: { apiHost: "localhost:3148", apiKey: "test" }, client })).actions.find(a => a.kind === "deployment")?.operation;
    expect(await run()).toBe("NO_CHANGE");
    const noOp = await createWorkerPlan({ cwd: root, environment: "preview", clientOptions: { apiHost: "localhost:3148", apiKey: "test" }, client });
    expect(noOp.variables).toContainEqual(expect.objectContaining({ name: "EXTERNAL_VAR", decision: "REMOVE", message: expect.stringContaining("If deployment occurs") }));
    expect(noOp.variables).toContainEqual(expect.objectContaining({ name: "ENV_CONFIG", decision: "SET", type: "json", message: expect.stringContaining("If deployment occurs") }));
    expect(JSON.stringify(noOp)).not.toContain("private-marker");
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
      getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
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
      getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
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
      getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
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
      getWorkerVariableState: unexpected("getWorkerVariableState"),
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
      getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
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
      workerBillingQuery: async () => ({
        data: {
          version: "workers-2026-09",
          effectiveFrom: "2026-09-01T00:00:00.000Z",
          rates: [{ metric: "WORKER_REQUEST", retailUnitPriceUsd: "0.01" }],
        },
      }),
    };
    const plan = await createWorkerPlan({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client,
    });
    expect(plan.canApply).toBe(true);
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
        operation: "NO_CHANGE",
        kind: "resource",
        key: "OLD_DB",
        message: expect.stringContaining("Not referenced by this JSON"),
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
    expect(plan.costImpact).toEqual(
      expect.objectContaining({
        status: "AVAILABLE",
        currentDailyBudgetUsd: 0.5,
        desiredDailyBudgetUsd: 0.25,
        dailyBudgetDeltaUsd: -0.25,
        priceBook: expect.objectContaining({
          version: "workers-2026-09",
          rateCount: 1,
        }),
      }),
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
      if (url.endsWith("/variables")) return Response.json({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] });
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
    expect(methods).toEqual(["GET", "GET", "GET", "GET", "GET"]);
  });

  test("propagates a safe hidden-instance 404 and performs no fallback lookup", async () => {
    const root = project({ linked: true });
    const calls: string[] = [];
    const client = {
      getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
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
        getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
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

describe("resource recovery guidance", () => {
  for (const resource of [
    { errorCode: "worker_control_cancelled_before_dispatch", providerResourceId: null, canRetry: true },
    { errorCode: "worker_control_cancelled_before_dispatch", providerResourceId: "native-id", canRetry: false },
    { errorCode: "worker_control_cancelled_before_dispatch", canRetry: false },
    { errorCode: "provider_timeout", providerResourceId: null, canRetry: false },
    { status: "UNKNOWN", errorCode: "worker_control_cancelled_before_dispatch", providerResourceId: null, canRetry: false },
    { errorCode: "worker_control_cancelled_before_dispatch", providerResourceId: null, config: { __xapiDeletionIntentV1: {} }, canRetry: false },
    { errorCode: "worker_control_cancelled_before_dispatch", providerResourceId: null, config: { controlDeletionRequested: true }, canRetry: false },
  ]) {
    test(`creation hint requires proven pre-dispatch cancellation: ${JSON.stringify(resource)}`, async () => {
      const root = project({ linked: true });
      const plan = await createWorkerPlan({
        cwd: root, environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: {
          listWorkers: unexpected("listWorkers"),
          getWorker: async () => ({ id: workerId, slug: "plan-agent", environments: [{ id: "env-preview", name: "PREVIEW", dailyBudgetUsd: 0.25 }], artifacts: [], deployments: [] }),
          listWorkerResources: async () => [{ id: "original-resource", type: "KV_NAMESPACE", bindingName: "STATE", status: "ERROR", ...resource }],
          listWorkerSecrets: async () => [{ bindingName: "MODEL_KEY", version: 1 }],
          getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
        },
      });
      const action = plan.actions.find(item => item.kind === "resource" && item.key === "STATE");
      expect(action?.operation).toBe("BLOCKED");
      expect(JSON.stringify(action).includes("Retry the same binding")).toBe(resource.canRetry);
      expect(JSON.stringify(action)).toContain(workerId);
    });
  }

  for (const [type, publicType, extra] of [
    ["kv_namespace", "kv", {}],
    ["d1_database", "d1", { location: "apac", readReplication: "disabled" }],
    ["r2_bucket", "r2", { location: "weur" }],
    ["durable_object", "do", { className: "$Counter" }],
    ["queue", "queue", {}],
    ["workflow", "workflow", { className: "Pipeline" }],
  ] as const) {
    test(`same-binding hint uses public --type ${publicType} and preserves configuration`, async () => {
      const root = project({ linked: true });
      const path = join(root, "xapi.worker.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.environments.preview.resources = [{ type, bindingName: "STATE", ...extra }];
      writeFileSync(path, JSON.stringify(config));
      const plan = await createWorkerPlan({
        cwd: root, environment: "preview", clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: {
          listWorkers: unexpected("listWorkers"),
          getWorker: async () => ({ id: workerId, slug: "plan-agent", environments: [{ id: "env-preview", name: "PREVIEW", dailyBudgetUsd: 0.25 }], artifacts: [], deployments: [] }),
          listWorkerResources: async () => [{ id: "original-resource", type: type.toUpperCase(), bindingName: "STATE", status: "ERROR",
            errorCode: "worker_control_cancelled_before_dispatch", providerResourceId: null,
            config: { ...extra, ...("location" in extra ? { requestedLocation: extra.location } : {}) } }],
          listWorkerSecrets: async () => [{ bindingName: "MODEL_KEY", version: 1 }],
          getWorkerVariableState: async () => ({ environment: "preview", activeDeploymentId: null, exists: false, variables: [] }),
        },
      });
      const action = plan.actions.find(item => item.kind === "resource" && item.key === "STATE");
      expect(action?.operation).toBe("BLOCKED");
      expect(action?.message).toContain(`resources create ${workerId} --env preview --type ${publicType} --binding STATE`);
      if ("className" in extra) expect(action?.message).toContain(`--class-name '${extra.className}'`);
      if ("location" in extra) expect(action?.message).toContain(`--location ${extra.location}`);
      if ("readReplication" in extra) expect(action?.message).toContain(`--read-replication ${extra.readReplication}`);
      expect(action?.message).toContain("--retention-price-version <current-quote-version>");
      expect(action?.message).toContain("Preserve the existing resource ID");
      expect(plan.canApply).toBe(false);
      expect(plan.costImpact.notes.join(" ")).toContain("risk-control target, not a hard spending cap");
    });
  }
});
