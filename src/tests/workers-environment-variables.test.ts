import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {importWranglerProject,readWranglerDeploymentSettings} from '../workers-wrangler-import.ts';
import {loadWorkerProject} from '../workers-project.ts';
import {attachWorkerPublicVariables,loadWorkerArtifactInput,normalizeWorkerPublicVariables} from '../workers-artifact.ts';
import {deploymentPrefix} from '../workers-deployment-state.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function workspace(config:unknown) {
  const root=mkdtempSync(join(tmpdir(),'worker-env-vars-')); roots.push(root);
  writeFileSync(join(root,'package.json'),'{}');
  writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify(config));
  return root;
}
test('named environments omit root resources/vars but keep inherited compatibility, assets and crons',()=>{
  const root=workspace({name:'env-worker',main:'index.mjs',compatibility_date:'2026-10-08',compatibility_flags:['nodejs_compat'],
    vars:{ROOT:'default'},secrets:{required:['ROOT_SECRET']},
    kv_namespaces:[{binding:'STATE',id:'external-id'}],
    queues:{producers:[{binding:'JOBS',queue:'root-jobs'}]},
    triggers:{crons:['0 * * * *']},env:{preview:{},production:{kv_namespaces:[{binding:'PROD',id:'prod-id'}],vars:{MODE:'prod'}}}});
  const result=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});expect(result.wrote).toBe(true);
  const project=loadWorkerProject(root);
  expect(project.config.environments.preview.resources).toEqual([]);
  expect(project.config.environments.preview.secrets).toEqual([]);
  expect(project.config.environments.preview.crons).toEqual(['0 * * * *']);
  expect(project.config.environments.production.resources).toEqual([{type:'kv_namespace',bindingName:'PROD'}]);
  expect(readWranglerDeploymentSettings(project,'preview')).toMatchObject({compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],variables:{vars:{}}});
  expect(readWranglerDeploymentSettings(project,'production').variables).toEqual({vars:{MODE:'prod'}});
});
test('default source remains usable in both deployment slots without requiring a named Wrangler environment',()=>{
  const root=workspace({name:'default-worker',main:'index.mjs',vars:{MODE:'default',FLAGS:{chat:true},COUNT:3},secrets:{required:['API_TOKEN']}});
  const result=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});
  expect(result.wrote).toBe(true);
  expect(result.config?.environments.preview.secrets).toEqual(['API_TOKEN']);
  expect(result.config?.environments.production.secrets).toEqual(['API_TOKEN']);
  const project=loadWorkerProject(root);
  for(const env of ['preview','production'] as const)
    expect(readWranglerDeploymentSettings(project,env).variables).toEqual({vars:{COUNT:3,FLAGS:{chat:true},MODE:'default'}});
  expect(readFileSync(project.configPath,'utf8')).not.toContain('"chat"');
});
test('Secret Store references are explicitly unmapped rather than converted to ordinary Secrets',()=>{
  const root=workspace({name:'store-worker',main:'index.mjs',secrets_store_secrets:[{binding:'STORE_KEY',store_id:'store-id',secret_name:'key'}]});
  const result=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc',acceptPartial:true});
  expect(result.config?.environments.preview.secrets).toEqual([]);
  expect(result.report.entries).toContainEqual(expect.objectContaining({category:'UNSUPPORTED',path:'secrets_store_secrets',bindingName:'STORE_KEY'}));
});
test('re-import omits wrongly inherited bindings without losing worker identity or requesting resource deletion',()=>{
  const root=workspace({name:'stable-worker',main:'index.mjs',kv_namespaces:[{binding:'STATE'}]});
  importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});
  const path=join(root,'xapi.worker.json');const old=JSON.parse(readFileSync(path,'utf8'));old.workerId='c29e708a-1e23-4cc5-8ffb-04bf5c6d7fb9';writeFileSync(path,JSON.stringify(old));
  writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({name:'stable-worker',main:'index.mjs',kv_namespaces:[{binding:'STATE'}],env:{production:{}}}));
  const next=importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc',force:true});
  expect(next.config?.workerId).toBe('c29e708a-1e23-4cc5-8ffb-04bf5c6d7fb9');
  expect(next.config?.environments.preview.resources).toHaveLength(1);
  expect(next.config?.environments.production.resources).toEqual([]);
});
test('public variables survive code artifact conversion, canonical hashing and explicit clearing',async()=>{
  const root=workspace({});const path=join(root,'worker.mjs');writeFileSync(path,'export default {}');
  const original=await loadWorkerArtifactInput(path);
  const variables=normalizeWorkerPublicVariables({Z:'last',A:{enabled:true}});
  const artifact=attachWorkerPublicVariables(original,variables);
  if(!('bundle' in artifact.upload))throw Error('Expected bundle');
  expect(artifact.upload.bundle.vars).toEqual({A:{enabled:true},Z:'last'});
  const expected={vars:variables.vars,version:1,mainModule:'index.mjs',modules:[{path:'index.mjs',contentBase64:Buffer.from('export default {}').toString('base64'),contentType:'application/javascript+module'}]};
  expect(artifact.contentSha256).toBe(createHash('sha256').update(JSON.stringify(expected)).digest('hex'));
  const cleared=attachWorkerPublicVariables(artifact,{vars:{}});
  expect('bundle' in cleared.upload && cleared.upload.bundle.vars).toBeUndefined();
  expect(attachWorkerPublicVariables(original,undefined)).toBe(original);
  expect(attachWorkerPublicVariables(original,{vars:{}})).toBe(original);
});
test('promotion clears historical Artifact variables when production has no variables',()=>{
  const root=workspace({name:'promote-worker',main:'index.mjs'});
  importWranglerProject({cwd:root,wranglerPath:'wrangler.jsonc'});
  expect(readWranglerDeploymentSettings(loadWorkerProject(root),'production','application/vnd.xapi.worker-bundle.v1+json').variables).toEqual({vars:{}});
});
test('variable-only changes and explicit empty overrides participate in deployment identity',()=>{
  const prefix=(variables?:{vars:Record<string,unknown>})=>deploymentPrefix('worker','production','same-artifact',{variables},{id:'env'},[],[]);
  expect(prefix()).not.toBe(prefix({vars:{}}));
  expect(prefix({vars:{MODE:'prod'}})).not.toBe(prefix({vars:{MODE:'preview'}}));
  expect(prefix({vars:{A:1,B:2}})).toBe(prefix({vars:{B:2,A:1}}));
});
test('public variable validation rejects lossy JSON and keeps native names including __proto__',()=>{
  const vars=JSON.parse('{"__proto__":{"safe":true},"中文":"值","$key":"text"}');
  expect(normalizeWorkerPublicVariables(vars).vars).toEqual(vars);
  expect(Object.prototype).not.toHaveProperty('safe');
  for(const value of [{A:NaN},{A:undefined},{A:()=>null}])expect(()=>normalizeWorkerPublicVariables(value)).toThrow('JSON');
  expect(()=>normalizeWorkerPublicVariables({A:'text'},{A:['json']})).toThrow('varTypes');
});
