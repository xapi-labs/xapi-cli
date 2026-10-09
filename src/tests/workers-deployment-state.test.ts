import { expect, test } from "bun:test";
import { ensureActiveDeployment } from "../workers-push.ts";
import { deploymentPrefix, deploymentKey, safeDeploymentRetryKey } from "../workers-deployment-state.ts";
import { RequestTimeoutError } from "../client.ts";

function platform() {
  const environment = { id: "env", name: "PREVIEW", activeDeploymentId: null as string | null, bindings: [], placementMode: "off" };
  const resources: Record<string, unknown>[] = [];
  const secrets: Record<string, unknown>[] = [];
  const deployments: Record<string, unknown>[] = [];
  let failOnce = false;
  const api = {
    getWorker: async () => ({ id: "worker", environments: [environment], deployments }),
    listWorkerResources: async () => resources,
    listWorkerSecrets: async () => secrets,
    deployWorker: async (_options: unknown, _id: string, input: Record<string, unknown>) => {
      const d = { ...input, id: `d${deployments.length}`, environmentId: "env", status: "ACTIVE" };
      deployments.push(d);
      environment.activeDeploymentId = d.id;
      if (failOnce) { failOnce = false; throw new RequestTimeoutError(1000); }
      return d;
    },
  };
  const run = (date = "2026-09-07", artifact = "same-artifact") => ensureActiveDeployment(api, { apiHost: "localhost:3148", apiKey: "test" }, "worker", artifact,
    "preview", { compatibilityDate: date, compatibilityFlags: [] }, async () => {},undefined,undefined,undefined,true);
  return { api, run, resources, secrets, deployments, environment, uncertain: () => { failOnce = true; } };
}

test("same code: add, replace and explicitly remove bindings deploy; unchanged repeats do not", async () => {
  const p = platform();
  const first = await p.run();
  expect((await p.run()).deployment.id).toBe(first.deployment.id);
  p.resources.push({ id: "resource", bindingName: "STATE", type: "KV_NAMESPACE", status: "ACTIVE", providerResourceId: "kv1" });
  const added = await p.run();
  expect(added.deployment.id).not.toBe(first.deployment.id);
  expect((await p.run()).deployment.id).toBe(added.deployment.id);
  p.resources[0].providerResourceId = "kv2";
  const replaced = await p.run();
  expect(replaced.deployment.id).not.toBe(added.deployment.id);
  p.resources.length = 0;
  const removed = await p.run();
  expect(removed.deployment.id).not.toBe(first.deployment.id);
  expect((await p.run()).deployment.id).toBe(removed.deployment.id);
  expect(p.deployments).toHaveLength(4);
});

test("compatibility changes deploy; independent Secret changes do not redeploy code", async () => {
  const p = platform();
  await p.run();
  await p.run("2026-09-06");
  p.secrets.push({ bindingName: "TOKEN", version: 1 });
  await p.run("2026-09-06");
  p.secrets[0].version = 2;
  await p.run("2026-09-06");
  await p.run("2026-09-06");
  expect(p.deployments).toHaveLength(2);
  expect(new Set(p.deployments.map(d => d.artifactId)).size).toBe(1);
});

test("historical ACTIVE artifact is not mistaken for the current activation; lost response reconciles", async () => {
  const p = platform();
  await p.run();
  await p.run("2026-09-07", "other-artifact");
  p.uncertain();
  const restored = await p.run();
  expect(restored.deployment.id).toBe("d2");
  expect((await p.run()).deployment.id).toBe("d2");
  expect(p.deployments).toHaveLength(3);
  expect(restored.idempotencyKey.length).toBeLessThanOrEqual(128);
});

test("fingerprint ignores polling noise and resource order, but includes environment bindings", () => {
  const fingerprint = (resources: Record<string, unknown>[], bindings: unknown[] = []) =>
    deploymentPrefix("worker", "preview", "artifact", {}, { bindings }, resources, []);
  const a = { id: "1", bindingName: "A", type: "D1_DATABASE", status: "ACTIVE", config: { file_size: 10 } };
  const b = { id: "2", bindingName: "B", type: "KV_NAMESPACE", status: "ACTIVE" };
  expect(fingerprint([a, b])).toBe(fingerprint([b, { ...a, updatedAt: "later", config: { file_size: 20 } }]));
  expect(fingerprint([a])).not.toBe(fingerprint([a], [{ type: "plain_text", name: "MODE", text: "new" }]));
});


test("placement changes deploy the same artifact once, including returning to off", async () => {
  const p = platform();
  const first = await p.run();
  p.environment.placementMode = "smart";
  const smart = await p.run();
  expect(smart.deployment.id).not.toBe(first.deployment.id);
  expect((await p.run()).deployment.id).toBe(smart.deployment.id);
  p.environment.placementMode = "off";
  const off = await p.run();
  expect(off.deployment.id).not.toBe(smart.deployment.id);
  expect(off.deployment.id).not.toBe(first.deployment.id);
  expect((await p.run()).deployment.id).toBe(off.deployment.id);
  expect(p.deployments).toHaveLength(3);
});

test("missing placement uses the native off default", () => {
  const prefix = (state: Record<string, unknown>) => deploymentPrefix("worker", "preview", "artifact", {}, state, [], []);
  expect(prefix({})).toBe(prefix({ placementMode: "off" }));
  expect(prefix({})).not.toBe(prefix({ placementMode: "smart" }));
});

function failedAttempt() {
  const environment = { id: "env", name: "PREVIEW", activeDeploymentId: null };
  const prefix = deploymentPrefix("worker", "preview", "artifact", {}, environment, [], []);
  const baseKey = deploymentKey(prefix, environment);
  const failed: Record<string, any> = {
    id: "failed-1", environmentId: "env", artifactId: "artifact", idempotencyKey: baseKey,
    status: "FAILED", deployedAt: null, errorCode: "worker_control_cancelled_before_dispatch",
    providerResult: { controlOperationId: "operation-1" },
    outcome: { operationId: "operation-1", execution: "FAILED", providerEffect: "NOT_DISPATCHED",
      steps: [{ id: "upload", state: "SKIPPED", evidence: null }], supersededBy: null, observation: null },
  };
  const deployments: Record<string, any>[] = [failed];
  const posts: Record<string, unknown>[] = [];
  let reads = 0;
  const api = {
    getWorker: async () => {
      reads++;
      return { id: "worker", environments: [environment], deployments: deployments.slice(-20).reverse() };
    },
    listWorkerResources: async () => [],
    listWorkerSecrets: async () => [],
    deployWorker: async (_options: unknown, _id: string, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
      posts.push(input);
      const receipt = { ...input, id: `retry-${posts.length}`, environmentId: "env", status: "ACTIVE" };
      deployments.push(receipt);
      return receipt;
    },
  };
  const run = (retrySafeFailures = true) => ensureActiveDeployment(api,
    { apiHost: "localhost:3148", apiKey: "test" }, "worker", "artifact", "preview", { compatibilityFlags: [] },
    async () => { throw new Error("poll only; no automatic publish"); }, "accepted-price", [], null, retrySafeFailures);
  return { failed, deployments, posts, api, run, baseKey, environment, reads: () => reads };
}

for (const effect of ["NOT_DISPATCHED", "NO_WRITES"]) {
  test(`FAILED_SAFE / ${effect}: explicit retry uses a deterministic new key and the same artifact`, async () => {
    const p = failedAttempt();
    p.failed.outcome.providerEffect = effect;
    const result = await p.run();
    expect(p.posts).toHaveLength(1);
    expect(p.posts[0]).toMatchObject({ artifactId: "artifact", environment: "preview", retentionPriceVersion: "accepted-price", expectedActiveDeploymentId: null });
    expect(result.idempotencyKey).not.toBe(p.baseKey);
    expect(result.idempotencyKey.length).toBeLessThanOrEqual(128);
    const independent = failedAttempt();
    independent.failed.outcome.providerEffect = effect;
    independent.failed.updatedAt = "a different polling timestamp";
    expect((await independent.run()).idempotencyKey).toBe(result.idempotencyKey);
    expect((await p.run()).deployment.id).toBe(result.deployment.id);
    expect(p.posts).toHaveLength(1);
  });
}

for (const [name, change] of [
  ["UNKNOWN step despite safe summary", (d: any) => { d.outcome.steps[0].state = "UNKNOWN"; }],
  ["DISPATCHING step despite safe summary", (d: any) => { d.outcome.steps[0].state = "DISPATCHING"; }],
  ["confirmed late write", (d: any) => { d.outcome.steps[0].evidence = "LATE_PROVIDER_RECEIPT"; }],
  ["unconfirmed effect", (d: any) => { d.outcome.providerEffect = "UNCONFIRMED"; }],
  ["execution in progress", (d: any) => { d.outcome.execution = "IN_PROGRESS"; }],
  ["deployment still executing", (d: any) => { d.status = "DEPLOYING"; }],
  ["UNKNOWN deployment", (d: any) => { d.status = "UNKNOWN"; }],
  ["missing evidence", (d: any) => { delete d.outcome; }],
  ["mismatched operation", (d: any) => { d.outcome.operationId = "other"; }],
  ["superseded operation", (d: any) => { d.outcome.supersededBy = "new-operation"; }],
  ["observed activation", (d: any) => { d.outcome.observation = { status: "MATCH" }; }],
] as const) {
  test(`${name}: no new deployment POST`, async () => {
    const p = failedAttempt();
    change(p.failed);
    await expect(p.run()).rejects.toThrow();
    expect(p.posts).toHaveLength(0);
  });
}

test("safe retry behavior is opt-in for push; other deployment callers retain their behavior", async () => {
  const p = failedAttempt();
  await expect(p.run(false)).rejects.toThrow("Worker deployment failed");
  expect(p.posts).toHaveLength(0);
});

test("a lost retry response reconciles the derived key without a second POST", async () => {
  const p = failedAttempt();
  const deploy = p.api.deployWorker;
  p.api.deployWorker = async (...args) => {
    await deploy(...args);
    throw new RequestTimeoutError(1000);
  };
  const result = await p.run();
  expect(result.deployment.id).toBe("retry-1");
  expect(p.posts).toHaveLength(1);
  expect((await p.run()).idempotencyKey).toBe(result.idempotencyKey);
  expect(p.posts).toHaveLength(1);
});

test("disconnect with no visible receipt reuses the same derived key on the next explicit push", async () => {
  const p = failedAttempt();
  const deploy = p.api.deployWorker;
  let lostKey = "";
  p.api.deployWorker = async (_options, _id, input) => {
    lostKey = String(input.idempotencyKey);
    throw new RequestTimeoutError(1000);
  };
  await expect(p.run()).rejects.toThrow("No second publish was sent");
  p.api.deployWorker = deploy;
  expect((await p.run()).idempotencyKey).toBe(lostKey);
  expect(p.posts).toHaveLength(1);
});

test("a retry that fails safely stops; only a later invocation advances to another stable key", async () => {
  const p = failedAttempt();
  p.api.deployWorker = async (_options, _id, input) => {
    p.posts.push(input);
    const receipt = { ...p.failed, ...input, id: `failed-${p.posts.length + 1}`,
      providerResult: { controlOperationId: `operation-${p.posts.length + 1}` },
      outcome: { ...p.failed.outcome, operationId: `operation-${p.posts.length + 1}` } };
    p.deployments.push(receipt);
    return receipt;
  };
  await expect(p.run()).rejects.toThrow("Worker deployment failed");
  expect(p.posts).toHaveLength(1);
  await expect(p.run()).rejects.toThrow("Worker deployment failed");
  expect(p.posts).toHaveLength(2);
  expect(p.posts[1].idempotencyKey).not.toBe(p.posts[0].idempotencyKey);
  expect(String(p.posts[1].idempotencyKey).length).toBeLessThanOrEqual(128);
});

test("an existing retry with an unknown provider result blocks traversal past the original safe failure", async () => {
  const p = failedAttempt();
  p.deployments.push({ ...p.failed, id: "retry-unknown", idempotencyKey: safeDeploymentRetryKey(p.baseKey, p.failed),
    outcome: { ...p.failed.outcome, execution: "TIMED_OUT", providerEffect: "UNCONFIRMED",
      steps: [{ id: "upload", state: "UNKNOWN" }] } });
  await expect(p.run()).rejects.toThrow("Worker deployment failed");
  expect(p.posts).toHaveLength(0);
  expect(p.reads()).toBe(1);
});

test("latest safe attempt in bounded history needs one snapshot, without the original or a failure-count limit", async () => {
  const p = failedAttempt();
  let latest = p.failed;
  for (let i = 2; i <= 35; i++) {
    latest = { ...p.failed, id: `failed-${i}`, idempotencyKey: safeDeploymentRetryKey(p.baseKey, latest),
      providerResult: { controlOperationId: `operation-${i}` },
      outcome: { ...p.failed.outcome, operationId: `operation-${i}` } };
    p.deployments.push(latest);
  }
  const expectedKey = safeDeploymentRetryKey(p.baseKey, latest);
  if (!expectedKey) throw new Error("fixture must provide a safe terminal receipt");
  expect((await p.run()).idempotencyKey).toBe(expectedKey);
  expect(p.posts).toHaveLength(1);
  expect(p.reads()).toBe(1);
});

test("newer receipts from another environment, artifact or activation baseline do not choose this retry key", async () => {
  const p = failedAttempt();
  const expectedKey = safeDeploymentRetryKey(p.baseKey, p.failed);
  if (!expectedKey) throw new Error("fixture must provide a safe terminal receipt");
  for (const change of [
    { environmentId: "other-env" },
    { artifactId: "other-artifact" },
    { idempotencyKey: deploymentKey(p.baseKey.slice(0, -32), { activeDeploymentId: "other-activation" }) },
  ]) {
    p.deployments.push({ ...p.failed, id: "unrelated-failure", ...change });
  }
  expect((await p.run()).idempotencyKey).toBe(expectedKey);
  expect(p.posts).toHaveLength(1);
  expect(p.reads()).toBe(1);
});

test("latest in-progress retry is polled with its existing key without a new POST", async () => {
  const p = failedAttempt();
  p.deployments.push({ ...p.failed, id: "pending-retry", status: "DEPLOYING",
    idempotencyKey: safeDeploymentRetryKey(p.baseKey, p.failed),
    outcome: { ...p.failed.outcome, execution: "IN_PROGRESS", providerEffect: "UNCONFIRMED",
      steps: [{ id: "upload", state: "DISPATCHING" }] } });
  await expect(p.run()).rejects.toThrow("poll only; no automatic publish");
  expect(p.posts).toHaveLength(0);
  expect(p.reads()).toBe(1);
});

test("an explicit retry of known undispatched FAILED intent gets a fresh identity without changing source", async () => {
  const p = platform(); const deploy = p.api.deployWorker; const keys: string[] = [];
  p.api.deployWorker = async (options, id, input) => {
    keys.push(String(input.idempotencyKey));
    if (keys.length === 1) {
      const failure = {...input,id:'before-provider',environmentId:'env',status:'FAILED',createdAt:'2026-10-06T10:00:00Z',providerResult:{controlOperationId:'unsent-op'},outcome:{operationId:'unsent-op',providerEffect:'NOT_DISPATCHED',execution:'FAILED',steps:[{state:'SKIPPED'}],automaticReplay:false}};
      p.deployments.push(failure); return failure;
    }
    return deploy(options,id,input);
  };
  await expect(p.run()).rejects.toThrow('deployment failed');
  const retried = await p.run();
  expect(retried.deployment.status).toBe('ACTIVE');
  expect(keys).toHaveLength(2);expect(keys[1]).not.toBe(keys[0]);expect(keys[1].length).toBeLessThanOrEqual(128);
  expect((await p.run()).deployment.id).toBe(retried.deployment.id);expect(keys).toHaveLength(2);
});

test("lost retry response preserves the new attempt key until its original journal is visible", async () => {
  const p = platform(); const keys:string[]=[]; const deploy = p.api.deployWorker;
  p.api.deployWorker = async (options,id,input) => {
    keys.push(String(input.idempotencyKey));
    if (keys.length === 1) { const failure={...input,id:'unsent',environmentId:'env',status:'FAILED',providerResult:{controlOperationId:'known-unsent'},outcome:{operationId:'known-unsent',providerEffect:'NOT_DISPATCHED',execution:'FAILED',steps:[{state:'SKIPPED'}]}};p.deployments.push(failure);return failure; }
    if(keys.length === 2)throw new RequestTimeoutError(1000);
    return deploy(options,id,input);
  };
  await expect(p.run()).rejects.toThrow('deployment failed');
  await expect(p.run()).rejects.toThrow();
  await p.run();expect(keys).toHaveLength(3);expect(keys[2]).toBe(keys[1]);expect(keys[1]).not.toBe(keys[0]);
});

test("unknown or partially confirmed FAILED writes reconcile the original journal and never submit a new deployment", async () => {
  for(const effect of ['UNCONFIRMED','PARTIAL_WRITES_CONFIRMED','ALL_WRITES_CONFIRMED']) {
    const p=platform();const deployed=await p.run();p.environment.activeDeploymentId=null;
    Object.assign(deployed.deployment,{status:'FAILED',outcome:{operationId:'original-op',providerEffect:effect}});
    let recovered=0;let sent=0;
    const api={...p.api,recoverWorkerControlOperation:async(_options:unknown,_id:string,operationId:string)=>{expect(operationId).toBe('original-op');recovered++;return{outcome:{providerEffect:effect}};},deployWorker:async()=>{sent++;throw Error('unsafe replay');}};
    await expect(ensureActiveDeployment(api,{apiHost:'localhost:3148',apiKey:'test'},'worker','same-artifact','preview',{compatibilityDate:'2026-09-07',compatibilityFlags:[]},async()=>{})).rejects.toThrow('deployment failed');
    expect(recovered).toBe(1);expect(sent).toBe(0);expect(p.deployments).toHaveLength(1);
  }
});


test('environment Container overrides retain identity on reads and change identity on a real specification change', async () => {
  const p=platform();
  const declaration=(instanceType:'lite'|'basic')=>[{name:'app',className:'AppContainer',image:'docker.io/library/nginx:alpine',instanceType,maxInstances:1,rolloutActiveGracePeriod:0}];
  const run=(containers:ReturnType<typeof declaration>)=>ensureActiveDeployment(p.api,{apiHost:'localhost:3148',apiKey:'test'},'worker','same-artifact','preview',{compatibilityFlags:[]},async()=>{},undefined,[],undefined,false,containers);
  const first=await run(declaration('lite'));
  expect((await run(declaration('lite'))).deployment.id).toBe(first.deployment.id);
  const changed=await run(declaration('basic'));
  expect(changed.deployment.id).not.toBe(first.deployment.id);
  expect(p.deployments[1]?.containers).toEqual(declaration('basic'));
  expect((await run(declaration('basic'))).deployment.id).toBe(changed.deployment.id);
  expect(p.deployments).toHaveLength(2);
});


test('removing a declaration unbinds the live resource and keeps the remote resource intact',async()=>{
  const p=platform();
  p.resources.push({id:'a',bindingName:'A',type:'KV_NAMESPACE',status:'ACTIVE',providerResourceId:'kv-a'},{id:'b',bindingName:'B',type:'KV_NAMESPACE',status:'ACTIVE',providerResourceId:'kv-b'});
  const run=(names:string[])=>ensureActiveDeployment(p.api,{apiHost:'localhost:3148',apiKey:'test'},'worker','same-artifact','preview',{compatibilityFlags:[]},async()=>{},undefined,names);
  const initial=await run(['A','B']);
  const removed=await run(['A']);
  expect(removed.deployment.id).not.toBe(initial.deployment.id);
  expect(p.deployments[1]?.resourceIds).toEqual(['a']);
  expect((await run(['A'])).deployment.id).toBe(removed.deployment.id);
  expect(p.resources).toHaveLength(2);
});

test('Queue alias overrides change deployment identity without changing resources or Artifact', async () => {
  const p = platform();
  p.resources.push({id:'one-queue',bindingName:'ONE',type:'QUEUE',status:'ACTIVE',providerResourceId:'native-queue'});
  const run = (queueBindingAliases: Record<string,string>) => ensureActiveDeployment(p.api,{apiHost:'localhost:3148',apiKey:'test'},'worker','same-artifact','preview',
    {compatibilityDate:'2026-10-08',compatibilityFlags:[],queueBindingAliases},async()=>{});
  const first = await run({TWO:'ONE',THREE:'ONE'});
  expect((await run({THREE:'ONE',TWO:'ONE'})).deployment.id).toBe(first.deployment.id);
  const removed = await run({});
  expect(removed.deployment.id).not.toBe(first.deployment.id);
  expect(p.deployments[1].queueBindingAliases).toEqual({});
  expect((await run({})).deployment.id).toBe(removed.deployment.id);
  expect(p.resources).toHaveLength(1);
  expect(new Set(p.deployments.map(d=>d.artifactId)).size).toBe(1);
});
