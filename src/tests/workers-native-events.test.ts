import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureWorkerQueueConsumer, disableWorkerQueueConsumer } from '../workers-client.ts';
import { applyWorkerNativeEvents, planWorkerNativeEvents } from '../workers-native-events.ts';
import { createWorkerPlan } from '../workers-plan.ts';
import { loadWorkerProject } from '../workers-project.ts';
import { importWranglerProject, readWranglerNativeEvents, readWranglerDeploymentSettings } from '../workers-wrangler-import.ts';
import { pushWorkerProject, type PushClient } from '../workers-push.ts';
import { attachWorkerObservability, loadWorkerArtifact, workerArtifactMultipart, validateNativeDeploymentMetadata } from '../workers-artifact.ts';
import { promoteWorkerProject, type PromotionClient } from '../workers-promote.ts';

const roots: string[] = [];
const workerId = '12345678-1234-4234-8234-123456789abc';
const options = { apiHost: 'test.xapi.to', apiKey: 'unit-native-events' };
const cron = '*/5 * * * *';
const wrangler = {
  name: 'native-events', main: 'src/index.ts', compatibility_date: '2026-10-01',
  queues: { producers: [{ binding: 'JOBS', queue: 'logical-jobs' }, { binding: 'DLQ', queue: 'logical-dead' }],
    consumers: [{ queue: 'logical-jobs', max_batch_size: 50, max_batch_timeout: 0, max_retries: 0, retry_delay: 0, max_concurrency: 200, dead_letter_queue: 'logical-dead' }] },
  triggers: { crons: [cron, cron] },
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function workspace(config: Record<string, unknown> = wrangler, acceptPartial = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xapi-native-events-'))); roots.push(root);
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify(config));
  const imported = importWranglerProject({ cwd: root, wranglerPath: 'wrangler.jsonc', acceptPartial });
  if (imported.wrote) {
    const path = join(root, 'xapi.worker.json'); const value = JSON.parse(readFileSync(path, 'utf8'));
    value.workerId = workerId; value.build = { command: 'synthetic-build', output: 'dist/worker.mjs' };
    for (const environment of ['preview', 'production']) { value.environments[environment].dailyBudgetUsd = null; value.environments[environment].secrets = []; }
    writeFileSync(path, JSON.stringify(value));
  }
  return { root, imported };
}
const consumerBody = { queue: 'logical-jobs', max_batch_size: 50, max_batch_timeout: 0, max_retries: 0, retry_delay: 0, max_concurrency: 200, deadLetterBinding: 'DLQ' };
function resources() { return [{ id: 'owned-jobs', bindingName: 'JOBS', type: 'QUEUE', status: 'ACTIVE' }, { id: 'owned-dead', bindingName: 'DLQ', type: 'QUEUE', status: 'ACTIVE' }]; }

test('imports native Queue settings, same-environment dead-letter binding and deduplicated cron intent', () => {
  const {root,imported} = workspace(); expect(imported.wrote).toBe(true);
  const project = loadWorkerProject(root);
  expect(readWranglerNativeEvents(project, 'preview')).toEqual({ queueConsumers: [{ bindingName: 'JOBS', ...consumerBody }], crons: [cron] });
  expect(project.config.environments.preview.resources).toEqual([{type:'queue',bindingName:'DLQ'}, {type:'queue',bindingName:'JOBS'}]);
  expect(imported.report.entries).toContainEqual(expect.objectContaining({category:'MANAGED',path:'queues.consumers[0]'}));
  expect(imported.report.entries).toContainEqual(expect.objectContaining({category:'MANAGED',path:'triggers.crons'}));
  expect(readFileSync(join(root,'xapi.worker.json'),'utf8')).not.toContain('providerResourceId');
});

test('plan treats an explicit default Worker consumer type as unchanged but keeps real differences',async()=>{
  const {root}=workspace();const project=loadWorkerProject(root);
  const client={listWorkerResources:async()=>resources(),listWorkerSchedules:async()=>[]};
  const plan=async(current:Record<string,unknown>)=> (await planWorkerNativeEvents(project,'preview',
    [{...resources()[0],config:{nativeConsumer:current}},resources()[1]],client,options)).find(row=>row.key==='queue:JOBS');
  for(const current of [consumerBody,{type:'worker',...consumerBody}])
    expect((await plan(current))?.operation).toBe('NO_CHANGE');
  const {max_retries:_removed,...withoutRetries}=consumerBody;
  for(const current of [{type:'http_pull',...consumerBody},{...consumerBody,max_retries:1},
    withoutRetries,{...consumerBody,future_setting:false}])
    expect((await plan(current))?.operation).toBe('UPDATE');
  expect((await plan({type:'worker',...consumerBody}))?.current).toEqual({type:'worker',...consumerBody});
});

test('imports and sends named and calendar cron expressions without normalizing user intent', async () => {
  const crons = ['* * * oct thu', '59 23 LW * *', '0 18 * * friL', '5/10 * * JAN-MAR MON#2'];
  const { root, imported } = workspace({ ...wrangler, queues: {}, triggers: { crons } });
  expect(imported.wrote).toBe(true);
  const project = loadWorkerProject(root);
  expect(readWranglerNativeEvents(project, 'preview').crons).toEqual(crons);
  const sent: string[] = [];
  const client = { listWorkerResources: async () => [], listWorkerSchedules:async()=>[], updateWorkerSchedule:async()=>{throw Error('unexpected update')}, createWorkerSchedule: async (_options: unknown, _id: string, input: any) => {
    expect(input.handler).toBe('scheduled'); expect(input.timezone).toBe('UTC');
    sent.push(input.cron); return { id: input.cron };
  } };
  expect((await applyWorkerNativeEvents(project, 'preview', workerId, client as any, options)).crons).toEqual(crons);
  expect(sent).toEqual(crons);
});

test('consumer-only queues get stable bindings and multiple producer names use one owned Queue', () => {
  const input = {name:'consumer-only',main:'src/index.ts',queues:{consumers:[{queue:'jobs',dead_letter_queue:'dead'}]}};
  const {root,imported} = workspace(input); expect(imported.wrote).toBe(true);
  const events = readWranglerNativeEvents(loadWorkerProject(root),'preview');
  const expected = `QUEUE_${createHash('sha256').update('jobs').digest('hex').slice(0,16)}`;
  expect(events.queueConsumers[0].bindingName).toBe(expected);
  expect(loadWorkerProject(root).config.environments.preview.resources).toHaveLength(2);
  const ambiguous = workspace({ ...input, queues: {producers:[{binding:'ONE',queue:'jobs'},{binding:'TWO',queue:'jobs'}],consumers:[{queue:'jobs'}]} });
  expect(ambiguous.imported.wrote).toBe(true);
  const aliasProject = loadWorkerProject(ambiguous.root);
  expect(aliasProject.config.environments.preview.resources).toEqual([{type:'queue',bindingName:'ONE'}]);
  expect(readWranglerNativeEvents(aliasProject,'preview')).toEqual({queueConsumers:[{bindingName:'ONE',queue:'jobs'}],crons:[],queueBindingAliases:{TWO:'ONE'}});
  const settings = readWranglerDeploymentSettings(aliasProject,'preview');
  expect(settings.queueBindingAliases).toEqual({TWO:'ONE'});
  mkdirSync(join(ambiguous.root,'dist'));
  writeFileSync(join(ambiguous.root,'dist/worker.mjs'), 'export default {fetch(){return new Response("ok")}}');
  const artifact = attachWorkerObservability(loadWorkerArtifact(join(ambiguous.root,'dist/worker.mjs')), undefined, settings.queueBindingAliases);
  expect('bundle' in artifact.upload && artifact.upload.bundle.queueBindingAliases).toEqual({TWO:'ONE'});
  const multipart = workerArtifactMultipart({...artifact.upload,idempotencyKey:'alias'});
  expect(JSON.parse(String(multipart.get('manifest'))).queueBindingAliases).toEqual({TWO:'ONE'});
  validateNativeDeploymentMetadata({...artifact,nativeMetadata:{bindings:[{name:'ONE',type:'queue'},{name:'TWO',type:'queue'}]}},settings,aliasProject.config.environments.preview.resources);
  // Regression for producer-order changes: canonical resource and artifact identity stay stable.
  writeFileSync(join(ambiguous.root,'wrangler.jsonc'), JSON.stringify({...input,queues:{producers:[{binding:'TWO',queue:'jobs'},{binding:'ONE',queue:'jobs'}],consumers:[{queue:'jobs'}]}}));
  expect(readWranglerDeploymentSettings(aliasProject,'preview').queueBindingAliases).toEqual({TWO:'ONE'});
  expect(readWranglerNativeEvents(aliasProject,'preview').queueConsumers[0].bindingName).toBe('ONE');
});

test('unsupported consumer fields and trigger fields cannot disappear during partial import or later push', () => {
  for (const [config,path,error] of [
    [{...wrangler,queues:{...wrangler.queues,consumers:[{queue:'logical-jobs',type:'http'}]}},'queues.consumers[0]','Invalid Queue consumer'],
    [{...wrangler,triggers:{crons:[cron],unknown:'value'}},'triggers.unknown','only maps crons'],
  ] as const) {
    const {root,imported} = workspace(config,true);
    expect(imported.report.entries).toContainEqual(expect.objectContaining({category:'UNSUPPORTED',path}));
    expect(()=>readWranglerNativeEvents(loadWorkerProject(root),'preview')).toThrow(error);
  }
});

test('read-only plan detects consumer resets and preserved remote handlers without adding a deployment gate', async () => {
  const {root} = workspace(); const project = loadWorkerProject(root);
  let scheduleReads = 0;
  const remote = [...resources(),{id:'extra',bindingName:'OLD',type:'QUEUE',status:'ACTIVE',config:{nativeConsumer:{queue:'old'}}}];
  Object.assign(remote[0],{config:{nativeConsumer:{...consumerBody,max_batch_timeout:30}}});
  const schedules = [{id:'same',name:`Wrangler cron ${createHash('sha256').update(cron).digest('hex').slice(0,16)}`,handler:'scheduled',environment:'PREVIEW',cron,timezone:'UTC',enabled:true},{id:'old',handler:'scheduled',environment:'PREVIEW',cron:'0 8 * * *',timezone:'UTC',enabled:true}];
  const client = { getWorkerVariableState:async()=>({environment:'preview',exists:false,activeDeploymentId:null,variables:[]}), listWorkers:async()=>[], getWorker:async()=>({id:workerId,slug:'native-events',environments:[{id:'env-preview',name:'PREVIEW',dailyBudgetUsd:null}],artifacts:[],deployments:[]}), listWorkerResources:async()=>remote,listWorkerSecrets:async()=>[],listWorkerSchedules:async()=>{scheduleReads++; return schedules;} };
  const plan = await createWorkerPlan({cwd:root,environment:'preview',clientOptions:options,client});
  expect(scheduleReads).toBe(1);
  expect(plan.actions).toContainEqual(expect.objectContaining({kind:'event',key:'queue:JOBS',operation:'UPDATE'}));
  expect(plan.actions).toContainEqual(expect.objectContaining({kind:'event',key:`cron:${cron}`,operation:'NO_CHANGE'}));
  expect(plan.actions.filter(action=>action.kind==='event' && action.operation==='MANUAL')).toHaveLength(2);
  expect(plan.actions.some(action=>action.operation==='BLOCKED')).toBe(false);
  writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({...wrangler,queues:{...wrangler.queues,consumers:[]},triggers:{crons:[]}}));
  const removed = await planWorkerNativeEvents(loadWorkerProject(root),'preview',remote,client,options);
  expect(removed.filter(action=>action.operation==='UPDATE')).toHaveLength(1);
  expect(removed.filter(action=>action.operation==='MANUAL')).toHaveLength(3);
  expect(removed).toHaveLength(4);
});

test('event apply resolves owned resource IDs, forwards native zero values and requires confirmed receipts', async () => {
  const {root} = workspace(); const project = loadWorkerProject(root); const calls: unknown[][] = [];
  const client = { listWorkerResources:async()=>resources(), listWorkerSchedules:async()=>[],updateWorkerSchedule:async()=>{throw Error('unexpected update')}, configureWorkerQueueConsumer:async(...args:unknown[])=>{calls.push(args);return{status:'CONFIGURED'};},createWorkerSchedule:async(...args:unknown[])=>{calls.push(args);return{id:'tracked-cron'};} };
  expect(await applyWorkerNativeEvents(project,'preview',workerId,client,options)).toEqual({queueConsumers:['JOBS'],crons:[cron]});
  expect(calls[0]).toEqual([options,workerId,'preview','owned-jobs',consumerBody]);
  expect(calls[1][2]).toEqual(expect.objectContaining({handler:'scheduled',environment:'preview',cron,timezone:'UTC',}));
  await expect(applyWorkerNativeEvents(project,'preview',workerId,{...client,configureWorkerQueueConsumer:async()=>({status:'PENDING'})},options)).rejects.toThrow('receipt missing');
  await expect(applyWorkerNativeEvents(project,'preview',workerId,{...client,listWorkerResources:async()=>[{...resources()[0],status:'PROVISIONING'}]},options)).rejects.toThrow('Active queue binding');
  const configPath = join(root,'xapi.worker.json'); const config = JSON.parse(readFileSync(configPath,'utf8')); config.environments.preview.resources = [config.environments.preview.resources.find((row:any)=>row.bindingName==='JOBS')]; writeFileSync(configPath,JSON.stringify(config));
  await expect(applyWorkerNativeEvents(loadWorkerProject(root),'preview',workerId,client,options)).rejects.toThrow('DLQ');
});

test('native consumer HTTP mutations stay owner/environment scoped and do not retry failed writes', async () => {
  const fetchSpy = spyOn(globalThis,'fetch').mockResolvedValue(Response.json({status:'CONFIGURED'})) as any;
  try {
    await configureWorkerQueueConsumer(options,'worker/one','preview','queue/one',consumerBody);
    const [url,init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://test.xapi.to/api/v1/workers/worker%2Fone/environments/preview/resources/queue%2Fone/queue-consumer');
    expect(init.method).toBe('PUT');expect(init.headers['XAPI-KEY']).toBe('unit-native-events');expect(JSON.parse(init.body)).toEqual(consumerBody);
    fetchSpy.mockResolvedValue(Response.json({status:'DISABLED'}));
    await disableWorkerQueueConsumer(options,'worker/one','preview','queue/one');expect(fetchSpy.mock.calls[1][1].method).toBe('DELETE');
    fetchSpy.mockResolvedValue(Response.json({message:'runtime attestation missing'},{status:409}));
    await expect(configureWorkerQueueConsumer(options,'worker/one','preview','queue/one',consumerBody)).rejects.toThrow('runtime attestation missing');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  } finally { fetchSpy.mockRestore(); }
});

function platform(): {client:PushClient & PromotionClient; trace:string[]; deployments:Record<string,unknown>[]; resourceRows:Record<string,unknown>[] } {
  const trace:string[]=[]; const resourceRows:Record<string,unknown>[]=resources(); const artifacts:Record<string,unknown>[]=[]; const deployments:Record<string,unknown>[]=[]; const schedules:Record<string,unknown>[]=[];
  const worker = () => ({id:workerId,name:'Native Events',slug:'native-events',environments:['preview','production'].map(environment=>({id:`env-${environment}`,name:environment.toUpperCase(),activeDeploymentId:deployments.find(row=>row.environmentId===`env-${environment}` && row.status==='ACTIVE')?.id,dailyBudgetUsd:null,publicUrl:`https://events.example.test/${environment}`})),artifacts,deployments});
  const client:PushClient & PromotionClient = {
    listWorkerDomains:async()=>[],workerBillingQuery:async()=>({}),listWorkers:async()=>[worker()],getWorker:async()=>{const deploying=deployments.find(row=>row.status==='DEPLOYING');if(deploying){deploying.status='ACTIVE';trace.push('ACTIVE');}return worker();},
    createWorker:async()=>{throw Error('unexpected create');},updateWorkerEnvironment:async()=>{throw Error('unexpected budget');},createWorkerResource:async()=>{throw Error('unexpected resource');},
    getWorkerVariableState:async(_o,_id,env)=>({environment:env,exists:!!deployments.find(row=>row.environmentId===`env-${env}` && row.status==='ACTIVE'),activeDeploymentId:deployments.find(row=>row.environmentId===`env-${env}` && row.status==='ACTIVE')?.id||null,variables:[]}),
    getWorkerArtifactVariableConfiguration:async(_o,_id,artifactId)=>({artifactId,contentSha256:artifacts.find(row=>row.id===artifactId)?.contentSha256,variables:[],bindingNames:[],keepBindings:[]}),
    updateWorkerSchedule:async()=>{throw Error('unexpected schedule update')},
    listWorkerResources:async()=>resourceRows,listWorkerSecrets:async()=>[],listWorkerArtifacts:async()=>artifacts,
    uploadWorkerArtifact:async(_o,_id,input)=>{if(!('moduleCode' in input))throw Error('unexpected bundle');const artifact={id:'artifact',contentSha256:createHash('sha256').update(input.moduleCode).digest('hex')};artifacts.push(artifact);trace.push('upload');return artifact;},
    deployWorker:async(_o,_id,input)=>{const row={id:`deploy-${input.environment}`,artifactId:input.artifactId,environmentId:`env-${input.environment}`,idempotencyKey:input.idempotencyKey,status:'DEPLOYING'};deployments.push(row);trace.push('deploy');return row;},
    listWorkerSchedules:async()=>schedules,
    configureWorkerQueueConsumer:async(_o,_id,env,id,input)=>{expect(deployments.some(row=>row.environmentId===`env-${env}` && row.status==='ACTIVE')).toBe(true);expect(id).toBe('owned-jobs');trace.push(`queue-${env}`);Object.assign(resourceRows[0],{config:{nativeConsumer:input}});return{status:'CONFIGURED'};},
    createWorkerSchedule:async(_o,_id,input)=>{expect(deployments.some(row=>row.environmentId===`env-${input.environment}` && row.status==='ACTIVE')).toBe(true);trace.push(`cron-${input.environment}`);const id=`cron-${input.environment}`;const row={id,...input};const old=schedules.findIndex(value=>value.id===id);if(old<0)schedules.push(row);else schedules[old]=row;return row;},
  };
  return {client,trace,deployments,resourceRows};
}

test('push and promote configure events only after ACTIVE and repeated push uses tracked idempotent schedule intent', async () => {
  const {root} = workspace(); const mock = platform();
  const runBuild=async()=>{mkdirSync(join(root,'dist'),{recursive:true});writeFileSync(join(root,'dist/worker.mjs'),'export default { async fetch() { return new Response("ok") }, async queue() {}, async scheduled() {} };');};
  const common={cwd:root,nonInteractive:true,clientOptions:options,client:mock.client,sleep:async()=>undefined,fetchPublic:(async()=>Response.json({ok:true})) as unknown as typeof fetch};
  const pushed=await pushWorkerProject({...common,environment:'preview',runBuild});expect(pushed.events).toEqual({queueConsumers:['JOBS'],crons:[cron]});
  expect(mock.trace.indexOf('queue-preview')).toBeGreaterThan(mock.trace.indexOf('ACTIVE'));expect(mock.trace.indexOf('cron-preview')).toBeGreaterThan(mock.trace.indexOf('queue-preview'));
  await pushWorkerProject({...common,environment:'preview',runBuild});expect(mock.deployments).toHaveLength(1);
  mock.resourceRows.push({id:'old',type:'D1_DATABASE',bindingName:'OLD',status:'ACTIVE'});
  const promoted=await promoteWorkerProject({...common,to:'production',confirm:async plan=>{expect(plan.canPromote).toBe(true);expect(plan.production.checks).toContainEqual(expect.objectContaining({kind:'resource',key:'OLD',status:'MANUAL'}));return true;}});
  expect(promoted.events).toEqual({queueConsumers:['JOBS'],crons:[cron]});expect(mock.trace).toContain('queue-production');
  expect(mock.resourceRows.find(row=>row.id==='old')).toBeDefined();
});

test('production can clear immutable preview aliases without creating extra Queue resources', () => {
  const {root,imported} = workspace({name:'alias-envs',main:'src/index.ts',queues:{producers:[{binding:'ONE',queue:'jobs'},{binding:'TWO',queue:'jobs'}]},env:{production:{queues:{producers:[{binding:'ONE',queue:'production-jobs'}]}}}});
  expect(imported.wrote).toBe(true);
  const project = loadWorkerProject(root);
  expect(project.config.environments.preview.resources).toEqual([{type:'queue',bindingName:'ONE'}]);
  expect(project.config.environments.production.resources).toEqual([{type:'queue',bindingName:'ONE'}]);
  expect(readWranglerDeploymentSettings(project,'preview').queueBindingAliases).toEqual({TWO:'ONE'});
  expect(readWranglerDeploymentSettings(project,'production').queueBindingAliases).toEqual({});
});


test('adding an earlier producer alias keeps the existing Queue primary through push and re-import', () => {
  const config = {name:'stable-queue',main:'src/index.ts',queues:{producers:[{binding:'ONE',queue:'jobs'}],consumers:[{queue:'jobs'}]}};
  const {root} = workspace(config);
  const changed = {...config,queues:{...config.queues,producers:[{binding:'A',queue:'jobs'},{binding:'ONE',queue:'jobs'}]}};
  writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify(changed));
  const expected = {queueConsumers:[{bindingName:'ONE',queue:'jobs'}],crons:[],queueBindingAliases:{A:'ONE'}};
  expect(readWranglerNativeEvents(loadWorkerProject(root),'preview')).toEqual(expected);
  const reimported = importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc',force:true});
  expect(reimported.wrote).toBe(true);
  const project = loadWorkerProject(root);
  expect(project.config.environments.preview.resources).toEqual([{type:'queue',bindingName:'ONE'}]);
  expect(readWranglerNativeEvents(project,'preview')).toEqual(expected);
});

test('historical bundle promotion clears aliases even after current preview aliases were removed', () => {
  const {root} = workspace({name:'removed-alias',main:'src/index.ts',queues:{producers:[{binding:'ONE',queue:'jobs'},{binding:'TWO',queue:'jobs'}]},env:{production:{queues:{producers:[{binding:'ONE',queue:'production-jobs'}]}}}});
  writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'removed-alias',main:'src/index.ts',queues:{producers:[{binding:'ONE',queue:'jobs'}]},env:{production:{queues:{producers:[{binding:'ONE',queue:'production-jobs'}]}}}}));
  const project = loadWorkerProject(root);
  for (const mediaType of ['application/vnd.xapi.worker-bundle.v1+json','application/vnd.xapi.worker-bundle.v2+json'])
    expect(readWranglerDeploymentSettings(project,'production',mediaType).queueBindingAliases).toEqual({});
  expect(readWranglerDeploymentSettings(project,'production','application/javascript').queueBindingAliases).toBeUndefined();
});


test('renaming or removing the first producer preserves the imported logical Queue mapping', () => {
  const config = {name:'renamed-producer',main:'src/index.ts',queues:{producers:[{binding:'ONE',queue:'jobs'}]}};
  const {root} = workspace(config);
  const original = loadWorkerProject(root);
  expect(original.config.environments.preview.queueBindings).toEqual({jobs:'ONE'});
  writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({...config,queues:{producers:[{binding:'A',queue:'jobs'}]}}));
  expect(readWranglerNativeEvents(loadWorkerProject(root),'preview').queueBindingAliases).toEqual({A:'ONE'});
  expect(importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc',force:true}).wrote).toBe(true);
  const reimported=loadWorkerProject(root);
  expect(reimported.config.environments.preview.resources).toEqual([{type:'queue',bindingName:'ONE'}]);
  expect(reimported.config.environments.preview.queueBindings).toEqual({jobs:'ONE'});
  expect(readWranglerNativeEvents(reimported,'preview').queueBindingAliases).toEqual({A:'ONE'});
});


test('consumer-only, producer and dead-letter changes retain each original Queue identity', () => {
  const config={name:'consumer-transition',main:'src/index.ts',queues:{consumers:[{queue:'jobs',dead_letter_queue:'dead'}]}};
  const {root}=workspace(config),initial=loadWorkerProject(root);
  const original=initial.config.environments.preview.resources;
  const mappings=initial.config.environments.preview.queueBindings!;
  expect(Object.keys(mappings).sort()).toEqual(['dead','jobs']);
  for (const producers of [[{binding:'ONE',queue:'jobs'}],[]]) {
    writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({...config,queues:{...config.queues,producers}}));
    const before=readWranglerNativeEvents(loadWorkerProject(root),'preview');
    expect(before.queueConsumers[0]).toEqual({bindingName:mappings.jobs,queue:'jobs',deadLetterBinding:mappings.dead});
    expect(importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc',force:true}).wrote).toBe(true);
    const after=loadWorkerProject(root);
    expect(after.config.workerId).toBe(workerId);
    expect(after.config.environments.preview.resources).toEqual(original);
    expect(after.config.environments.preview.queueBindings).toEqual(mappings);
  }
});


test('never silently merges different logical Queues when an old primary name is reassigned', () => {
  const {root}=workspace({name:'separate-queues',main:'src/index.ts',queues:{producers:[{binding:'ONE',queue:'jobs'}]}});
  writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'separate-queues',main:'src/index.ts',queues:{producers:[{binding:'A',queue:'jobs'},{binding:'ONE',queue:'other'}]}}));
  expect(()=>readWranglerNativeEvents(loadWorkerProject(root),'preview')).toThrow('explicit resource migration');
  const original=readFileSync(join(root,'xapi.worker.json'),'utf8');
  const result=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc',force:true});
  expect(result.wrote).toBe(false);
  expect(readFileSync(join(root,'xapi.worker.json'),'utf8')).toBe(original);
});
