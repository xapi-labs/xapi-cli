import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../config.ts';
import { workersCommand } from '../commands/workers.ts';
import { createWorkerBuild } from '../workers-client.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function mockApi() {
  const configSpy=spyOn(config,'getConfig').mockReturnValue({actionHost:'test.xapi.to',apiKey:'synthetic-command-key'});
  const logSpy=spyOn(console,'log').mockImplementation(()=>{});
  const fetchSpy=spyOn(globalThis,'fetch').mockImplementation((async()=>Response.json({status:'CONFIGURED',id:'fixture'})) as unknown as typeof fetch) as any;
  return {fetchSpy,logSpy,restore:()=>{fetchSpy.mockRestore();logSpy.mockRestore();configSpy.mockRestore();}};
}

test('completed recovery with pending access is explained without repeating the owner action', async () => {
  const api=mockApi();
  try {
    api.fetchSpy.mockImplementation(async()=>Response.json({state:'ACTIVE',status:'COMPLETED',
      accessPreparation:{status:'PENDING',reason:'workers_postpaid_publisher_busy'}}));
    await workersCommand(['retention','resume','worker-owned'],{env:'preview',format:'table'});
    expect(api.fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(api.fetchSpy.mock.calls[0][1].body)).toEqual({action:'resume'});
    expect(api.logSpy.mock.calls.map(args=>String(args[0])).join('\n')).toContain('do not repeat recovery');
  } finally {api.restore();}
});

test('explicit Queue consumer configure/disable commands pass scoped native intent to the backend',async()=>{
  const api=mockApi();
  try {
    const body={queue:'jobs',max_batch_size:50,max_batch_timeout:0,max_retries:0,retry_delay:0};
    await workersCommand(['resources','queue-consumer','configure','worker/owned','queue/owned'],{env:'preview',body:JSON.stringify(body)});
    const [url,init]=api.fetchSpy.mock.calls[0];
    expect(String(url)).toEndWith('/workers/worker%2Fowned/environments/preview/resources/queue%2Fowned/queue-consumer');
    expect(init.method).toBe('PUT');expect(JSON.parse(init.body)).toEqual(body);
    await workersCommand(['resources','queue-consumer','disable','worker/owned','queue/owned'],{env:'preview'});
    expect(api.fetchSpy.mock.calls[1][1].method).toBe('DELETE');
  } finally {api.restore();}
});

test('paused Queue commands print saved/disabled receipts without resuming or probing', async () => {
  const api = mockApi();
  const configured = { status: 'CONFIGURED', activation: 'ON_RESUME', paused: true };
  const disabled = { status: 'DISABLED', paused: true };
  try {
    api.fetchSpy.mockResolvedValueOnce(Response.json(configured)).mockResolvedValueOnce(Response.json(disabled));
    const body = { queue: 'jobs', max_batch_size: 7 };
    await workersCommand(['resources', 'queue-consumer', 'configure', 'worker-owned', 'queue-owned'],
      { env: 'preview', body: JSON.stringify(body), format: 'json' });
    expect(JSON.parse(String(api.logSpy.mock.calls[0][0]))).toEqual(configured);
    expect(api.fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(api.fetchSpy.mock.calls[0][1].body)).toEqual(body);
    await workersCommand(['resources', 'queue-consumer', 'disable', 'worker-owned', 'queue-owned'],
      { env: 'preview', format: 'json' });
    expect(JSON.parse(String(api.logSpy.mock.calls[1][0]))).toEqual(disabled);
    expect(api.fetchSpy.mock.calls.map(([url, init]: any[]) => [new URL(url).pathname, init.method])).toEqual([
      ['/api/v1/workers/worker-owned/environments/preview/resources/queue-owned/queue-consumer', 'PUT'],
      ['/api/v1/workers/worker-owned/environments/preview/resources/queue-owned/queue-consumer', 'DELETE'],
    ]);
    expect(api.logSpy.mock.calls.map(args => String(args[0])).join('\n')).not.toMatch(/running|ACTIVE/);
  } finally { api.restore(); }
});

test('remote build accepts over 200 files, large source and Unicode/space paths inside its actual source/transport budgets',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'xapi-source-budget-')));roots.push(root);
  writeFileSync(join(root,'中文 入口.mjs'),'//'+ '字'.repeat(600_000));
  writeFileSync(join(root,'helper.mjs'),'//'+ 'x'.repeat(2_000_000));
  for(let i=0;i<201;i++)writeFileSync(join(root,`part-${i}.js`),'export {};');
  const api=mockApi();
  try {
    await workersCommand(['build','worker-owned'],{project:root,entrypoint:'中文 入口.mjs',command:'npm run build'});
    expect(api.fetchSpy).toHaveBeenCalledTimes(1);
    const body=JSON.parse(api.fetchSpy.mock.calls[0][1].body);
    expect(body.files).toHaveLength(203);expect(body.entrypoint).toBe('中文 入口.mjs');
    expect(body.files.find((file:any)=>file.path==='helper.mjs').content.length).toBeGreaterThan(1_000_000);
    expect(body.files.find((file:any)=>file.path==='中文 入口.mjs').content).toStartWith('//字');
  } finally {api.restore();}
});

test('remote source build rejects an oversized JSON transport before sending rather than accepting an untransmittable upload',async()=>{
  const api=mockApi();
  try {
    expect(()=>createWorkerBuild({apiHost:'test.xapi.to',apiKey:'synthetic-key'},'worker',{files:[{path:'index.mjs',content:'x'.repeat(18*1024*1024),encoding:'utf8'}]})).toThrow('18 MiB transport');
    expect(api.fetchSpy).not.toHaveBeenCalled();
  } finally {api.restore();}
});

test('remote build rejects an aggregate-overflow sparse file before decoding and before any API write',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'xapi-source-sparse-')));roots.push(root);
 const fd=openSync(join(root,'huge.mjs'),'w');ftruncateSync(fd,20*1024*1024+1);closeSync(fd);
 const api=mockApi();const errors=spyOn(console,'error').mockImplementation(()=>{});
 const exit=spyOn(process,'exit').mockImplementation((()=>{throw Error('CLI_EXIT_1');}) as any);
 try{
  await expect(workersCommand(['build','worker-owned'],{project:root,entrypoint:'huge.mjs',command:'npm run build'})).rejects.toThrow('CLI_EXIT_1');
  expect(errors.mock.calls.map(call=>String(call[0])).join(' ')).toContain('20 MiB decoded-content budget');
  expect(api.fetchSpy).not.toHaveBeenCalled();
 }finally{exit.mockRestore();errors.mockRestore();api.restore();}
});
