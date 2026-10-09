import {expect,test,afterEach} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {normalizeWorkerNativeMetadata,workerNativeUploadMetadata} from '../workers-native-metadata.ts';
import {attachWorkerNativeMetadata,loadWorkerArtifactInput,workerArtifactMultipart,validateNativeDeploymentMetadata,normalizeWorkerObservability} from '../workers-artifact.ts';
import {deploymentPrefix} from '../workers-deployment-state.ts';
import {importWranglerProject,readWranglerDeploymentSettings} from '../workers-wrangler-import.ts';
import {loadWorkerProject} from '../workers-project.ts';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
test('ordinary fields and nested future fields remain lossless without runtime option allowlists',()=>{
 const input={placement:{mode:'targeted',region:'aws:us-east-1'},limits:{cpu_ms:4000,new_native_budget:0},
  observability:{enabled:true,logs:{persist:false,future_setting:{enabled:true}}},logpush:false,cache_options:{enabled:true,new_native_cache:true},future_option:{versions:[1,false,null]}};
 expect(normalizeWorkerNativeMetadata(input)).toEqual(input);expect(workerNativeUploadMetadata(input)).toEqual(input);
 expect(normalizeWorkerNativeMetadata(undefined)).toBeUndefined();expect(normalizeWorkerNativeMetadata({})).toEqual({});
});
test('credentials, resource references and platform deployment identity cannot enter ordinary configuration',()=>{
 for(const key of ['bindings','assets','migrations','exports','containers','main_module','compatibility_date'])
  expect(()=>normalizeWorkerNativeMetadata({[key]:{foreign:'reference'}})).toThrow('owned deployment mapping');
 expect(()=>normalizeWorkerNativeMetadata({tags:['xapi-deployment:foreign']})).toThrow('platform deployment identity');
 expect(()=>normalizeWorkerNativeMetadata({observability:{traces:{destinations:['foreign']}}})).toThrow('owned destination');
 expect(()=>normalizeWorkerNativeMetadata({keep_bindings:['kv_namespace']})).toThrow('owned deployment mapping');
});
test('lossy values reject, while undefined and explicit empty intent remain distinct',()=>{
 for(const value of [null,[],{x:undefined},{x:Infinity},{x:NaN},{x:1n}])expect(()=>normalizeWorkerNativeMetadata(value)).toThrow();
 const cyclic:any={};cyclic.x=cyclic;expect(()=>normalizeWorkerNativeMetadata(cyclic)).toThrow('lossless JSON');
 const prefix=(nativeMetadata?:Record<string,unknown>)=>deploymentPrefix('w','preview','a',{nativeMetadata},{},[],[]);
 expect(prefix()).not.toBe(prefix({}));expect(prefix({limits:{cpu_ms:10},logpush:false})).toBe(prefix({logpush:false,limits:{cpu_ms:10}}));
 expect(prefix({limits:{cpu_ms:10}})).not.toBe(prefix({limits:{cpu_ms:20}}));
});
test('Artifact/multipart preserve native configuration, canonical identity and built-in version binding',async()=>{
 const root=mkdtempSync(join(tmpdir(),'native-config-artifact-'));roots.push(root);writeFileSync(join(root,'index.mjs'),'export default {}');
 const original=await loadWorkerArtifactInput(join(root,'index.mjs'));
 expect(attachWorkerNativeMetadata(original,undefined)).toBe(original);expect(attachWorkerNativeMetadata(original,{})).toBe(original);
 const metadata={placement:{mode:'smart'},limits:{cpu_ms:4000},version_metadata:{binding:'RELEASE'},keep_bindings:['plain_text','json']};
 const a=attachWorkerNativeMetadata(original,metadata);if(!('bundle' in a.upload))throw Error('bundle');
 expect(a.upload.bundle.versionMetadata).toEqual({binding:'RELEASE'});expect(a.upload.bundle.keepBindings).toEqual(['plain_text','json']);
 const stored={nativeMetadata:normalizeWorkerNativeMetadata(metadata),versionMetadata:{binding:'RELEASE'},keepBindings:['plain_text','json'],version:1,mainModule:'index.mjs',modules:[{path:'index.mjs',contentBase64:Buffer.from('export default {}').toString('base64'),contentType:'application/javascript+module'}]};
 expect(a.contentSha256).toBe(createHash('sha256').update(JSON.stringify(stored)).digest('hex'));
 const manifest=JSON.parse(String(workerArtifactMultipart({...a.upload,idempotencyKey:'native-meta-test'}).get('manifest')));expect(manifest.nativeMetadata).toEqual(metadata);
 expect(attachWorkerNativeMetadata(a,{}).upload).toEqual(expect.objectContaining({bundle:expect.objectContaining({nativeMetadata:{}})}));
 expect(workerNativeUploadMetadata(metadata)).toEqual({limits:{cpu_ms:4000},placement:{mode:'smart'}});
});
test('Wrangler placement, limits, public retention and version binding are no longer reported ignored',()=>{
 const root=mkdtempSync(join(tmpdir(),'native-config-wrangler-'));roots.push(root);writeFileSync(join(root,'package.json'),'{}');
 writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'native-metadata',main:'index.mjs',compatibility_date:'2026-10-08',placement:{mode:'smart'},limits:{cpu_ms:4000},logpush:false,env:{preview:{version_metadata:{binding:'RELEASE'},keep_vars:true},production:{placement:{mode:'off'},limits:{cpu_ms:8000},keep_vars:false}}}));
 const imported=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});expect(imported.wrote).toBe(true);
 expect(imported.report.entries.filter(x=>['placement','limits','logpush'].includes(x.path)).every(x=>x.category==='SUPPORTED')).toBe(true);
 const project=loadWorkerProject(root);expect(readWranglerDeploymentSettings(project,'preview').nativeMetadata).toEqual({placement:{mode:'smart'},limits:{cpu_ms:4000},logpush:false,version_metadata:{binding:'RELEASE'},keep_bindings:['plain_text','json']});
 expect(readWranglerDeploymentSettings(project,'production').nativeMetadata).toEqual({placement:{mode:'off'},limits:{cpu_ms:8000},logpush:false,keep_bindings:[]});
});

test('unknown Wrangler configuration requires native compilation instead of being silently discarded',async()=>{
 const root=mkdtempSync(join(tmpdir(),'future-native-config-'));roots.push(root);writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'index.mjs'),'export default {}');
 writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'future-native',main:'index.mjs',compatibility_date:'2026-10-08',future_option:{enabled:true}}));
 const imported=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});expect(imported.wrote).toBe(true);
 expect(imported.report.entries).toContainEqual(expect.objectContaining({path:'future_option',category:'REENTER'}));
 const settings=readWranglerDeploymentSettings(loadWorkerProject(root),'preview');expect(settings.nativeBundleRequired).toEqual(['future_option']);
 const plain=await loadWorkerArtifactInput(join(root,'index.mjs'));expect(()=>validateNativeDeploymentMetadata(plain,settings,[])).toThrow('native bundle is required');
 expect(()=>validateNativeDeploymentMetadata({...plain,nativeMetadata:{future_option:{enabled:true},compatibility_date:'2026-10-08',bindings:[]}},settings,[])).not.toThrow();
});
test('legacy observability preserves future options and historical ordering with the same ownership guard',()=>{
 expect(normalizeWorkerObservability({redact_query_string:true,logs:{future_option:0}})).toEqual({redact_query_string:true,logs:{future_option:0}});
 expect(()=>normalizeWorkerObservability({logs:{destinations:['foreign']}})).toThrow('owned destination');
 expect(()=>normalizeWorkerObservability({logs:{bad:NaN}})).toThrow('lossless JSON');
});

test('legacy future observability canonical identity is independent of input order',async()=>{
 const root=mkdtempSync(join(tmpdir(),'legacy-obs-canonical-'));roots.push(root);writeFileSync(join(root,'index.mjs'),'export default {}');const plain=await loadWorkerArtifactInput(join(root,'index.mjs'));
 const {attachWorkerObservability}=await import('../workers-artifact.ts');
 const a=attachWorkerObservability(plain,{enabled:true,redact_query_string:true,logs:{persist:false,enabled:true}});
 const b=attachWorkerObservability(plain,{logs:{enabled:true,persist:false},redact_query_string:true,enabled:true});expect(a.contentSha256).toBe(b.contentSha256);
 const stored={observability:{enabled:true,logs:{enabled:true,persist:false},redact_query_string:true},version:1,mainModule:'index.mjs',modules:[{path:'index.mjs',contentBase64:Buffer.from('export default {}').toString('base64'),contentType:'application/javascript+module'}]};expect(a.contentSha256).toBe(createHash('sha256').update(JSON.stringify(stored)).digest('hex'));
});

test('owned Tail intent is retained across Wrangler settings, artifact and deployment identity',async()=>{
 const root=mkdtempSync(join(tmpdir(),'owned-tail-config-'));roots.push(root);writeFileSync(join(root,'package.json'),'{}');writeFileSync(join(root,'index.mjs'),'export default {}');
 const tails=[{service:'my-log-worker',environment:'production'}];
 writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'owned-tail-source',main:'index.mjs',tail_consumers:tails}));
 const imported=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});expect(imported.wrote).toBe(true);
 const settings=readWranglerDeploymentSettings(loadWorkerProject(root),'preview');expect(settings.nativeMetadata?.tail_consumers).toEqual(tails);
 expect(settings.nativeBundleRequired).toBeUndefined();
 const artifact=attachWorkerNativeMetadata(await loadWorkerArtifactInput(join(root,'index.mjs')),settings.nativeMetadata);
 if(!('bundle' in artifact.upload))throw Error('bundle');expect(artifact.upload.bundle.nativeMetadata?.tail_consumers).toEqual(tails);
 expect(workerNativeUploadMetadata(settings.nativeMetadata).tail_consumers).toBeUndefined();
 expect(()=>normalizeWorkerNativeMetadata({tail_consumers:[{service:'foreign',namespace:'other-account'}]})).toThrow('platform-owned');
 expect(()=>normalizeWorkerNativeMetadata({tail_consumers:[{service:'logger',environment:'staging'}]})).toThrow('preview/production');
});
