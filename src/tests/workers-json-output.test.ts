import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Exercise the source CLI and actual child build over local HTTP, without
// building dist, reading credentials or contacting a real provider.
async function fixture() {
  const root=mkdtempSync(join(tmpdir(),'workers-json-output-'));
  const workerId='22222222-2222-4222-8222-222222222222';
  let artifact:any={id:'artifact-v2',contentSha256:'old',sizeBytes:1};
  let deployments:any[]=[
    {id:'v2',artifactId:'artifact-v2',environmentId:'env-preview',status:'ACTIVE',deployedAt:'2026-10-09T02:00:00Z'},
    {id:'v1',artifactId:'artifact-v1',environmentId:'env-preview',status:'ACTIVE',deployedAt:'2026-10-09T01:00:00Z'},
    {id:'production-v2',artifactId:'artifact-v2',environmentId:'env-production',status:'ACTIVE',deployedAt:'2026-10-09T02:00:00Z'},
    {id:'production-v1',artifactId:'artifact-v1',environmentId:'env-production',status:'ACTIVE',deployedAt:'2026-10-09T01:00:00Z'},
  ];
  let active='v2',writes=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    const path=new URL(request.url).pathname;
    if(path.startsWith('/business/')){
      expect(request.headers.has('XAPI-KEY')).toBe(false);
      return Response.json({ok:true});
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
          environmentId:'env-preview',status:'ACTIVE',idempotencyKey:(rollback?'rollback:':'')+body.idempotencyKey,deployedAt:'2026-10-09T03:00:00Z'};
        deployments=[deployment,...deployments];active=deployment.id;return Response.json(deployment);
      }
      throw Error('Unexpected test write '+path);
    }
    if(path.endsWith('/variables'))return Response.json({environment:'preview',exists:true,activeDeploymentId:active,variables:[]});
    if(path.includes('/billing/'))return Response.json({});
    if(path.endsWith('/domains'))return Response.json([]);
    if(path.endsWith('/resources')||path.endsWith('/secrets')||path.endsWith('/schedules'))return Response.json([]);
    if(path.endsWith('/artifacts'))return Response.json([artifact]);
    if(path===`/api/v1/workers/${workerId}`)return Response.json({id:workerId,name:'JSON Fixture',slug:'json-fixture',
      environments:[{id:'env-preview',name:'PREVIEW',dailyBudgetUsd:null,activeDeploymentId:active,publicUrl:'https://public-output.example.test/business/preview'},
        {id:'env-production',name:'PRODUCTION',dailyBudgetUsd:null}],artifacts:[artifact],deployments});
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
await import(${JSON.stringify(entry)});
`);
  return {root,server,get writes(){return writes;},async cli(args:string[]){
    const child=Bun.spawn([process.execPath,bootstrap,'workers',...args,'--format','json'],{cwd:root,env:{...process.env,XAPI_KEY:'local-output-fixture',XAPI_API_HOST:`127.0.0.1:${server.port}`},stdout:'pipe',stderr:'pipe'});
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
