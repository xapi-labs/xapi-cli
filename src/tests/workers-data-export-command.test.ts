import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { WORKERS_HELP } from '../commands/workers.ts';

const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const workerId='22222222-2222-4222-8222-222222222222';
const entry=fileURLToPath(new URL('../index.ts',import.meta.url));
async function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'export-command-')));chmodSync(root,0o700);roots.push(root);
  writeFileSync(join(root,'xapi.worker.json'),JSON.stringify({version:1,workerId,worker:{name:'Export fixture',slug:'export-fixture'},
    wrangler:'wrangler.jsonc',build:{command:'DO_NOT_BUILD',output:'dist/worker.mjs'},environments:{preview:{},production:{}}}));
  const calls: string[]=[];
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
    expect(request.headers.get('XAPI-KEY')).toBe('export-fixture-key');
    const url=new URL(request.url);calls.push(request.method+' '+url.pathname);
    if(url.pathname.endsWith('/resources'))return Response.json([{id:'r',type:'D1_DATABASE',bindingName:'DB',status:'ACTIVE'}]);
    if(url.pathname.endsWith('/data-exports')){expect(await request.json()).toEqual({});return Response.json({exportId:'job-cli',status:'COMPLETE'});}
    if(url.pathname.endsWith('/download'))return new Response('SECRET_RAW_ERROR https://evil.invalid/?SIGNED_SECRET',{status:403});
    if(url.pathname.endsWith('/data-exports/job-cli'))return Response.json({exportId:'job-cli',status:'EXPIRED',errorCode:'SECRET_ERROR'});
    return new Response('',{status:404});
  }});
  const run=async(args:string[])=>{
    const child=Bun.spawn([process.execPath,entry,'workers',...args],{cwd:root,
      env:{...process.env,XAPI_API_HOST:'localhost:'+server.port,XAPI_KEY:'export-fixture-key',XAPI_OUTPUT:'json'},stdout:'pipe',stderr:'pipe'});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    return {code,stdout,stderr};
  };
  return {root,calls,run,server};
}
test('CLI resolves project ID, accepts --config, preserves sanitized HTTP status and one start/descriptor POST',async()=>{
  const {root,calls,run,server}=await fixture();
  try{
    const result=await run(['d1','export','--config','xapi.worker.json','--env','preview','--binding','DB','--output','backup.sql']);
    expect(result.code).toBe(1);expect(result.stdout).toBe('');
    expect(result.stderr).toContain('job-cli');expect(result.stderr).toContain('"httpStatus":403');
    expect(result.stderr).not.toMatch(/SECRET|export-fixture-key|evil\.invalid/);
    expect(calls).toEqual([`GET /api/v1/workers/${workerId}/environments/preview/resources`,
      `POST /api/v1/workers/${workerId}/environments/preview/resources/r/data-exports`,
      `POST /api/v1/workers/${workerId}/environments/preview/resources/r/data-exports/job-cli/download`]);
    expect(readFileSync(join(root,'backup.sql.manifest.jsonl'),'utf8')).not.toContain('SECRET');
  }finally{server.stop(true);}
});
test('CLI positional worker ID with --export-id never repeats start and reports EXPIRED clearly',async()=>{
  const {calls,run,server}=await fixture();
  try{
    const result=await run(['d1','export',workerId,'--env','preview','--binding','DB','--export-id','job-cli','--output','expired.sql']);
    expect(result.code).toBe(1);expect(result.stderr).toContain('"status":"expired"');expect(result.stderr).toContain('omit --export-id');
    expect(result.stderr).not.toMatch(/SECRET|export-fixture-key/);expect(calls).toHaveLength(2);
    expect(calls.every(call=>call.startsWith('GET'))).toBe(true);
  }finally{server.stop(true);}
});
test('export flags stay explicit; R2 does not accept D1 resume or unsupported imports',async()=>{
  const {calls,run,server}=await fixture();
  try{
    for(const args of [['r2','export',workerId,'--export-id','job'],['d1','export',workerId,'--env','both'],['d1','import',workerId]]){
      const result=await run(args);expect(result.code).toBe(1);expect(result.stdout).toBe('');
    }
    expect(calls).toHaveLength(0);
    expect(WORKERS_HELP).toContain('d1 export [worker-id]');expect(WORKERS_HELP).toContain('r2 export [worker-id]');expect(WORKERS_HELP).toContain('workers:data:read');
  }finally{server.stop(true);}
});
