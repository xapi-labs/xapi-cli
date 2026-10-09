import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { attachWorkerObservability, loadWorkerArtifactInput, normalizeWorkerObservability, validateNativeDeploymentMetadata } from '../workers-artifact.ts';
const roots: string[] = [];
test('Wrangler observability survives plain artifact conversion and changes deployment identity', async () => {
 const root=mkdtempSync(join(tmpdir(),'observability-project-')); roots.push(root);
 const path=join(root,'worker.mjs'); writeFileSync(path,'export default {fetch(){return new Response("ok")}}');
 const original=await loadWorkerArtifactInput(path);
 const config=normalizeWorkerObservability({enabled:true,head_sampling_rate:0.4,logs:{enabled:true,persist:false,invocation_logs:true},traces:{enabled:false}});
 const enabled=attachWorkerObservability(original,config);
 expect('bundle' in enabled.upload && enabled.upload.bundle.observability).toEqual(config);
 expect(enabled.contentSha256).not.toBe(original.contentSha256);
 expect(attachWorkerObservability(original,{enabled:false}).contentSha256).not.toBe(enabled.contentSha256);
 expect(attachWorkerObservability(original,undefined)).toBe(original);
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
function bundle(parts: Array<{name:string; type?:string; content:string|Buffer}>) {
  const root=mkdtempSync(join(tmpdir(),'native-bundle-')); roots.push(root);
  const path=join(root,'worker.bundle'); const boundary='native-test-boundary';
  writeFileSync(path,Buffer.concat(parts.flatMap(p=>[
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.type?`; filename="${p.name}"`:''}\r\n${p.type?`Content-Type: ${p.type}\r\n`:''}\r\n`),
    Buffer.from(p.content),Buffer.from('\r\n'),
  ]).concat([Buffer.from(`--${boundary}--\r\n`)])));
  return path;
}
const metadata={name:'metadata',content:JSON.stringify({main_module:'index.js',compatibility_date:'2026-09-10',compatibility_flags:['nodejs_compat'],bindings:[]})};
const entry={name:'index.js',type:'application/javascript+module',content:'export default {fetch(){return import("./chunk~rsc.js")}};'};
test('preserves native multipart module bytes, names, MIME and computed imports',async()=>{
 const binary=Buffer.from([0,255,10,13,0,128]);
 const a=await loadWorkerArtifactInput(bundle([metadata,entry,{name:'chunk~rsc.js',type:'application/javascript+module',content:'export const load = path => import(path);'},{name:'data.wasm',type:'application/wasm',content:binary}]));
 if(!('bundle' in a.upload)) throw Error('bundle');
 expect(a.upload.bundle.modules.find(m=>m.path==='chunk~rsc.js')?.content).toBe('export const load = path => import(path);');
 expect(a.upload.bundle.modules.find(m=>m.path==='data.wasm')?.content).toBe(binary.toString('base64'));
 validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']},[]);
 expect(()=>validateNativeDeploymentMetadata(a,{compatibilityDate:'2020-01-01'},[])).toThrow('compatibility');
});
test('rejects duplicate names and traversal before upload',async()=>{
 await expect(loadWorkerArtifactInput(bundle([metadata,entry,entry]))).rejects.toThrow('duplicate');
 await expect(loadWorkerArtifactInput(bundle([metadata,entry,{name:'../escape.js',type:entry.type,content:'export{}'}]))).rejects.toThrow('Invalid');
});
test('preserves plain_text and JSON bindings without requiring managed resources or reentering Secrets',async()=>{
 const vars={COUNT:3,FLAGS:{enabled:true},MODE:'prod',JSON_STRING:'json text'};
 const a=await loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({
  main_module:'index.js',compatibility_date:'2026-09-10',compatibility_flags:['nodejs_compat'],
  bindings:[{name:'MODE',type:'plain_text',text:'prod'},{name:'FLAGS',type:'json',json:{enabled:true}},
   {name:'COUNT',type:'json',json:3},{name:'JSON_STRING',type:'json',json:'json text'}]})},entry]));
 if(!('bundle' in a.upload))throw Error('bundle');
 expect(a.upload.bundle.vars).toEqual(vars);
 expect(a.upload.bundle.varTypes).toEqual({JSON_STRING:'json'});
 validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']},[]);
 for(const invalid of [{name:'MODE',type:'plain_text',text:3},{name:'MODE',type:'json'}])
  await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({main_module:'index.js',bindings:[invalid]})},entry]))).rejects.toThrow();
});
test('rejects missing and duplicate metadata',async()=>{
 await expect(loadWorkerArtifactInput(bundle([entry]))).rejects.toThrow('metadata');
 await expect(loadWorkerArtifactInput(bundle([metadata,metadata,entry]))).rejects.toThrow();
});
test('rejects private binding metadata and preserves ordinary native properties',async()=>{
 await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({main_module:'index.js',bindings:[{name:'SECRET',type:'secret_text',text:'test-only'}]})},entry]))).rejects.toThrow('Secrets');
 const loaded=await loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({main_module:'index.js',limits:{cpu_ms:100}})},entry]));
 expect('bundle' in loaded.upload && loaded.upload.bundle.nativeMetadata).toEqual({limits:{cpu_ms:100}});
});
test('requires declared native bindings and own main_module',async()=>{
 const path=bundle([{...metadata,content:JSON.stringify({main_module:'index.js',compatibility_date:'2026-09-10',bindings:[{name:'DB',type:'d1',id:'foreign-id'}]})},entry]);
 const a=await loadWorkerArtifactInput(path);
 expect(()=>validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10'},[])).toThrow('DB');
 validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10'},[{bindingName:'DB',type:'d1_database'}]);
 expect(JSON.stringify(a.upload)).not.toContain('foreign-id');
 await expect(loadWorkerArtifactInput(path,'index.js')).rejects.toThrow('omit');
});

test('preserves ordinary observability options without a field whitelist', async () => {
 const path = bundle([{...metadata, content:JSON.stringify({...JSON.parse(metadata.content),observability:{enabled:true}})},entry]);
 const a = await loadWorkerArtifactInput(path);
 if (!('bundle' in a.upload)) throw Error('bundle');
 expect(a.upload.bundle.nativeMetadata?.observability).toEqual({enabled:true});
 const plain = await loadWorkerArtifactInput(bundle([metadata,entry]));
 expect(a.contentSha256).not.toBe(plain.contentSha256);
 const future=await loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({...JSON.parse(metadata.content),observability:{enabled:true,unknown:true}})},entry]));
 expect('bundle' in future.upload && future.upload.bundle.nativeMetadata?.observability).toEqual({enabled:true,unknown:true});
 await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({...JSON.parse(metadata.content),observability:{logs:{destinations:['foreign-destination']}}})},entry]))).rejects.toThrow('owned destination');
});

test('requires native Container classes to match the explicit xAPI deployment intent', async () => {
 const container = {
  name:'trader', className:'TraderContainer', image:'docker.io/example/trader:v1',
  instanceType:'lite' as const, maxInstances:2, rolloutActiveGracePeriod:0,
 };
 const native = {...metadata, content:JSON.stringify({...JSON.parse(metadata.content),containers:[{class_name:'TraderContainer',name:'wrangler-generated-application'}]})};
 const artifact = await loadWorkerArtifactInput(bundle([native,entry]), undefined, undefined, [container]);
 if (!('bundle' in artifact.upload)) throw Error('bundle');
 expect(artifact.upload.bundle.containers).toEqual([container]);
 const expectedStored = Buffer.from(JSON.stringify({
  containers:[container], version:1, mainModule:'index.js', modules:[{
   path:'index.js', contentBase64:Buffer.from(entry.content).toString('base64'),
   contentType:'application/javascript+module',
  }],
 }));
 expect(artifact.contentSha256).toBe(createHash('sha256').update(expectedStored).digest('hex'));
 expect(artifact.sizeBytes).toBe(expectedStored.length);
 await expect(loadWorkerArtifactInput(bundle([native,entry]), undefined, undefined, [])).rejects.toThrow('Container classes differ');
});

test('maps DO, Queue and Workflow declarations and strips upstream physical identities', async () => {
 const bindings = [
  { name:'ROOM', type:'durable_object_namespace', class_name:'Room', namespace_id:'foreign-ns', script_name:'foreign-script' },
  { name:'EVENTS', type:'queue', queue_name:'foreign-queue' },
  { name:'FLOW', type:'workflow', class_name:'Flow', workflow_name:'foreign-flow', script_name:'foreign-host' },
 ];
 const a = await loadWorkerArtifactInput(bundle([{...metadata, content:JSON.stringify({...JSON.parse(metadata.content), bindings})}, entry]));
 const resources = [{ type:'durable_object', bindingName:'ROOM', className:'Room' }, { type:'queue', bindingName:'EVENTS' }, { type:'workflow', bindingName:'FLOW', className:'Flow' }];
 validateNativeDeploymentMetadata(a, {compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']}, resources);
 expect(JSON.stringify(a)).not.toContain('foreign-');
 expect(() => validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']}, resources.slice(1))).toThrow('ROOM');
 expect(() => validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']},resources.map(r=>({...r,className:'Other'})))).toThrow('class_name');
});

test('does not open private platform targets or duplicate bindings while extending native resources', async () => {
 for (const type of ['service', 'logfwdr', 'dispatch_namespace', 'secret_text']) {
  await expect(loadWorkerArtifactInput(bundle([{...metadata, content:JSON.stringify({main_module:'index.js', bindings:[{name:'PRIVATE',type}]})},entry]))).rejects.toThrow('mapping');
 }
 await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({main_module:'index.js',bindings:[{name:'Q',type:'queue'},{name:'Q',type:'queue'}]})},entry]))).rejects.toThrow('duplicate native binding');
 await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({main_module:'index.js',bindings:[{name:'ROOM',type:'durable_object_namespace'}]})},entry]))).rejects.toThrow('class_name');
});
