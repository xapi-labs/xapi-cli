import { expect, test } from "bun:test";
import { ensureActiveDeployment } from "../workers-push.ts";
import { deploymentPrefix } from "../workers-deployment-state.ts";
import { RequestTimeoutError } from "../client.ts";

function platform() {
  const environment = { id: "env", name: "PREVIEW", activeDeploymentId: null as string | null, bindings: [] };
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
    "preview", { compatibilityDate: date, compatibilityFlags: [] }, async () => {});
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

test("compatibility and secret versions change the deployment, not the Artifact", async () => {
  const p = platform();
  await p.run();
  await p.run("2026-09-06");
  p.secrets.push({ bindingName: "TOKEN", version: 1 });
  await p.run("2026-09-06");
  p.secrets[0].version = 2;
  await p.run("2026-09-06");
  await p.run("2026-09-06");
  expect(p.deployments).toHaveLength(4);
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


test("an explicit retry of known undispatched FAILED intent gets a fresh identity without changing source", async () => {
  const p = platform(); const deploy = p.api.deployWorker; const keys: string[] = [];
  p.api.deployWorker = async (options, id, input) => {
    keys.push(String(input.idempotencyKey));
    if (keys.length === 1) {
      const failure = {...input,id:'before-provider',environmentId:'env',status:'FAILED',createdAt:'2026-10-06T10:00:00Z',outcome:{operationId:'unsent-op',providerEffect:'NOT_DISPATCHED',execution:'FAILED',automaticReplay:false}};
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
    if (keys.length === 1) { const failure={...input,id:'unsent',environmentId:'env',status:'FAILED',outcome:{operationId:'known-unsent',providerEffect:'NOT_DISPATCHED'}};p.deployments.push(failure);return failure; }
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
  const run=(containers:ReturnType<typeof declaration>)=>ensureActiveDeployment(p.api,{apiHost:'localhost:3148',apiKey:'test'},'worker','same-artifact','preview',{compatibilityFlags:[]},async()=>{},undefined,[],containers);
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
