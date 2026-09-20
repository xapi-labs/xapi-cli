import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadWorkerArtifactInput, validateNativeDeploymentMetadata } from '../workers-artifact.ts';
const roots: string[] = [];
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
test('rejects missing and duplicate metadata',async()=>{
 await expect(loadWorkerArtifactInput(bundle([entry]))).rejects.toThrow('metadata');
 await expect(loadWorkerArtifactInput(bundle([metadata,metadata,entry]))).rejects.toThrow();
});
test('rejects private binding metadata and unsupported native properties',async()=>{
 await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({main_module:'index.js',bindings:[{name:'SECRET',type:'secret_text',text:'test-only'}]})},entry]))).rejects.toThrow('Secrets');
 await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({main_module:'index.js',limits:{cpu_ms:100}})},entry]))).rejects.toThrow('mapping');
});
test('requires declared native bindings and own main_module',async()=>{
 const path=bundle([{...metadata,content:JSON.stringify({main_module:'index.js',compatibility_date:'2026-09-10',bindings:[{name:'DB',type:'d1',id:'foreign-id'}]})},entry]);
 const a=await loadWorkerArtifactInput(path);
 expect(()=>validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10'},[])).toThrow('DB');
 validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10'},[{bindingName:'DB',type:'d1_database'}]);
 expect(JSON.stringify(a.upload)).not.toContain('foreign-id');
 await expect(loadWorkerArtifactInput(path,'index.js')).rejects.toThrow('omit');
});

test('preserves observability in artifact identity and rejects unmapped settings', async () => {
 const path = bundle([{...metadata, content:JSON.stringify({...JSON.parse(metadata.content),observability:{enabled:true}})},entry]);
 const a = await loadWorkerArtifactInput(path);
 if (!('bundle' in a.upload)) throw Error('bundle');
 expect(a.upload.bundle.observability).toEqual({enabled:true});
 const plain = await loadWorkerArtifactInput(bundle([metadata,entry]));
 expect(a.contentSha256).not.toBe(plain.contentSha256);
 await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({...JSON.parse(metadata.content),observability:{enabled:true,unknown:true}})},entry]))).rejects.toThrow('mapping');
});

test('requires native Container classes to match the explicit xAPI deployment intent', async () => {
 const container = {
  name:'trader', className:'TraderContainer', image:'docker.io/example/trader:v1',
  instanceType:'lite' as const, maxInstances:2, rolloutActiveGracePeriod:0,
 };
 const native = {...metadata, content:JSON.stringify({...JSON.parse(metadata.content),containers:[{class_name:'TraderContainer'}]})};
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
