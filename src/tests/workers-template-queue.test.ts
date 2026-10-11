import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWorkerProject } from '../workers-init.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xapi-template-native-queue-'))); roots.push(root);
  const project = initWorkerProject({ cwd: root, target: 'native-queue', template: 'persistent-agent' });
  const build = await Bun.build({ entrypoints: [join(project.rootDir, 'src/index.ts')], outdir: join(root, 'out'), format: 'esm', target: 'browser' });
  expect(build.success).toBe(true);
  return (await import(build.outputs[0].path)).default;
}
function database(fail = false) {
  const stored = new Map<string,unknown>();
  return { stored, DB: { prepare(sql:string) { expect(sql).toContain('INSERT OR IGNORE');return { bind(...values:unknown[]) { return { async run() { if(fail)throw Error('D1 unavailable');if(!stored.has(String(values[0])))stored.set(String(values[0]),values[2]);return{}; } }; } }; } } };
}
function message(value: unknown) {
  let acked = 0; let retried = 0;
  return { id: 'message', body: value, ack(){acked++;}, retry(){retried++;}, receipt:()=>({acked,retried}) };
}
async function submit(worker:any, env:any) {
  const response = await worker.fetch(new Request('https://example.test/queue', { method:'POST',headers:{authorization:'Bearer app-fixture', 'content-type':'application/json'},body:JSON.stringify({kind:'task'}) }),env);
  expect(response.status).toBe(202);return response.json();
}

test('persistent-agent handles native queue bodies, verifies signatures and acks only after idempotent D1 completion',async()=>{
  const worker=await fixture();const db=database();const sent:unknown[]=[];
  const env={APP_TOKEN:'app-fixture',DB:db.DB,TASK_QUEUE:{send:async(value:unknown)=>sent.push(value)}};
  const task=await submit(worker,env);expect(sent).toHaveLength(1);expect(sent[0]).not.toHaveProperty('path');
  const first=message(sent[0]);await worker.queue({queue:'TASK_QUEUE',messages:[first]},env,{});
  expect(first.receipt()).toEqual({acked:1,retried:0});expect(db.stored.has(task.taskId)).toBe(true);
  const repeated=message(sent[0]);await worker.queue({queue:'TASK_QUEUE',messages:[repeated]},env,{});
  expect(repeated.receipt()).toEqual({acked:1,retried:0});expect(db.stored.size).toBe(1);
  const forged=message({...sent[0] as any,signature:'wrong'});await worker.queue({messages:[forged]},env,{});
  expect(forged.receipt()).toEqual({acked:0,retried:1});expect(db.stored.size).toBe(1);
});

test('native queue retries a failed D1 write and accepts the previous signed template envelope during rollout',async()=>{
  const worker=await fixture();const sent:unknown[]=[];const env={APP_TOKEN:'app-fixture',DB:database(true).DB,TASK_QUEUE:{send:async(value:unknown)=>sent.push(value)}};
  await submit(worker,env);const failed=message(sent[0]);await worker.queue({messages:[failed]},env,{});expect(failed.receipt()).toEqual({acked:0,retried:1});
  const db=database();const legacy=message({path:'/queue-consume',body:sent[0]});await worker.queue({messages:[legacy]},{...env,DB:db.DB},{});
  expect(legacy.receipt()).toEqual({acked:1,retried:0});expect(db.stored.size).toBe(1);
  const arbitrary=message({path:'https://foreign.example/',body:{task:'unsigned'}});await worker.queue({messages:[arbitrary]},{...env,DB:db.DB},{});
  expect(arbitrary.receipt()).toEqual({acked:0,retried:1});expect(db.stored.size).toBe(1);
});
