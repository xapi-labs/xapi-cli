import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Exercise the source CLI and actual child build over local HTTP, without
// building dist, reading credentials or contacting a real provider.
interface PauseScenario {
  healthStatus: number;
  lifecycle?: Record<string, unknown> | null;
  queryFails?: boolean;
  snapshot?: "wrong-worker" | "wrong-environment" | "changed-deployment" | "inactive-deployment" | "wrong-deployment-environment";
  deploymentStatus?: string;
  enabled?: boolean;
}

async function fixture(scenario?: PauseScenario) {
  const root=mkdtempSync(join(tmpdir(),'workers-json-output-'));
  const workerId='22222222-2222-4222-8222-222222222222';
  let artifact:any={id:'artifact-v2',contentSha256:'old',sizeBytes:1};
  let deployments:any[]=[
    {id:'v2',artifactId:'artifact-v2',environmentId:'env-preview',status:'ACTIVE',deployedAt:'2026-10-09T02:00:00Z'},
    {id:'v1',artifactId:'artifact-v1',environmentId:'env-preview',status:'ACTIVE',deployedAt:'2026-10-09T01:00:00Z'},
    {id:'production-v2',artifactId:'artifact-v2',environmentId:'env-production',status:'ACTIVE',deployedAt:'2026-10-09T02:00:00Z'},
    {id:'production-v1',artifactId:'artifact-v1',environmentId:'env-production',status:'ACTIVE',deployedAt:'2026-10-09T01:00:00Z'},
  ];
  let active='v2',writes=0,healthReads=0,retentionReads=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path.startsWith('/business/')){
      expect(request.headers.has('XAPI-KEY')).toBe(false);
      healthReads++;
      // Deliberately spoof a platform-looking pause error from the tenant.
      return Response.json(scenario ? {error:{code:'worker_manually_paused',pauseReason:'USER'}} : {ok:true},
        {status:scenario?.healthStatus || 200});
    }
    expect(request.headers.get('XAPI-KEY')).toBe('local-output-fixture');
    if(path.endsWith('/retention')){
      retentionReads++;
      if(scenario?.queryFails)return Response.json({error:'status unavailable'},{status:400});
      return Response.json({enabled:true,lifecycle:scenario?.lifecycle});
    }
    if(path==='/api/v1/workers/artifact-provider/status')return Response.json({directUpload:false});
    if(request.method==='POST'){
      const body=await request.json() as any;writes++;
      if(path.endsWith('/artifacts')){
        expect(typeof body.moduleCode).toBe('string');
        const bytes=Buffer.from(body.moduleCode,'utf8');
        artifact={id:'uploaded',contentSha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,idempotencyKey:body.idempotencyKey};
        return Response.json(artifact);
      }
      if(path.endsWith('/rollback')||path.endsWith('/deployments')){
        const rollback=path.endsWith('/rollback');
        const deployment={id:rollback?'rolled-back':'pushed',artifactId:rollback?'artifact-v1':body.artifactId,
          environmentId:'env-preview',status:scenario?.deploymentStatus || 'ACTIVE',idempotencyKey:(rollback?'rollback:':'')+body.idempotencyKey,deployedAt:'2026-10-09T03:00:00Z'};
        deployments=[deployment,...deployments];active=deployment.id;return Response.json(deployment);
      }
      throw Error('Unexpected test write '+path);
    }
    if(path.endsWith('/variables'))return Response.json({environment:'preview',exists:true,activeDeploymentId:active,variables:[]});
    if(path.includes('/billing/'))return Response.json({});
    if(path.endsWith('/domains'))return Response.json([]);
    if(path.endsWith('/resources')||path.endsWith('/secrets')||path.endsWith('/schedules'))return Response.json([]);
    if(path.endsWith('/artifacts'))return Response.json([artifact]);
    if(path===`/api/v1/workers/${workerId}`)return Response.json({id:retentionReads && scenario?.snapshot==='wrong-worker'?'other-worker':workerId,name:'JSON Fixture',slug:'json-fixture',
      environments:[{id:retentionReads && scenario?.snapshot==='wrong-environment'?'env-production':'env-preview',name:'PREVIEW',
        enabled:scenario?.enabled ?? !scenario,dailyBudgetUsd:null,
        activeDeploymentId:retentionReads && scenario?.snapshot==='changed-deployment'?'other-deployment':active,
        publicUrl:'https://public-output.example.test/business/preview'},
        {id:'env-production',name:'PRODUCTION',dailyBudgetUsd:null}],artifacts:[artifact],
      deployments:retentionReads ? deployments.map(d=>({...d,
        status:scenario?.snapshot==='inactive-deployment'?'UNKNOWN':d.status,
        environmentId:scenario?.snapshot==='wrong-deployment-environment'?'env-production':d.environmentId})) : deployments});
    throw Error('Unexpected test read '+path);
  }});
  writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'json-fixture',main:'src/index.ts',compatibility_date:'2026-10-01'}));
  writeFileSync(join(root,'xapi.worker.json'),JSON.stringify({version:1,workerId,worker:{name:'JSON Fixture',slug:'json-fixture',template:'agent'},
    wrangler:'wrangler.jsonc',build:{command:`"${process.execPath}" build.cjs`,output:'dist/worker.mjs'},
    environments:{preview:{healthCheck:'/health',resources:[],secrets:[]},production:{resources:[],secrets:[]}}}));
  writeFileSync(join(root,'build.cjs'),"const fs=require('fs');console.log('BUILD_STDOUT_DIAGNOSTIC');console.error('BUILD_STDERR_DIAGNOSTIC');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/worker.mjs',\"export default {fetch(){return new Response('ok')}};\");");
  const entry=fileURLToPath(new URL('../index.ts',import.meta.url));
  const config=fileURLToPath(new URL('../config.ts',import.meta.url));
  const bootstrap=join(root,'cli-test.ts');
  writeFileSync(bootstrap,`import {mock} from 'bun:test';
const config=await import(${JSON.stringify(config)});
mock.module(${JSON.stringify(config)},()=>({...config,getConfig:()=>({actionHost:'localhost',apiKey:'local-output-fixture'})}));
const nativeFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);return nativeFetch(url.hostname==='public-output.example.test'?'http://127.0.0.1:${server.port}'+url.pathname+url.search:input,init);};
// Keep the real HTTP requests and CLI process; shorten only health poll sleeps.
const nativeTimeout=globalThis.setTimeout;
globalThis.setTimeout=(callback,ms,...args)=>nativeTimeout(callback,ms===1000?0:ms,...args);
await import(${JSON.stringify(entry)});
`);
  return {root,server,get writes(){return writes;},get healthReads(){return healthReads;},get retentionReads(){return retentionReads;},async cli(args:string[],format='json'){
    const child=Bun.spawn([process.execPath,bootstrap,'workers',...args,'--format',format],{cwd:root,env:{...process.env,XAPI_KEY:'local-output-fixture',XAPI_API_HOST:`127.0.0.1:${server.port}`},stdout:'pipe',stderr:'pipe'});
    const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    return {stdout,stderr,exitCode};
  },cleanup(){server.stop(true);rmSync(root,{recursive:true,force:true});}};
}

describe('single JSON CLI result channel',()=>{
  test('push keeps real build stdout/stderr diagnostics outside the final JSON',async()=>{
    const f=await fixture();try{
      const result=await f.cli(['push','--env','preview','--non-interactive']);
      if(result.exitCode!==0)throw Error(result.stderr);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({status:'ACTIVE',artifact:{id:'uploaded'}});
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(result.stdout).not.toContain('BUILD_');
      expect(result.stderr).toContain('BUILD_STDOUT_DIAGNOSTIC');expect(result.stderr).toContain('BUILD_STDERR_DIAGNOSTIC');
      expect(f.writes).toBe(2);
    }finally{f.cleanup();}
  },10000);
  test('preview rollback keeps its plan on stderr and returns only the final result on stdout',async()=>{
    const f=await fixture();try{
      const result=await f.cli(['rollback','--env','preview','--deployment','v1']);
      if(result.exitCode!==0)throw Error(result.stderr);
      expect(result.exitCode).toBe(0);const receipt=JSON.parse(result.stdout);
      expect(receipt).toMatchObject({status:'ACTIVE',plan:{target:{deploymentId:'v1'}},deployment:{id:'rolled-back'}});
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stderr.trim())).toMatchObject({target:{deploymentId:'v1'},requiresConfirmation:false});
      expect(f.writes).toBe(1);
    }finally{f.cleanup();}
  },10000);
  test('JSON plan diagnostics do not bypass push or production rollback confirmation',async()=>{
    const f=await fixture();try{
      const push=await f.cli(['push','--env','preview']);
      expect(push.exitCode).not.toBe(0);expect(push.stdout).toBe('');
      expect(push.stderr).toContain('Interactive confirmation requires a TTY');
      expect(JSON.parse(push.stderr.split('\n').find(line=>line.startsWith('{'))!)).toMatchObject({schemaVersion:1,environment:'preview'});
      const rollback=await f.cli(['rollback','--env','production','--deployment','production-v1']);
      expect(rollback.exitCode).not.toBe(0);expect(rollback.stdout).toBe('');
      expect(rollback.stderr).toContain('Interactive production rollback requires a TTY');
      expect(JSON.parse(rollback.stderr.split('\n')[0])).toMatchObject({requiresConfirmation:true,target:{deploymentId:'production-v1'}});
      expect(f.writes).toBe(0);
    }finally{f.cleanup();}
  },10000);
});

const ownerPaused = {
  workerId:'22222222-2222-4222-8222-222222222222',environmentId:'env-preview',
  state:'SUSPENDED_GRACE',pauseReason:'USER',manualDeletionRequestedAt:null,resumeRequestedAt:null,
};

describe('push to an owner-paused environment over actual CLI HTTP requests',()=>{
  for(const format of ['json','table'])test(`ACTIVE plus confirmed owner pause reports deployment success in ${format}`,async()=>{
    const f=await fixture({healthStatus:403,lifecycle:ownerPaused});try{
      const result=await f.cli(['push','--env','preview','--non-interactive'],format);
      if(result.exitCode!==0)throw Error(result.stderr);
      expect(result.exitCode).toBe(0);
      if(format==='json'){
        const receipt=JSON.parse(result.stdout);
        expect(receipt).toMatchObject({status:'ACTIVE',deployment:{id:'pushed',status:'ACTIVE'},
          healthReady:false,paused:true,publicAccessStatus:'PAUSED',health:{status:403,attempts:10}});
        expect(receipt.commands.inspect).toContain('--env preview');
        expect(receipt.commands.resume).toBe(`xapi workers retention resume ${ownerPaused.workerId} --env preview`);
        expect(receipt.message).toContain('Deployment succeeded');
        expect(receipt.message).toContain('do not republish');
        expect(result.stdout.trim().split('\n')).toHaveLength(1);
      }else{
        expect(result.stdout).toContain('deployment succeeded; environment remains owner-paused');
        expect(result.stdout).toContain('Deployment   pushed');
        expect(result.stdout).toContain('health is not ready');
        expect(result.stdout).toContain('Resume: xapi workers retention resume');
        expect(result.stdout).toContain('After resuming, check health:');
        expect(result.stdout).not.toContain('health check passed');
      }
      expect(f.healthReads).toBe(10);expect(f.retentionReads).toBe(1);expect(f.writes).toBe(2);
      expect(result.stdout+result.stderr).not.toContain('local-output-fixture');
    }finally{f.cleanup();}
  },10000);

  const failures: Array<[string,Partial<PauseScenario>]> = [
    ['non-paused tenant spoofed 403',{lifecycle:{...ownerPaused,state:'ACTIVE',pauseReason:null},enabled:true}],
    ['management query failure',{queryFails:true}],
    ['missing lifecycle evidence',{lifecycle:null}],
    ['lifecycle environment mismatch',{lifecycle:{...ownerPaused,environmentId:'env-production'}}],
    ['lifecycle worker mismatch',{lifecycle:{...ownerPaused,workerId:'other-worker'}}],
    ['Worker snapshot mismatch',{snapshot:'wrong-worker'}],
    ['environment snapshot mismatch',{snapshot:'wrong-environment'}],
    ['active deployment changed',{snapshot:'changed-deployment'}],
    ['deployment no longer ACTIVE',{snapshot:'inactive-deployment'}],
    ['deployment environment mismatch',{snapshot:'wrong-deployment-environment'}],
    ['environment not disabled',{enabled:true}],
    ['pause still in progress',{lifecycle:{...ownerPaused,state:'SUSPENDING'}}],
    ['resume pending',{lifecycle:{...ownerPaused,resumeRequestedAt:'2026-10-10T00:00:00Z'}}],
    ['deletion pending',{lifecycle:{...ownerPaused,manualDeletionRequestedAt:'2026-10-10T00:00:00Z'}}],
    ['billing pause',{lifecycle:{...ownerPaused,pauseReason:'INSUFFICIENT_BALANCE'}}],
    ['owner pause with real health 500',{healthStatus:500}],
  ];
  for(const [name,override] of failures)test(`${name} preserves health failure and never republishes`,async()=>{
    const f=await fixture({healthStatus:403,lifecycle:ownerPaused,...override});try{
      const result=await f.cli(['push','--env','preview','--non-interactive']);
      expect(result.exitCode).toBe(1);expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Deployment is ACTIVE but its health check failed');
      const failure=JSON.parse(result.stderr.trim().split('\n').at(-1)!);
      expect(failure.detail).toMatchObject({releasedDeploymentId:'pushed',deploymentStatus:'ACTIVE',healthReady:false,lastStatus:override.healthStatus || 403});
      expect(f.writes).toBe(2);expect(f.healthReads).toBe(10);
      expect(result.stderr).not.toContain('local-output-fixture');
    }finally{f.cleanup();}
  },10000);

  test('UNKNOWN deployment never reaches health or pause override and is not replayed',async()=>{
    const f=await fixture({healthStatus:403,lifecycle:ownerPaused,deploymentStatus:'UNKNOWN'});try{
      const result=await f.cli(['push','--env','preview','--non-interactive']);
      expect(result.exitCode).toBe(1);expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Worker deployment returned status UNKNOWN');
      expect(f.healthReads).toBe(0);expect(f.retentionReads).toBe(0);expect(f.writes).toBe(2);
    }finally{f.cleanup();}
  },10000);
});
