import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

test('maps Wrangler inherit bindings only through one declared xAPI resource',async()=>{
 const path=bundle([{...metadata,content:JSON.stringify({main_module:'index.js',compatibility_date:'2026-09-10',bindings:[{name:'DB',type:'inherit'}]})},entry]);
 const a=await loadWorkerArtifactInput(path);
 expect(()=>validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10'},[])).toThrow('DB');
 validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10'},[{bindingName:'DB',type:'d1_database'}]);
 expect(JSON.stringify(a.upload)).not.toContain('inherit');
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

test('accepts Wrangler package diagnostics and the declared static assets binding', async () => {
 const path = bundle([{...metadata, content:JSON.stringify({
   ...JSON.parse(metadata.content),
   bindings:[{name:'ASSETS',type:'assets'}],
   package_dependencies:[{name:'wrangler',packageJsonVersion:'^4.135.0',installedVersion:'4.135.0'}],
 })},entry]);
 const assets = join(dirname(path), 'public');
 mkdirSync(assets);
 writeFileSync(join(assets, 'index.html'), '<h1>Jev Trader</h1>');
 const a = await loadWorkerArtifactInput(path, undefined, {
   directory: assets,
   binding: 'ASSETS',
 });
 validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']},[]);
 expect(JSON.stringify(a.upload)).not.toContain('package_dependencies');
});

test('rejects undeclared native assets bindings and malformed package diagnostics', async () => {
 const assetMetadata = {...metadata, content:JSON.stringify({
   ...JSON.parse(metadata.content),
   bindings:[{name:'ASSETS',type:'assets'}],
 })};
 await expect(loadWorkerArtifactInput(bundle([assetMetadata,entry]))).rejects.toThrow('binding metadata');
 await expect(loadWorkerArtifactInput(bundle([{...metadata, content:JSON.stringify({
   ...JSON.parse(metadata.content),
   package_dependencies:[{name:'wrangler',installedVersion:'4.135.0',unexpected:true}],
 })},entry]))).rejects.toThrow('package dependency');
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

test('maps local native Durable Object bindings by binding and class, not a foreign namespace', async () => {
 const binding = {name:'API_CONTAINER', type:'durable_object_namespace', class_name:'ApiContainer'};
 const native = {...metadata, content:JSON.stringify({...JSON.parse(metadata.content), bindings:[binding]})};
 const artifact = await loadWorkerArtifactInput(bundle([native,entry]));
 const settings = {compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']};
 validateNativeDeploymentMetadata(artifact,settings,[{type:'durable_object',bindingName:'API_CONTAINER',className:'ApiContainer'}]);
 expect(() => validateNativeDeploymentMetadata(artifact,settings,[{type:'durable_object',bindingName:'API_CONTAINER',className:'WrongClass'}])).toThrow('API_CONTAINER');
 expect(() => validateNativeDeploymentMetadata(artifact,settings,[])).toThrow('API_CONTAINER');
 for (const foreign of [{script_name:'another-worker'}, {namespace_id:'another-namespace'}, {environment:'production'}]) {
  await expect(loadWorkerArtifactInput(bundle([{...native,content:JSON.stringify({...JSON.parse(native.content), bindings:[{...binding,...foreign}]})},entry]))).rejects.toThrow('mapping');
 }
});


test("carries native public string and JSON vars in immutable artifact identity", async () => {
  const vars = {
    PUBLIC_ORIGIN: "https://app.example",
    FEATURES: { images: true },
    RETRIES: 3,
    enabled: false,
  };
  const make = (bindings: unknown[]) =>
    bundle([
      {
        ...metadata,
        content: JSON.stringify({
          ...JSON.parse(metadata.content),
          bindings,
        }),
      },
      entry,
    ]);
  const bindings = Object.entries(vars).map(([name, value]) =>
    typeof value === "string"
      ? { name, type: "plain_text", text: value }
      : { name, type: "json", json: value },
  );
  const artifact = await loadWorkerArtifactInput(make(bindings));
  if (!("bundle" in artifact.upload)) throw Error("bundle");
  expect(artifact.upload.bundle.vars).toEqual(vars);
  const reordered = await loadWorkerArtifactInput(
    make([...bindings].reverse()),
  );
  expect(artifact.contentSha256).toBe(reordered.contentSha256);
  const changed = await loadWorkerArtifactInput(
    make([...bindings, { name: "EXTRA", type: "plain_text", text: "new" }]),
  );
  expect(changed.contentSha256).not.toBe(artifact.contentSha256);
  const settings = {
    compatibilityDate: "2026-09-10",
    compatibilityFlags: ["nodejs_compat"],
  };
  validateNativeDeploymentMetadata(artifact, settings, []);
  expect(() =>
    validateNativeDeploymentMetadata(artifact, settings, [
      { type: "r2_bucket", bindingName: "PUBLIC_ORIGIN" },
    ]),
  ).toThrow("Duplicate");
  await expect(
    loadWorkerArtifactInput(make([...bindings, bindings[0]])),
  ).rejects.toThrow("Duplicate");
  await expect(
    loadWorkerArtifactInput(
      make([
        { name: "XAPI_AI_BASE_URL", type: "plain_text", text: "override" },
      ]),
    ),
  ).rejects.toThrow("reserved");
});
