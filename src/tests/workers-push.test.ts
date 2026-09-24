import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
import { HttpError, RequestTimeoutError } from "../client.ts";
import {
  type PushClient,
  WorkerPushError,
  pushWorkerProject,
} from "../workers-push.ts";
import {
  WORKER_PROJECT_SCHEMA_URL,
  loadWorkerProject,
} from "../workers-project.ts";

const roots: string[] = [];
const workerId = "22222222-2222-4222-8222-222222222222";
const originalXapiKey = process.env.XAPI_KEY;

afterEach(() => {
  if (originalXapiKey === undefined) delete process.env.XAPI_KEY;
  else process.env.XAPI_KEY = originalXapiKey;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(
  options: {
    linked?: boolean;
    secrets?: string[];
    resources?: Array<Record<string, string>>;
    buildCommand?: string;
  } = {},
): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xapi-push-")));
  roots.push(root);
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({
      name: "push-agent",
      main: "src/index.ts",
      compatibility_date: "2026-08-26",
      compatibility_flags: ["nodejs_compat"],
    }),
  );
  writeFileSync(
    join(root, "xapi.worker.json"),
    JSON.stringify(
      {
        $schema: WORKER_PROJECT_SCHEMA_URL,
        version: 1,
        ...(options.linked ? { workerId } : {}),
        worker: { name: "Push Agent", slug: "push-agent", template: "agent" },
        wrangler: "wrangler.jsonc",
        build: {
          command: options.buildCommand || "fake-build",
          output: "dist/worker.mjs",
        },
        environments: {
          preview: {
            dailyBudgetUsd: 0.25,
            healthCheck: "/health",
            resources: options.resources || [],
            secrets: options.secrets || [],
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
  return root;
}

function fakePlatform(
  options: {
    exists?: boolean;
    secrets?: string[];
    failUncertainWrites?: boolean;
  } = {},
) {
  const state: {
    worker?: Record<string, unknown>;
    resources: Array<Record<string, unknown>>;
    secrets: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
    deployments: Array<Record<string, unknown>>;
    deploymentReads: number;
  } = {
    resources: [],
    secrets: (options.secrets || []).map((bindingName) => ({
      bindingName,
      version: 1,
    })),
    artifacts: [],
    deployments: [],
    deploymentReads: 0,
  };
  const calls = {
    createWorker: 0,
    updateBudget: 0,
    createResource: 0,
    uploadArtifact: 0,
    deploy: 0,
  };
  const snapshot = () => {
    if (!state.worker) throw new Error("Worker does not exist");
    if (state.deployments.length) {
      state.deploymentReads += 1;
      if (state.deploymentReads >= 2) {
        state.deployments[0].status = "ACTIVE";
      }
    }
    return {
      ...state.worker,
      environments: [
        {
          id: "env-preview",
          name: "PREVIEW",
          activeDeploymentId: state.deployments.find(item => item.status === "ACTIVE")?.id,
          dailyBudgetUsd: 0.25,
          publicUrl: "https://push-agent.example.test/w/agent/preview",
        },
        {
          id: "env-production",
          name: "PRODUCTION",
          dailyBudgetUsd: 2,
          publicUrl: "https://push-agent-prod.example.test",
        },
      ],
      artifacts: state.artifacts,
      deployments: state.deployments,
    };
  };
  if (options.exists) {
    state.worker = { id: workerId, name: "Push Agent", slug: "push-agent" };
  }
  let failCreate = !!options.failUncertainWrites;
  let failResource = !!options.failUncertainWrites;
  let failArtifact = !!options.failUncertainWrites;
  let failDeploy = !!options.failUncertainWrites;
  const client: PushClient = {
    listWorkers: async () => (state.worker ? [snapshot()] : []),
    getWorker: async () => snapshot(),
    createWorker: async () => {
      calls.createWorker += 1;
      state.worker = {
        id: workerId,
        name: "Push Agent",
        slug: "push-agent",
      };
      if (failCreate) {
        failCreate = false;
        throw new RequestTimeoutError(30_000);
      }
      return snapshot();
    },
    updateWorkerEnvironment: async () => {
      calls.updateBudget += 1;
      return { dailyBudgetUsd: 0.25 };
    },
    listWorkerResources: async () => state.resources,
    createWorkerResource: async (_api, _id, _environment, input) => {
      calls.createResource += 1;
      state.resources.push({
        ...input,
        id: `resource-${calls.createResource}`,
        type: input.type.toUpperCase(),
        status: "ACTIVE",
      });
      if (failResource) {
        failResource = false;
        throw new RequestTimeoutError(30_000);
      }
      return state.resources.at(-1);
    },
    listWorkerSecrets: async () => state.secrets,
    listWorkerDomains: async () => [],
    workerBillingQuery: async () => ({
      snapshotId: "snapshot-1",
      dataQuality: "COMPLETE",
      data: { lifecycleState: "RUNNING", dailyBudgetUsd: 0.25 },
    }),
    listWorkerArtifacts: async () => state.artifacts,
    uploadWorkerArtifact: async (_api, _id, input) => {
      calls.uploadArtifact += 1;
      const artifactBytes = "bundle" in input
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              mainModule: input.bundle.mainModule,
              modules: [...input.bundle.modules]
                .sort((a: any, b: any) => a.path.localeCompare(b.path))
                .map((module: any) => ({
                  path: module.path,
                  contentBase64:
                    module.encoding === "base64"
                      ? module.content
                      : Buffer.from(module.content, "utf8").toString("base64"),
                  contentType: module.contentType,
                })),
            }),
            "utf8",
          )
        : Buffer.from(input.moduleCode, "utf8");
      const artifact = {
        id: "artifact-1",
        idempotencyKey: input.idempotencyKey,
        contentSha256: createHash("sha256").update(artifactBytes).digest("hex"),
        sizeBytes: artifactBytes.length,
      };
      state.artifacts.push(artifact);
      if (failArtifact) {
        failArtifact = false;
        throw new RequestTimeoutError(60_000);
      }
      return artifact;
    },
    deployWorker: async (_api, _id, input) => {
      calls.deploy += 1;
      const deployment = {
        resourceIds: input.resourceIds,
        id: "deployment-1",
        idempotencyKey: input.idempotencyKey,
        artifactId: input.artifactId,
        environmentId: "env-preview",
        status: "DEPLOYING",
      };
      state.deployments.push(deployment);
      if (failDeploy) {
        failDeploy = false;
        throw new RequestTimeoutError(60_000);
      }
      return deployment;
    },
  };
  return { client, state, calls };
}

describe("workers push preview", () => {
  test("passes only the explicit retention quote version to resource creation and deployment", async () => {
    const root=fixture({resources:[{type:"kv_namespace",bindingName:"STATE"}]});
    const platform=fakePlatform();
    const resources:unknown[]=[];const deployments:unknown[]=[];
    const create=platform.client.createWorkerResource.bind(platform.client);
    const deploy=platform.client.deployWorker.bind(platform.client);
    platform.client.createWorkerResource=async(...args)=>{resources.push(args[3].retentionPriceVersion);return create(...args)};
    platform.client.deployWorker=async(...args)=>{deployments.push(args[2].retentionPriceVersion);return deploy(...args)};
    await pushWorkerProject({cwd:root,environment:"preview",clientOptions:{apiHost:"localhost:3003",apiKey:"test-key"},client:platform.client,retentionPriceVersion:"accepted-v1",confirm:async()=>true,runBuild:async()=>{mkdirSync(join(root,"dist"),{recursive:true});writeFileSync(join(root,"dist/worker.mjs"),"export default {fetch(){return new Response('ok')}};");},fetchPublic:(async()=>Response.json({ok:true})) as unknown as typeof fetch,sleep:async()=>undefined});
    expect(resources).toEqual(["accepted-v1"]);
    expect(deployments).toEqual(["accepted-v1"]);
  });
  test("passes D1 location and replication from the project without inventing defaults", async () => {
    const root = fixture({
      resources: [
        {
          type: "d1_database",
          bindingName: "DB",
          location: "apac",
          readReplication: "disabled",
        },
      ],
    });
    const platform = fakePlatform();
    const inputs: Array<Record<string, unknown>> = [];
    const create = platform.client.createWorkerResource.bind(platform.client);
    platform.client.createWorkerResource = async (...args) => {
      inputs.push(args[3]);
      return create(...args);
    };
    await pushWorkerProject({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      confirm: async () => true,
      runBuild: async () => {
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(
          join(root, "dist/worker.mjs"),
          "export default {fetch(){return new Response('ok')}};",
        );
      },
      fetchPublic: (async () =>
        Response.json({ ok: true })) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(inputs).toEqual([
      {
        type: "d1_database",
        bindingName: "DB",
        location: "apac",
        readReplication: "disabled",
      },
    ]);
  });
  test("recovers uncertain writes, hides credentials from build, waits ACTIVE, and is repeatable", async () => {
    const root = fixture({
      resources: [{ type: "kv_namespace", bindingName: "STATE" }],
      buildCommand: "node build.mjs",
    });
    writeFileSync(
      join(root, "build.mjs"),
      `import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("dist", { recursive: true });
writeFileSync("dist/worker.mjs", "export default { async fetch() { return new Response('ok') } };\\n");
writeFileSync("observed-key.txt", process.env.XAPI_KEY || "");
`,
    );
    process.env.XAPI_KEY = "must-not-reach-build";
    const platform = fakePlatform({ failUncertainWrites: true });
    const publicRequests: Array<{ url: string; headers: Headers }> = [];
    const fetchPublic = (async (input, init) => {
      publicRequests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const planViews: unknown[] = [];
    const first = await pushWorkerProject({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      confirm: async () => true,
      onPlan: (plan) => planViews.push(plan),
      fetchPublic,
      sleep: async () => undefined,
    });
    expect(first.status).toBe("ACTIVE");
    expect(first.worker).toEqual({
      id: workerId,
      created: true,
      configLinked: true,
    });
    expect(loadWorkerProject(root).config.workerId).toBe(workerId);
    expect(readFileSync(join(root, "observed-key.txt"), "utf8")).toBe("");
    expect(first.resources.created).toEqual(["STATE"]);
    expect(first.deployment.status).toBe("ACTIVE");
    expect(first.inspection.mode).toBe("READ_ONLY");
    expect(first.inspection.environment.status).toBe("ACTIVE");
    expect(first.commands.inspect).toContain(`inspect ${workerId}`);
    expect(first.health.url).toBe(
      "https://push-agent.example.test/w/agent/preview/health",
    );
    expect(publicRequests[0].headers.has("XAPI-KEY")).toBe(false);
    expect(publicRequests[0].headers.has("Authorization")).toBe(false);
    expect(platform.calls).toEqual({
      createWorker: 1,
      updateBudget: 0,
      createResource: 1,
      uploadArtifact: 1,
      deploy: 1,
    });

    const second = await pushWorkerProject({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      confirm: async () => true,
      fetchPublic,
      sleep: async () => undefined,
    });
    expect(second.status).toBe("ACTIVE");
    expect(second.worker.created).toBe(false);
    expect(second.resources).toEqual({ created: [], unchanged: ["STATE"] });
    expect(platform.calls).toEqual({
      createWorker: 1,
      updateBudget: 0,
      createResource: 1,
      uploadArtifact: 1,
      deploy: 1,
    });
    expect(planViews).toHaveLength(1);
  });

  test("interactive bootstrap validates the build before saving prerequisites, then stops for a missing Secret", async () => {
    const root = fixture({ secrets: ["MODEL_KEY"] });
    const platform = fakePlatform();
    let buildCalls = 0;
    let caught: WorkerPushError | undefined;
    try {
      await pushWorkerProject({
        cwd: root,
        environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        confirm: async () => true,
        runBuild: async () => {
          buildCalls += 1;
          mkdirSync(join(root, "dist"), { recursive: true });
          writeFileSync(
            join(root, "dist/worker.mjs"),
            "export default {fetch(){return new Response('ok')}};",
          );
        },
      });
    } catch (error) {
      caught = error as WorkerPushError;
    }
    expect(caught).toBeInstanceOf(WorkerPushError);
    expect(caught?.message).toContain("required Secrets are missing");
    expect(caught?.recovery.missingSecrets).toEqual(["MODEL_KEY"]);
    expect(JSON.stringify(caught?.recovery)).toContain(
      `secrets set ${workerId} MODEL_KEY`,
    );
    expect(buildCalls).toBe(1);
    expect(platform.calls.uploadArtifact).toBe(0);
    expect(platform.calls.deploy).toBe(0);
    expect(loadWorkerProject(root).config.workerId).toBe(workerId);
  });

  test("unreferenced resources remain stored but are excluded from deployed bindings", async () => {
    const root = fixture({ linked: true });
    const platform = fakePlatform({ exists: true });
    platform.state.resources.push({
      id: "resource-old-db",
      bindingName: "OLD_DB",
      type: "D1_DATABASE",
      status: "ACTIVE",
    });
    let confirmations = 0;
    await pushWorkerProject({
        cwd: root,
        environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        confirm: async () => {
          confirmations += 1;
          return true;
        },
        runBuild: async () => {
          mkdirSync(join(root, "dist"), { recursive: true });
          writeFileSync(
            join(root, "dist/worker.mjs"),
            "export default {fetch(){return new Response('ok')}};",
          );
        },
        fetchPublic: (async () => Response.json({ ok: true })) as unknown as typeof fetch,
        sleep: async () => undefined,
    });
    expect(confirmations).toBe(1);
    expect(platform.state.resources).toHaveLength(1);
    expect(platform.state.resources[0].id).toBe("resource-old-db");
    expect(platform.state.deployments[0].resourceIds).toEqual([]);
    expect(platform.calls.deploy).toBe(1);
  });

  test.each(["build", "confirmation"])("rejects JSON edits during %s before remote mutations", async (phase) => {
    const root = fixture({ linked: true });
    const platform = fakePlatform({ exists: true });
    const edit = () => {
      const path = join(root, "xapi.worker.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.environments.preview.dailyBudgetUsd = 0.5;
      writeFileSync(path, JSON.stringify(config));
    };
    await expect(pushWorkerProject({
      cwd: root, environment: "preview",
      clientOptions: {apiHost:"localhost:3003", apiKey:"test-key"}, client: platform.client,
      runBuild: async () => {
        mkdirSync(join(root,"dist"), {recursive:true});
        writeFileSync(join(root,"dist/worker.mjs"), "export default {fetch(){return new Response('ok')}}");
        if (phase === "build") edit();
      },
      confirm: async () => { if (phase === "confirmation") edit(); return true; },
    })).rejects.toThrow("configuration changed");
    expect(platform.calls.uploadArtifact).toBe(0);
    expect(platform.calls.deploy).toBe(0);
    expect(platform.calls.createWorker).toBe(0);
  });

  test("rejects a deployment published while the user reviewed the plan before resource writes", async () => {
    const root = fixture({linked:true, resources:[{type:"kv_namespace",bindingName:"STATE"}]});
    const platform = fakePlatform({exists:true});
    await expect(pushWorkerProject({
      cwd:root, environment:"preview", client:platform.client,
      clientOptions:{apiHost:"localhost:3003",apiKey:"test-key"},
      runBuild:async()=>{
        mkdirSync(join(root,"dist"),{recursive:true});
        writeFileSync(join(root,"dist/worker.mjs"),"export default {fetch(){return new Response('ok')}}");
      },
      confirm:async()=>{
        platform.state.deployments.push({id:"newer-deployment",status:"ACTIVE",environment:"preview"});
        return true;
      },
    })).rejects.toThrow("changed");
    expect(platform.calls.createResource).toBe(0);
    expect(platform.calls.uploadArtifact).toBe(0);
    expect(platform.calls.deploy).toBe(0);
  });

  test("non-interactive mode fails a missing-Secret plan before any mutation", async () => {
    const root = fixture({ secrets: ["MODEL_KEY"] });
    const platform = fakePlatform();
    await expect(
      pushWorkerProject({
        cwd: root,
        environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        nonInteractive: true,
        runBuild: async () => {
          mkdirSync(join(root, "dist"), { recursive: true });
          writeFileSync(
            join(root, "dist/worker.mjs"),
            "export default {fetch(){return new Response('ok')}};",
          );
        },
      }),
    ).rejects.toThrow("requires reconciliation");
    expect(platform.calls.createWorker).toBe(0);
    expect(loadWorkerProject(root).config.workerId).toBeUndefined();
  });

  test("a declined interactive plan performs no mutation", async () => {
    const root = fixture();
    const platform = fakePlatform();
    await expect(
      pushWorkerProject({
        cwd: root,
        environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        confirm: async () => false,
        runBuild: async () => {
          mkdirSync(join(root, "dist"), { recursive: true });
          writeFileSync(
            join(root, "dist/worker.mjs"),
            "export default {fetch(){return new Response('ok')}};",
          );
        },
      }),
    ).rejects.toThrow("cancelled");
    expect(platform.calls.createWorker).toBe(0);
    expect(loadWorkerProject(root).config.workerId).toBeUndefined();
  });

  test("does not overwrite a concurrently edited project after remote creation", async () => {
    const root = fixture();
    const platform = fakePlatform();
    const originalCreate = platform.client.createWorker.bind(platform.client);
    platform.client.createWorker = async (...args) => {
      const created = await originalCreate(...args);
      const path = join(root, "xapi.worker.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.worker.description = "concurrent edit";
      writeFileSync(path, JSON.stringify(config, null, 2));
      return created;
    };
    let caught: WorkerPushError | undefined;
    try {
      await pushWorkerProject({
        cwd: root,
        environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        confirm: async () => true,
        runBuild: async () => {
          mkdirSync(join(root, "dist"), { recursive: true });
          writeFileSync(
            join(root, "dist/worker.mjs"),
            "export default {fetch(){return new Response('ok')}};",
          );
        },
      });
    } catch (error) {
      caught = error as WorkerPushError;
    }
    expect(caught?.message).toContain("changed concurrently");
    expect(caught?.recovery.workerId).toBe(workerId);
    const config = JSON.parse(
      readFileSync(join(root, "xapi.worker.json"), "utf8"),
    );
    expect(config.worker.description).toBe("concurrent edit");
    expect(config.workerId).toBeUndefined();
  });

  test("accepts the named default export emitted by esbuild", async () => {
    const root = fixture({ linked: true });
    const platform = fakePlatform({ exists: true });
    const result = await pushWorkerProject({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      confirm: async () => true,
      runBuild: async () => {
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(
          join(root, "dist/worker.mjs"),
          `const index_default = { async fetch() { return new Response("ok") } };\nexport { index_default as default };\n`,
        );
      },
      fetchPublic: (async () =>
        Response.json({ ok: true })) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(result.status).toBe("ACTIVE");
    expect(platform.calls.uploadArtifact).toBe(1);
    expect(platform.calls.deploy).toBe(1);
  });

  test("applies declared environment placement before preview deployment", async () => {
    const root = fixture({ linked: true });
    const path = join(root, "xapi.worker.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.environments.preview.defaultResourceLocation = "apac";
    config.environments.preview.placementMode = "smart";
    writeFileSync(path, JSON.stringify(config));
    const platform = fakePlatform({ exists: true });
    let update: Record<string, unknown> | undefined;
    platform.client.updateWorkerEnvironment = async (_options, _id, _environment, input) => {
      update = input;
      return input;
    };
    await pushWorkerProject({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      confirm: async () => true,
      runBuild: async () => {
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(join(root, "dist/worker.mjs"), "export default {};");
      },
      fetchPublic: (async () =>
        Response.json({ ok: true })) as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    expect(update).toEqual({
      dailyBudgetUsd: 0.25,
      defaultResourceLocation: "apac",
      placementMode: "smart",
    });
  });

  test("immutable Artifact upload can retry; an unconfirmed publish requires an explicit retry", async () => {
    const root = fixture({ linked: true });
    const platform = fakePlatform({ exists: true });
    const upload = platform.client.uploadWorkerArtifact.bind(platform.client);
    const deploy = platform.client.deployWorker.bind(platform.client);
    let uploadAttempts = 0;
    let deployAttempts = 0;
    platform.client.uploadWorkerArtifact = async (...args) => {
      uploadAttempts += 1;
      if (uploadAttempts === 1) {
        throw new HttpError(500, "transient artifact failure");
      }
      return upload(...args);
    };
    platform.client.deployWorker = async (...args) => {
      deployAttempts += 1;
      if (deployAttempts === 1) {
        throw new HttpError(500, "transient deployment failure");
      }
      return deploy(...args);
    };
    const options = {
      cwd: root,
      environment: "preview" as const,
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      confirm: async () => true,
      runBuild: async () => {
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(
          join(root, "dist/worker.mjs"),
          `export default { async fetch() { return new Response("ok") } };\n`,
        );
      },
      fetchPublic: (async () =>
        Response.json({ ok: true })) as unknown as typeof fetch,
      sleep: async () => undefined,
    };
    await expect(pushWorkerProject(options)).rejects.toThrow("No second publish was sent");
    expect(deployAttempts).toBe(1);
    const result = await pushWorkerProject(options);
    expect(result.status).toBe("ACTIVE");
    expect(uploadAttempts).toBe(2);
    expect(deployAttempts).toBe(2);
    expect(platform.calls.uploadArtifact).toBe(1);
    expect(platform.calls.deploy).toBe(1);
  });

  test("reports the failed build command and recovery when its executable is missing", async () => {
    const root = fixture({
      linked: true,
      buildCommand: "missing-package-manager-that-does-not-exist run build",
    });
    const platform = fakePlatform({ exists: true });
    let caught: WorkerPushError | undefined;
    try {
      await pushWorkerProject({
        cwd: root,
        environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        confirm: async () => true,
      });
    } catch (error) {
      caught = error as WorkerPushError;
    }
    expect(caught?.message).toContain("required executable was not found");
    expect(caught?.recovery.buildCommand).toBe(
      "missing-package-manager-that-does-not-exist run build",
    );
    expect(caught?.recovery.next).toContain("Install the package manager");
    expect(caught?.recovery.remoteChangesApplied).toBe(false);
    expect(platform.calls.createWorker).toBe(0);
    expect(platform.calls.createResource).toBe(0);
    expect(platform.calls.uploadArtifact).toBe(0);
    expect(platform.calls.deploy).toBe(0);
  });

  test("rejects a single-file output with an unresolved import before upload", async () => {
    const root = fixture({ linked: true });
    const platform = fakePlatform({ exists: true });
    let caught: WorkerPushError | undefined;
    try {
      await pushWorkerProject({
        cwd: root,
        environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        confirm: async () => true,
        runBuild: async () => {
          mkdirSync(join(root, "dist"), { recursive: true });
          writeFileSync(
            join(root, "dist/worker.mjs"),
            `import helper from "./chunk.mjs"; export default helper;`,
          );
        },
      });
    } catch (error) {
      caught = error as WorkerPushError;
    }
    expect(caught).toBeInstanceOf(WorkerPushError);
    expect(caught?.message).toContain("imports that are not in the Artifact");
    expect(caught?.recovery).toEqual(
      expect.objectContaining({ remoteChangesApplied: false }),
    );
    expect(platform.calls.createWorker).toBe(0);
    expect(platform.calls.createResource).toBe(0);
    expect(platform.calls.uploadArtifact).toBe(0);
    expect(platform.calls.deploy).toBe(0);
  });

  test("diagnoses a stale control-plane ingress when bundle upload returns 413", async () => {
    const root = fixture({ linked: true });
    const configPath = join(root, "xapi.worker.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.build = { command: "fake-build", output: "dist", main: "worker.mjs" };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const platform = fakePlatform({ exists: true });
    platform.client.uploadWorkerArtifact = async () => {
      throw new HttpError(413, "Request Entity Too Large");
    };

    let caught: WorkerPushError | undefined;
    try {
      await pushWorkerProject({
        cwd: root,
        environment: "preview",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        confirm: async () => true,
        runBuild: async () => {
          mkdirSync(join(root, "dist"), { recursive: true });
          writeFileSync(
            join(root, "dist/worker.mjs"),
            'import "./chunk.mjs"; export default {};',
          );
          writeFileSync(join(root, "dist/chunk.mjs"), "export {};");
        },
      });
    } catch (error) {
      caught = error as WorkerPushError;
    }

    expect(caught?.message).toContain("complete-project upload");
    expect(caught?.recovery).toEqual(
      expect.objectContaining({
        workerId,
        resourcesPreserved: true,
        errorCode: "worker_artifact_ingress_too_small",
        expectedIngressLimitMiB: 128,
      }),
    );
    expect(platform.calls.deploy).toBe(0);
  });

  test("uploads a code-split directory as one immutable Artifact", async () => {
    const root = fixture({ linked: true });
    const configPath = join(root, "xapi.worker.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.build = {
      command: "fake-build",
      output: "dist",
      main: "worker.mjs",
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    const platform = fakePlatform({ exists: true });
    let uploadInput: Record<string, unknown> | undefined;
    const upload = platform.client.uploadWorkerArtifact;
    platform.client.uploadWorkerArtifact = async (...args) => {
      uploadInput = args[2];
      return upload(...args);
    };

    const result = await pushWorkerProject({
      cwd: root,
      environment: "preview",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      confirm: async () => true,
      runBuild: async () => {
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(
          join(root, "dist/worker.mjs"),
          `import { message } from "./chunk.mjs"; export default { fetch() { return new Response(message) } };`,
        );
        writeFileSync(
          join(root, "dist/chunk.mjs"),
          `export const message = "ok";`,
        );
      },
      fetchPublic: (async () => new Response("ok")) as unknown as typeof fetch,
      sleep: async () => undefined,
    });

    expect(result.status).toBe("ACTIVE");
    expect(uploadInput).not.toHaveProperty("moduleCode");
    expect(uploadInput?.bundle).toEqual(
      expect.objectContaining({
        version: 1,
        mainModule: "worker.mjs",
        modules: expect.arrayContaining([
          expect.objectContaining({ path: "worker.mjs" }),
          expect.objectContaining({ path: "chunk.mjs" }),
        ]),
      }),
    );
    expect(platform.calls.uploadArtifact).toBe(1);
    expect(platform.calls.deploy).toBe(1);
  });
});
