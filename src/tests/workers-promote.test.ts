import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

for (const bindingName of ["STATE", "ASSETS"]) {
  test(`required Secret collision with ${bindingName} blocks promotion before resource/deployment writes`, async () => {
    const root = fixture();
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({
      compatibility_date: "2026-08-26",
      env: { production: { secrets: { required: [bindingName] },
        ...(bindingName === "ASSETS" ? { assets: { directory: "dist/client", binding: bindingName } } : {}) } },
    }));
    const platform = fakePlatform({ resources: [], secrets: ["MODEL_KEY", bindingName] });
    const options = { cwd: root, to: "production" as const, nonInteractive: true,
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" }, client: platform.client };
    await expect(createWorkerPromotionPlan(options)).rejects.toThrow(`Duplicate Worker binding: ${bindingName}`);
    await expect(promoteWorkerProject(options)).rejects.toThrow(`Duplicate Worker binding: ${bindingName}`);
    expect(platform.calls).toEqual({ createResource: 0, deploy: 0, health: 0 });
  });
}

test("promotion rejects required Secret collisions with immutable Artifact assets", async () => {
  const root = fixture();
  const path = join(root, "wrangler.jsonc");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.env.production.secrets = { required: ["ARTIFACT_ASSETS"] };
  writeFileSync(path, JSON.stringify(config));
  const platform = fakePlatform({ secrets: ["MODEL_KEY", "ARTIFACT_ASSETS"] });
  const declaration = platform.client.getWorkerArtifactVariableConfiguration;
  platform.client.getWorkerArtifactVariableConfiguration = async (...args) => ({
    ...await declaration(...args) as object, bindingNames: ["ARTIFACT_ASSETS"],
  });
  await expect(promoteWorkerProject({ cwd: root, to: "production", nonInteractive: true,
    clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" }, client: platform.client,
  })).rejects.toMatchObject({ message: "Duplicate Worker binding: ARTIFACT_ASSETS", recovery: { remoteChangesApplied: false } });
  expect(platform.calls).toEqual({ createResource: 0, deploy: 0, health: 0 });
});

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
    getWorkerArtifact: async (_options, _id, artifactId) => ({
      ...artifacts.find(artifact => artifact.id === artifactId), assetCount: 1,
    }),
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
  test.each([
    { keep_vars: false, artifactKeep: ['json'], expected: 'REMOVE' },
    { keep_vars: true, artifactKeep: [], expected: 'RETAIN' },
    { keep_vars: undefined, artifactKeep: ['json'], expected: 'REMOVE' },
  ])('plans public retention from the production request: $keep_vars', async ({ keep_vars, artifactKeep, expected }) => {
    const root = fixture();
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ keep_vars, env: { production: { vars: {} } } }));
    const platform = fakePlatform(), getWorker = platform.client.getWorker;
    platform.client.getWorker = async (...args) => {
      const worker = await getWorker(...args) as { artifacts: Array<Record<string, unknown>> };
      return { ...worker, artifacts: worker.artifacts.map(artifact => ({ ...artifact,
        mediaType: 'application/vnd.xapi.worker-bundle.v2+json' })) };
    };
    platform.client.getWorkerVariableState = async () => ({ environment: 'production',
      activeDeploymentId: null, exists: true, variables: [{ name: 'PROD_CONFIG', type: 'json' }] });
    platform.client.getWorkerArtifactVariableConfiguration = async () => ({ artifactId: 'artifact-latest',
      contentSha256: 'a'.repeat(64), keepBindings: artifactKeep, variables: [], bindingNames: [] });
    const requests: Array<Parameters<PromotionClient['deployWorker']>[2]> = [];
    const deploy = platform.client.deployWorker;
    platform.client.deployWorker = async (api, id, input) => { requests.push(input); return deploy(api, id, input); };
    await promoteWorkerProject({ cwd: root, to: 'production',
      clientOptions: { apiHost: 'localhost:3003', apiKey: 'test' }, client: platform.client,
      confirm: async plan => {
        expect(plan.variables).toContainEqual(expect.objectContaining({ name: 'PROD_CONFIG', decision: expected }));
        return true;
      }, sleep: async () => undefined, fetchPublic: (async () => Response.json({ ok: true })) as unknown as typeof fetch });
    expect(requests).toHaveLength(1);
    expect(requests[0].variables).toEqual({ vars: {} });
    expect(requests[0].nativeMetadata).toEqual(keep_vars === undefined ? {}
      : { keep_bindings: keep_vars ? ['plain_text', 'json'] : [], tail_consumers: [] });
  });

  test.each([0, 1])('cleared version Secret collision requires immutable proof of no assets: %s', async assetCount => {
    const root = fixture();
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ env: {
      preview: { version_metadata: { binding: 'RELEASE' } }, production: { secrets: { required: ['RELEASE'] } },
    } }));
    const platform = fakePlatform({ secrets: ['MODEL_KEY', 'RELEASE'] }), getWorker = platform.client.getWorker;
    platform.client.getWorker = async (...args) => {
      const worker = await getWorker(...args) as { artifacts: Array<Record<string, unknown>> };
      return { ...worker, artifacts: worker.artifacts.map(artifact => ({ ...artifact,
        mediaType: 'application/vnd.xapi.worker-bundle.v2+json' })) };
    };
    platform.client.getWorkerArtifactVariableConfiguration = async () => ({ artifactId: 'artifact-latest',
      contentSha256: 'a'.repeat(64), keepBindings: [], variables: [], bindingNames: ['RELEASE'] });
    platform.client.getWorkerArtifact = async () => ({ id: 'artifact-latest', contentSha256: 'a'.repeat(64), assetCount });
    const requests: Array<Parameters<PromotionClient['deployWorker']>[2]> = [];
    const deploy = platform.client.deployWorker;
    platform.client.deployWorker = async (api, id, input) => { requests.push(input); return deploy(api, id, input); };
    const options = { cwd: root, to: 'production' as const, nonInteractive: true,
      clientOptions: { apiHost: 'localhost:3003', apiKey: 'test' }, client: platform.client,
      sleep: async () => undefined, fetchPublic: (async () => Response.json({ ok: true })) as unknown as typeof fetch };
    if (assetCount === 0) {
      const result = await promoteWorkerProject(options);
      expect(result.plan.canPromote).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0].nativeMetadata).toEqual({});
      expect(requests[0].requiredSecrets).toEqual(['MODEL_KEY', 'RELEASE']);
    } else {
      await expect(promoteWorkerProject(options)).rejects.toMatchObject({
        message: 'Cannot distinguish immutable assets from cleared or replaced version bindings: RELEASE',
        recovery: { errorCode: 'worker_artifact_binding_metadata_unavailable', remoteChangesApplied: false },
      });
      expect(requests).toHaveLength(0);
    }
    expect(platform.calls.createResource).toBe(0);
  });

  test.each([
    { id: 'wrong', contentSha256: 'a'.repeat(64), assetCount: 0 },
    { id: 'artifact-latest', contentSha256: 'b'.repeat(64), assetCount: 0 },
    { id: 'artifact-latest', contentSha256: 'a'.repeat(64) },
  ])('does not clear Artifact bindings on missing or mismatched immutable metadata', async details => {
    const root = fixture();
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ version_metadata: { binding: 'NEW_VERSION' } }));
    const platform = fakePlatform();
    platform.client.getWorkerArtifactVariableConfiguration = async () => ({ artifactId: 'artifact-latest',
      contentSha256: 'a'.repeat(64), keepBindings: [], variables: [], bindingNames: ['OLD_VERSION'] });
    platform.client.getWorkerArtifact = async () => details;
    await expect(promoteWorkerProject({ cwd: root, to: 'production', nonInteractive: true,
      clientOptions: { apiHost: 'localhost:3003', apiKey: 'test' }, client: platform.client }))
      .rejects.toThrow('missing or mismatched Artifact asset metadata');
    expect(platform.calls.deploy).toBe(0);
    expect(platform.calls.createResource).toBe(0);
  });

  test('required Secrets still conflict with an effective production version binding', async () => {
    const root = fixture();
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ env: {
      production: { version_metadata: { binding: 'RELEASE' }, secrets: { required: ['RELEASE'] } },
    } }));
    const platform = fakePlatform({ secrets: ['MODEL_KEY', 'RELEASE'] });
    await expect(promoteWorkerProject({ cwd: root, to: 'production', nonInteractive: true,
      clientOptions: { apiHost: 'localhost:3003', apiKey: 'test' }, client: platform.client }))
      .rejects.toThrow('Duplicate Worker binding: RELEASE');
    expect(platform.calls.deploy).toBe(0);
    expect(platform.calls.createResource).toBe(0);
  });

  test('keeps supported production native fields expressible without a new build or workflow',async()=>{
    const root=fixture(),path=join(root,'wrangler.jsonc'),config=JSON.parse(readFileSync(path,'utf8'));
    const metadata={placement:{mode:'off'},limits:{cpu_ms:50},logpush:false,keep_assets:false,tags:['owner']};
    Object.assign(config.env.production,metadata);writeFileSync(path,JSON.stringify(config));
    const platform=fakePlatform(),requests:Array<Parameters<PromotionClient['deployWorker']>[2]>=[];
    const deploy=platform.client.deployWorker;
    platform.client.deployWorker=async(api,id,request)=>{requests.push(request);return deploy(api,id,request);};
    await promoteWorkerProject({cwd:root,to:'production',clientOptions:{apiHost:'localhost:3003',apiKey:'test'},
      client:platform.client,confirm:async()=>true,sleep:async()=>undefined,
      fetchPublic:(async()=>Response.json({ok:true})) as unknown as typeof fetch});
    expect(requests[0].nativeMetadata).toEqual(metadata);
    expect(platform.calls.deploy).toBe(1);
  });
  test.each(['future_option','services'])("rejects unrepresentable production %s before clearing metadata or making writes",async field=>{
    const root=fixture(),path=join(root,'wrangler.jsonc');
    const config=JSON.parse(readFileSync(path,'utf8'));
    config.env.production[field]=field==='services'?[{binding:'FOREIGN',service:'another-account'}]:{enabled:true};
    writeFileSync(path,JSON.stringify(config));
    const platform=fakePlatform();
    const options={cwd:root,to:'production' as const,nonInteractive:true,
      clientOptions:{apiHost:'localhost:3003',apiKey:'test'},client:platform.client};
    await expect(createWorkerPromotionPlan(options)).rejects.toMatchObject({recovery:{
      errorCode:'worker_production_configuration_unrepresentable',fields:[field],remoteChangesApplied:false}});
    await expect(promoteWorkerProject(options)).rejects.toThrow('production Wrangler configuration');
    expect(platform.calls).toEqual({createResource:0,deploy:0,health:0});
  });
  test.each([
    { artifactId: "artifact-latest", mediaType: "application/vnd.xapi.worker-bundle.v1+json", bundle: true },
    { artifactId: "artifact-older", mediaType: "application/vnd.xapi.worker-bundle.v2+json", bundle: true },
    { artifactId: "artifact-latest", mediaType: "application/javascript+module", bundle: false },
    { artifactId: "artifact-older", mediaType: undefined, bundle: false },
  ])("uses the selected Artifact media type in both production plan and request: $artifactId $mediaType", async ({ artifactId, mediaType, bundle }) => {
    const root = fixture();
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ name: "promote-agent",
      env: { preview: { vars: { PREVIEW_ONLY: "preview-marker" }, limits: { cpu_ms: 10 } } } }));
    const platform = fakePlatform();
    const getWorker = platform.client.getWorker;
    platform.client.getWorker = async (...args) => {
      const worker = await getWorker(...args) as { artifacts: Array<Record<string, unknown>> };
      return { ...worker, artifacts: worker.artifacts.map(artifact => ({ ...artifact,
        mediaType: artifact.id === artifactId ? mediaType : "application/vnd.xapi.worker-bundle.v2+json" })) };
    };
    const getVariables = platform.client.getWorkerArtifactVariableConfiguration;
    platform.client.getWorkerArtifactVariableConfiguration = async (...args) => ({
      ...await getVariables(...args) as Record<string, unknown>, variables: [{ name: "PREVIEW_ONLY", type: "plain_text" }] });
    const requests: Array<Parameters<PromotionClient["deployWorker"]>[2]> = [];
    const deploy = platform.client.deployWorker;
    platform.client.deployWorker = async (api, id, request) => { requests.push(request); return deploy(api, id, request); };
    const result = await promoteWorkerProject({ cwd: root, to: "production", artifactId,
      clientOptions: { apiHost: "localhost:3003", apiKey: "test" }, client: platform.client,
      confirm: async () => true, sleep: async () => undefined,
      fetchPublic: (async () => Response.json({ ok: true })) as unknown as typeof fetch });
    expect(requests).toHaveLength(1);
    expect(requests[0].artifactId).toBe(artifactId);
    expect(requests[0].nativeMetadata).toEqual(bundle ? {} : undefined);
    expect(requests[0].queueBindingAliases).toEqual(bundle ? {} : undefined);
    expect(requests[0].variables).toEqual(bundle ? { vars: {} } : undefined);
    expect(result.plan.variables?.map(variable => variable.name)).toEqual(bundle ? [] : ["PREVIEW_ONLY"]);
    expect(JSON.stringify(requests)).not.toContain("cpu_ms");
  });

  for (const recovers of [true, false]) {
    test(`initial access authorization ${recovers ? "recovers" : "times out"} without another deployment`, async () => {
      const platform = fakePlatform();
      const options = {
        cwd: fixture(), to: "production" as const, nonInteractive: true,
        clientOptions: { apiHost: "localhost:3003", apiKey: "test" }, client: platform.client,
        sleep: async () => undefined,
        fetchPublic: (async (_input, _init) => {
          platform.calls.health++;
          return recovers && platform.calls.health === 66 ? Response.json({ ok: true })
            : Response.json({ error: { code: "workers_postpaid_state_unavailable" } }, { status: 503 });
        }) as typeof fetch,
      };
      if (recovers) {
        const result = await promoteWorkerProject(options);
        expect(result.health.attempts).toBe(66);
        expect(result.health.status).toBe(200);
      } else {
        let failure: unknown;
        try { await promoteWorkerProject(options); } catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(WorkerPushError);
        expect((failure as WorkerPushError).recovery).toMatchObject({
          releasedDeploymentId: "production-deployment", deploymentStatus: "ACTIVE",
          healthReady: false, lastErrorCode: "workers_postpaid_state_unavailable", attempts: 75,
        });
        expect((failure as WorkerPushError).recovery.recovery).toContain("read-only GET");
      }
      expect(platform.calls.deploy).toBe(1);
      expect(platform.productionDeployments).toHaveLength(1);
      expect(platform.productionDeployments[0].status).toBe("ACTIVE");
    });
  }

  test("uses selected immutable Artifact vars when production variables override is undefined", async () => {
    const root = fixture();
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ name: "promote-agent", keep_vars: false,
      env: { preview: { vars: { LOCAL_ONLY: "private-marker" } } } }));
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
      { name: "RETAIN_JSON", decision: "REMOVE" }, { name: "STATE", decision: "REPLACE" }, { name: "VERSION", decision: "REPLACE" },
    ]);
    expect(plan.variables).toContainEqual(expect.objectContaining({ name: "JSON_STRING", type: "json" }));
    expect(JSON.stringify(plan)).not.toContain("LOCAL_ONLY");
    expect(JSON.stringify(plan)).not.toContain("private-marker");
    expect(JSON.stringify(plan)).not.toContain("private-env-marker");
    expect(plan.canPromote).toBe(true);
    expect(platform.calls.deploy).toBe(0);
  });

  test("keeps explicit empty variable decisions when production clears Artifact vars and has no current vars", async () => {
    const root = fixture();
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ name: "promote-agent", env: { production: { vars: {} } } }));
    const platform = fakePlatform();
    platform.client.getWorkerArtifactVariableConfiguration = async () => ({ artifactId: "artifact-latest",
      contentSha256: "a".repeat(64), keepBindings: [], variables: [{ name: "PREVIEW_ONLY", type: "plain_text" }], bindingNames: [] });
    const { plan } = await createWorkerPromotionPlan({ cwd: root, to: "production",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test" }, client: platform.client });
    expect(JSON.parse(JSON.stringify(plan)).variables).toEqual([]);
    expect(plan.canPromote).toBe(true);
    expect(platform.calls.deploy).toBe(0);
  });

  test.each([
    { label: "different production vars", production: { vars: { PROD_ONLY: "production-value-marker", CHANGED: { enabled: true } } },
      variables: [{ name: "CHANGED", decision: "REPLACE", type: "json" }, { name: "PREVIEW_ONLY", decision: "REMOVE" }, { name: "PROD_ONLY", decision: "SET", type: "plain_text" }] },
    { label: "explicit empty production vars", production: { vars: {} },
      variables: [{ name: "CHANGED", decision: "REMOVE" }, { name: "PREVIEW_ONLY", decision: "REMOVE" }] },
    { label: "omitted vars in named production environment", production: {},
      variables: [{ name: "CHANGED", decision: "REMOVE" }, { name: "PREVIEW_ONLY", decision: "REMOVE" }] },
  ])("confirmation plan matches the deployed variables override: $label", async ({ production, variables }) => {
    const root = fixture();
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ name: "promote-agent",
      env: { preview: { vars: { PREVIEW_ONLY: "preview-value-marker" } }, production } }));
    const platform = fakePlatform();
    platform.client.getWorkerVariableState = async () => ({ environment: "production", activeDeploymentId: null,
      exists: true, variables: [{ name: "PREVIEW_ONLY", type: "plain_text" }, { name: "CHANGED", type: "plain_text" }] });
    platform.client.getWorkerArtifactVariableConfiguration = async () => ({ artifactId: "artifact-latest",
      contentSha256: "a".repeat(64), keepBindings: [], variables: [{ name: "PREVIEW_ONLY", type: "plain_text" }], bindingNames: [] });
    const requests: Array<Parameters<PromotionClient["deployWorker"]>[2]> = [];
    const deploy = platform.client.deployWorker;
    platform.client.deployWorker = async (api, id, request) => { requests.push(request); return deploy(api, id, request); };
    const result = await promoteWorkerProject({ cwd: root, to: "production",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test" }, client: platform.client,
      confirm: async plan => {
        expect(plan.variables?.map(({ name, decision, type }) => ({ name, decision, ...(type ? { type } : {}) }))).toEqual([...variables]);
        expect(JSON.stringify(plan)).not.toContain("production-value-marker");
        expect(JSON.stringify(plan)).not.toContain("preview-value-marker");
        if ("PROD_ONLY" in (production.vars || {}))
          expect(plan.variables?.find(variable => variable.name === "PROD_ONLY")?.message).toContain("production configuration");
        return true;
      }, sleep: async () => undefined, fetchPublic: (async () => Response.json({ ok: true })) as unknown as typeof fetch });
    expect(result.status).toBe("ACTIVE");
    expect(requests).toHaveLength(1);
    expect(requests[0].variables).toEqual({ vars: production.vars || {} });
  });

  test.each(["STATE", "MODEL_KEY", "VERSION", "ENV_CONFIG"])("checks variable collisions against the effective production override: %s", async name => {
    const root = fixture();
    const platform = fakePlatform({ bindings: [{ name: "ENV_CONFIG", type: "plain_text", text: "environment-value-marker" }] });
    let artifactName: string = name;
    platform.client.getWorkerArtifactVariableConfiguration = async () => ({ artifactId: "artifact-latest",
      contentSha256: "a".repeat(64), keepBindings: [], variables: [{ name: artifactName, type: "plain_text" }], bindingNames: ["VERSION"] });
    const configure = (vars: Record<string, unknown>) => writeFileSync(join(root, "wrangler.jsonc"),
      JSON.stringify({ name: "promote-agent", env: { production: { vars } } }));
    const options = { cwd: root, to: "production" as const, nonInteractive: true,
      clientOptions: { apiHost: "localhost:3003", apiKey: "test" }, client: platform.client };
    configure({ PROD_ONLY: "production-value-marker" });
    const { plan } = await createWorkerPromotionPlan(options);
    expect(plan.canPromote).toBe(true);
    expect(plan.variables).toContainEqual(expect.objectContaining({ name: "PROD_ONLY", decision: "SET" }));
    expect(plan.variables?.some(variable => variable.name === name && name !== "ENV_CONFIG")).toBe(false);
    artifactName = "PREVIEW_ONLY";
    configure({ [name]: "production-value-marker" });
    await expect(promoteWorkerProject(options)).rejects.toThrow("conflicts with an");
    expect(platform.calls.deploy).toBe(0);
    expect(platform.calls.createResource).toBe(0);
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

  test("promote binds production D1 without executing or validating its SQL migrations", async () => {
    const root = fixture();
    const project = JSON.parse(readFileSync(join(root, "xapi.worker.json"), "utf8"));
    project.environments.production.resources = [{ type: "d1_database", bindingName: "DB" }];
    writeFileSync(join(root, "xapi.worker.json"), JSON.stringify(project));
    const wrangler = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
    wrangler.env.production.d1_databases = [{ binding: "DB", migrations_dir: "absent-sql" }];
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(wrangler));
    const platform = fakePlatform({ resources: [{ id: "db-prod", bindingName: "DB", type: "D1_DATABASE", status: "ACTIVE" }] });
    let sqlCalls = 0;
    Object.assign(platform.client, { applyWorkerD1Migration: async () => { sqlCalls++; throw new Error("Must not execute SQL"); } });
    const result = await promoteWorkerProject({
      cwd: root, to: "production", clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client, confirm: async () => true,
      fetchPublic: (async () => Response.json({ ok: true })) as unknown as typeof fetch, sleep: async () => undefined,
    });
    expect(result.status).toBe("ACTIVE");
    expect(platform.calls.deploy).toBe(1);
    expect(sqlCalls).toBe(0);
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

  test.each([true, false])("surfaces path-fallback review for static web apps (explicit xAPI assets: %s)", async (explicitAssets) => {
    const root = fixture({ assets: explicitAssets });
    if (!explicitAssets) {
      const path = join(root, "wrangler.jsonc");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.assets = { directory: "dist/client", binding: "ASSETS", not_found_handling: "single-page-application" };
      writeFileSync(path, JSON.stringify(config));
    }
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


test("production preflight blocks a Wrangler-only missing required Secret", async () => {
  const root=fixture();
  writeFileSync(join(root,"wrangler.jsonc"),JSON.stringify({name:"promote-agent",env:{production:{secrets:{required:["WRANGLER_ONLY"]}}}}));
  const platform=fakePlatform();
  const options={cwd:root,to:"production" as const,clientOptions:{apiHost:"localhost:3003",apiKey:"test"},client:platform.client};
  const {plan}=await createWorkerPromotionPlan(options);
  expect(plan.canPromote).toBe(false);
  expect(plan.production.checks).toContainEqual(expect.objectContaining({key:"WRANGLER_ONLY",kind:"secret",status:"BLOCKED"}));
  await expect(promoteWorkerProject({...options,nonInteractive:true})).rejects.toThrow();
  expect(platform.calls.deploy).toBe(0);
});

test("production vars collide with Wrangler-only required Secrets before changes", async () => {
  const root=fixture();
  writeFileSync(join(root,"wrangler.jsonc"),JSON.stringify({name:"promote-agent",env:{production:{secrets:{required:["WRANGLER_ONLY"]},vars:{WRANGLER_ONLY:"public"}}}}));
  const platform=fakePlatform({secrets:["MODEL_KEY","WRANGLER_ONLY"]});
  await expect(createWorkerPromotionPlan({cwd:root,to:"production",clientOptions:{apiHost:"localhost:3003",apiKey:"test"},client:platform.client})).rejects.toThrow("conflicts with an");
  expect(platform.calls.deploy).toBe(0);
});
