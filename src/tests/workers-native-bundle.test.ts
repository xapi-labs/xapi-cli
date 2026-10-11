import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

test('maps Wrangler inherit bindings only through one declared xAPI resource',async()=>{
 const path=bundle([{...metadata,content:JSON.stringify({main_module:'index.js',compatibility_date:'2026-09-10',bindings:[{name:'DB',type:'inherit'}]})},entry]);
 const a=await loadWorkerArtifactInput(path);
 expect(()=>validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10'},[])).toThrow('DB');
 validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10'},[{bindingName:'DB',type:'d1_database'}]);
 expect(JSON.stringify(a.upload)).not.toContain('inherit');
});

test('preserves ordinary observability options without a field whitelist', async () => {
 const path = bundle([{...metadata, content:JSON.stringify({...JSON.parse(metadata.content),observability:{enabled:true}})},entry]);
 const a = await loadWorkerArtifactInput(path);
 if (!('bundle' in a.upload)) throw Error('bundle');
 expect(a.upload.bundle.observability).toEqual({enabled:true});
 const plain = await loadWorkerArtifactInput(bundle([metadata,entry]));
 expect(a.contentSha256).not.toBe(plain.contentSha256);
 const future=await loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({...JSON.parse(metadata.content),observability:{enabled:true,unknown:true}})},entry]));
 expect('bundle' in future.upload && future.upload.bundle.observability).toEqual({enabled:true,unknown:true});
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
  { name:'ROOM', type:'durable_object_namespace', class_name:'Room', namespace_id:'foreign-ns' },
  { name:'EVENTS', type:'queue', queue_name:'foreign-queue' },
  { name:'FLOW', type:'workflow', class_name:'Flow', workflow_name:'foreign-flow' },
 ];
 const a = await loadWorkerArtifactInput(bundle([{...metadata, content:JSON.stringify({...JSON.parse(metadata.content), bindings})}, entry]));
 const resources = [{ type:'durable_object', bindingName:'ROOM', className:'Room' }, { type:'queue', bindingName:'EVENTS' }, { type:'workflow', bindingName:'FLOW', className:'Flow' }];
 validateNativeDeploymentMetadata(a, {compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']}, resources);
 expect(JSON.stringify(a.upload)).not.toContain('foreign-');
 expect(() => validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']}, resources.slice(1))).toThrow('ROOM');
 expect(() => validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']},resources.map(r=>({...r,className:'Other'})))).toThrow('class');
});

test('does not open private platform targets or duplicate bindings while extending native resources', async () => {
 for (const type of ['service', 'logfwdr', 'dispatch_namespace', 'secret_text']) {
  await expect(loadWorkerArtifactInput(bundle([{...metadata, content:JSON.stringify({main_module:'index.js', bindings:[{name:'PRIVATE',type}]})},entry]))).rejects.toThrow('mapping');
 }
 await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({main_module:'index.js',bindings:[{name:'Q',type:'queue'},{name:'Q',type:'queue'}]})},entry]))).rejects.toThrow('Duplicate native binding');
 await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({main_module:'index.js',bindings:[{name:'ROOM',type:'durable_object_namespace'}]})},entry]))).rejects.toThrow('class_name');
});

test.each(['ASSETS', 'Assets', 'assets', 'constructor', 'prototype', 'toString', 'hasOwnProperty'])('accepts Wrangler package diagnostics and the declared static assets binding', async (bindingName) => {
 const path = bundle([{...metadata, content:JSON.stringify({
   ...JSON.parse(metadata.content),
   bindings:[{name:bindingName,type:'assets'}],
   package_dependencies:[{name:'wrangler',packageJsonVersion:'^4.135.0',installedVersion:'4.135.0'}],
 })},entry]);
 const assets = join(dirname(path), 'public');
 mkdirSync(assets);
 writeFileSync(join(assets, 'index.html'), '<h1>Jev Trader</h1>');
 const a = await loadWorkerArtifactInput(path, undefined, {
   directory: assets,
   binding: bindingName,
 });
 validateNativeDeploymentMetadata(a,{compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']},[]);
 expect('bundle' in a.upload && a.upload.bundle.nativeMetadata?.package_dependencies).toEqual([{name:'wrangler',packageJsonVersion:'^4.135.0',installedVersion:'4.135.0'}]);
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

test.each(['API_CONTAINER', 'Chat', 'chat', 'constructor', 'prototype', 'toString', 'hasOwnProperty'])('maps local native Durable Object bindings by binding and class, not a foreign namespace', async (bindingName) => {
 const binding = {name:bindingName, type:'durable_object_namespace', class_name:'ApiContainer'};
 const native = {...metadata, content:JSON.stringify({...JSON.parse(metadata.content), bindings:[binding]})};
 const artifact = await loadWorkerArtifactInput(bundle([native,entry]));
 const settings = {compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']};
 validateNativeDeploymentMetadata(artifact,settings,[{type:'durable_object',bindingName,className:'ApiContainer'}]);
 expect(() => validateNativeDeploymentMetadata(artifact,settings,[{type:'durable_object',bindingName,className:'WrongClass'}])).toThrow(bindingName);
 expect(() => validateNativeDeploymentMetadata(artifact,settings,[])).toThrow(bindingName);
 expect(() => validateNativeDeploymentMetadata(artifact,settings,[{type:'durable_object',bindingName:bindingName + '_OTHER',className:'ApiContainer'}])).toThrow(bindingName);
 for (const foreign of [{script_name:'another-worker'}, {environment:'production'}]) {
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

test("accepts more than 200 native modules without changing module names", async () => {
  const chunks = Array.from({ length: 300 }, (_, index) => ({
    name: `chunks/${index}.js`,
    type: "application/javascript+module",
    content: `export const value = ${index};`,
  }));
  const artifact = await loadWorkerArtifactInput(
    bundle([metadata, entry, ...chunks]),
  );
  if (!("bundle" in artifact.upload)) throw Error("bundle");
  expect(artifact.upload.bundle.modules).toHaveLength(301);
  expect(
    artifact.upload.bundle.modules.find((m) => m.path === "chunks/299.js")
      ?.content,
  ).toBe("export const value = 299;");
});

test("accepts a native 64 MiB module set, including multipart overhead, and rejects one extra byte", async () => {
  const data = Buffer.alloc(
    64 * 1024 * 1024 - Buffer.byteLength(entry.content),
    7,
  );
  const artifact = await loadWorkerArtifactInput(
    bundle([
      metadata,
      entry,
      { name: "data.bin", type: "application/octet-stream", content: data },
    ]),
  );
  if (!("bundle" in artifact.upload)) throw Error("bundle");
  expect(
    Buffer.from(
      artifact.upload.bundle.modules.find((m) => m.path === "data.bin")!
        .content,
      "base64",
    ),
  ).toEqual(data);
  await expect(
    loadWorkerArtifactInput(
      bundle([
        metadata,
        entry,
        {
          name: "data.bin",
          type: "application/octet-stream",
          content: Buffer.concat([data, Buffer.from([0])]),
        },
      ]),
    ),
  ).rejects.toThrow("capacity");
}, 30000);

test("preserves native cache/version config and maps required secrets and queue identities", async () => {
  const { withNativeWorkerOptions } = await import("../workers-artifact.ts");
  const options = {
    cacheOptions: { enabled: true, cross_version_cache: false },
    versionMetadata: { binding: "CF_VERSION_METADATA" },
  };
  const a = await loadWorkerArtifactInput(
    bundle([
      {
        ...metadata,
        content: JSON.stringify({
          ...JSON.parse(metadata.content),
          cache_options: options.cacheOptions,
          bindings: [
            { type: "version_metadata", name: "CF_VERSION_METADATA" },
            { type: "inherit", name: "AUTH_SECRET" },
            { type: "queue", name: "JOBS", queue_name: "foreign-queue" },
          ],
        }),
      },
      entry,
    ]),
  );
  if (!("bundle" in a.upload)) throw Error("bundle");
  expect(a.upload.bundle).toMatchObject(options);
  expect(JSON.stringify(a.upload)).not.toContain("foreign-queue");
  const settings = {
    compatibilityDate: "2026-09-10",
    compatibilityFlags: ["nodejs_compat"],
  };
  validateNativeDeploymentMetadata(
    a,
    settings,
    [{ type: "queue", bindingName: "JOBS" }],
    ["AUTH_SECRET"],
  );
  expect(() =>
    validateNativeDeploymentMetadata(a, settings, [
      { type: "queue", bindingName: "JOBS" },
    ]),
  ).toThrow("AUTH_SECRET");
  expect(() =>
    validateNativeDeploymentMetadata(
      a,
      settings,
      [
        { type: "queue", bindingName: "JOBS" },
        { type: "d1_database", bindingName: "CF_VERSION_METADATA" },
      ],
      ["AUTH_SECRET"],
    ),
  ).toThrow("Duplicate");
  expect(withNativeWorkerOptions(a, options)).toBe(a);
  expect(() =>
    withNativeWorkerOptions(a, {
      ...options,
      cacheOptions: { enabled: false },
    }),
  ).toThrow("rebuild");
  expect(() => withNativeWorkerOptions(a, {})).toThrow("rebuild");
  const plain = await loadWorkerArtifactInput(bundle([metadata, entry]));
  expect(a.contentSha256).not.toBe(plain.contentSha256);
});

test("rejects malformed cache settings and unsupported metadata binding fields", async () => {
  for (const cache_options of [
    null,
    { enabled: "true" },
    { enabled: true, cross_version_cache: 1 },
  ]) {
    await expect(
      loadWorkerArtifactInput(
        bundle([
          {
            ...metadata,
            content: JSON.stringify({
              ...JSON.parse(metadata.content),
              cache_options,
            }),
          },
          entry,
        ]),
      ),
    ).rejects.toThrow("cache");
  }
  await expect(
    loadWorkerArtifactInput(
      bundle([
        {
          ...metadata,
          content: JSON.stringify({
            ...JSON.parse(metadata.content),
            bindings: [
              {
                type: "version_metadata",
                name: "VERSION",
                namespace: "foreign",
              },
            ],
          }),
        },
        entry,
      ]),
    ),
  ).rejects.toThrow("mapping");
});

test('maps native Workflow classes through owned resource declarations without retaining physical names', async () => {
 const binding = {name:'PIPELINE',type:'workflow',workflow_name:'upstream-physical-flow',class_name:'Pipeline'};
 const part = {...metadata,content:JSON.stringify({...JSON.parse(metadata.content),bindings:[binding]})};
 const artifact = await loadWorkerArtifactInput(bundle([part,entry]));
 const settings = {compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']};
 validateNativeDeploymentMetadata(artifact,settings,[{type:'workflow',bindingName:'PIPELINE',className:'Pipeline'}]);
 expect(JSON.stringify(artifact.upload)).not.toContain('upstream-physical-flow');
 for (const resource of [[],[{type:'workflow',bindingName:'PIPELINE'}],[{type:'workflow',bindingName:'PIPELINE',className:'Other'}]])
   expect(()=>validateNativeDeploymentMetadata(artifact,settings,resource)).toThrow('PIPELINE');
 for (const extra of [{script_name:'foreign-worker'},{class_name:''},{workflow_name:null}]) {
   await expect(loadWorkerArtifactInput(bundle([{...part,content:JSON.stringify({...JSON.parse(metadata.content),bindings:[{...binding,...extra}]})},entry]))).rejects.toThrow('binding metadata');
 }
});


test('native decoration preserves public JSON-string types and rejects missing or stale emitted options', async () => {
 const {attachWorkerPublicVariables,attachWorkerNativeMetadata} = await import('../workers-artifact.ts');
 const part = {...metadata,content:JSON.stringify({...JSON.parse(metadata.content),
  bindings:[{name:'JSON_STRING',type:'json',json:'hello'}],
  observability:{enabled:false},keep_bindings:['json','plain_text','secret_text'],
  limits:{cpu_ms:100}})};
 const artifact = await loadWorkerArtifactInput(bundle([part,entry]));
 const decorated = attachWorkerPublicVariables(attachWorkerNativeMetadata(artifact,{observability:{enabled:false},keep_bindings:['plain_text','json'],limits:{cpu_ms:100}}),{vars:{JSON_STRING:'hello'}});
 expect(decorated.contentSha256).toBe(artifact.contentSha256);
 expect(decorated.upload).toMatchObject({bundle:{varTypes:{JSON_STRING:'json'},keepBindings:['plain_text','json'],observability:{enabled:false},nativeMetadata:{limits:{cpu_ms:100}}}});
 expect(JSON.stringify(decorated.upload)).not.toContain('secret_text');
 expect(()=>attachWorkerPublicVariables(artifact,{vars:{JSON_STRING:'hello'},varTypes:{JSON_STRING:'plain_text'}})).toThrow('rebuild');
 expect(()=>attachWorkerNativeMetadata(artifact,{keep_bindings:[]})).toThrow('rebuild');
 expect(()=>attachWorkerNativeMetadata(artifact,{limits:{cpu_ms:200}})).toThrow('rebuild');
 const absent = await loadWorkerArtifactInput(bundle([metadata,entry]));
 expect(()=>attachWorkerNativeMetadata(absent,{observability:{enabled:false}})).toThrow('rebuild');
 expect(()=>attachWorkerObservability(absent,{enabled:false})).toThrow('rebuild');
});

test('native namespace IDs are discarded only after their local class matches owned declarations', async () => {
 const binding={name:'ROOM',type:'durable_object_namespace',class_name:'Room',namespace_id:'upstream-namespace'};
 const artifact=await loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({...JSON.parse(metadata.content),bindings:[binding]})},entry]));
 const settings={compatibilityDate:'2026-09-10',compatibilityFlags:['nodejs_compat']};
 expect(JSON.stringify(artifact.upload)).not.toContain('upstream-namespace');
 validateNativeDeploymentMetadata(artifact,settings,[{type:'durable_object',bindingName:'ROOM',className:'Room'}]);
 expect(()=>validateNativeDeploymentMetadata(artifact,settings,[])).toThrow('ROOM');
 expect(()=>validateNativeDeploymentMetadata(artifact,settings,[{type:'durable_object',bindingName:'ROOM',className:'Other'}])).toThrow('ROOM');
 for(const type of ['durable_object_namespace','workflow'])
  await expect(loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({...JSON.parse(metadata.content),bindings:[{name:'REMOTE',type,class_name:'Remote',workflow_name:'remote',script_name:'foreign-worker'}]})},entry]))).rejects.toThrow('existing owned');
});

test('native package diagnostics and unknown cache fields remain lossless JSON', async () => {
 const package_dependencies=[{name:'wrangler',packageJsonVersion:'^4',installedVersion:'4',future_diagnostic:{enabled:false}}];
 const artifact=await loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({...JSON.parse(metadata.content),package_dependencies,cache_options:{enabled:false,future_setting:{ttl:0}}})},entry]));
 expect(artifact.upload).toMatchObject({bundle:{nativeMetadata:{package_dependencies},cacheOptions:{enabled:false,future_setting:{ttl:0}}}});
 const {workerArtifactMultipart}=await import('../workers-artifact.ts');
 const manifest=JSON.parse(String(workerArtifactMultipart({...artifact.upload,idempotencyKey:'opaque-configuration'}).get('manifest')));
 expect(manifest.nativeMetadata.package_dependencies).toEqual(package_dependencies);
 expect(manifest.cacheOptions).toEqual({enabled:false,future_setting:{ttl:0}});
});


test('native built-in version metadata retains one consistent owned binding', async () => {
 const make=(options:Record<string,unknown>)=>loadWorkerArtifactInput(bundle([{...metadata,content:JSON.stringify({...JSON.parse(metadata.content),...options})},entry]));
 const artifact=await make({version_metadata:{binding:'RELEASE'},bindings:[{name:'RELEASE',type:'version_metadata'}]});
 expect(artifact.upload).toMatchObject({bundle:{versionMetadata:{binding:'RELEASE'}}});
 expect('bundle' in artifact.upload && artifact.upload.bundle.nativeMetadata).toBeUndefined();
 await expect(make({version_metadata:{binding:'OTHER'},bindings:[{name:'RELEASE',type:'version_metadata'}]})).rejects.toThrow('differs');
});
