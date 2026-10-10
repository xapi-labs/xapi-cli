import {existsSync,lstatSync,readFileSync,realpathSync,renameSync,writeFileSync,unlinkSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadWorkerProject,resolveWorkerProjectPath,workerEnvironmentContainers} from './workers-project.ts';
import {readWranglerDeploymentSettings} from './workers-wrangler-import.ts';
import {workerDeploymentConfiguration,type WorkersClientOptions} from './workers-client.ts';

const canonical=(value:unknown):string=>JSON.stringify(value&&typeof value==='object'?
  Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(
    Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,JSON.parse(canonical(v))])):value??null);

// Compare only the empty public-vars envelope as absent. Keep all actual values
// and future envelope fields; the saved native snapshot remains untouched.
const comparable=(field:string,value:unknown):unknown=>{
  if(field==='requiredSecrets')return Array.isArray(value)&&value.every(item=>typeof item==='string')
    ? [...new Set(value)].sort() : value??[];
  if(field==='queueBindingAliases'||field==='nativeMetadata')return value??{};
  if(field==='containers')return value??[];
  if(field!=='variables')return value;
  if(value==null)return {};
  if(typeof value!=='object'||Array.isArray(value))return value;
  return Object.fromEntries(Object.entries(value).filter(([key,item])=>
    !(key==='vars'&&item!==null&&typeof item==='object'&&!Array.isArray(item)&&Object.keys(item).length===0)));
};

/** Pull is read-only remotely. A chosen output saves the complete public
 * deployment snapshot, including unknown native metadata, without rewriting
 * Wrangler build/resource declarations into the different upload-API format. */
export async function pullWorkerDeploymentConfiguration(options:{cwd?:string;configPath?:string;
  environment:'preview'|'production';outputPath?:string;clientOptions:WorkersClientOptions;
  client?:typeof workerDeploymentConfiguration}) {
  const project=loadWorkerProject(options.cwd,options.configPath);
  if(!project.config.workerId)throw new Error('Project has no Worker ID; deploy or link it first');
  const result=await(options.client||workerDeploymentConfiguration)(options.clientOptions,project.config.workerId,options.environment) as any;
  if(!result||result.environment!==options.environment)throw new Error('Invalid Worker deployment configuration');
  if(!result.available)return {...result,differences:[],savedPath:null};
  const remote=result.configuration;
  if(!remote||remote.version!==1)throw new Error('Invalid Worker deployment snapshot');
  const local=readWranglerDeploymentSettings(project,options.environment);
  const comparison={compatibilityDate:local.compatibilityDate,compatibilityFlags:local.compatibilityFlags,
    requiredSecrets:local.requiredSecrets,variables:local.variables,nativeMetadata:local.nativeMetadata,queueBindingAliases:local.queueBindingAliases,
    containers:workerEnvironmentContainers(project.config,options.environment)};
  const differences=Object.entries(comparison).filter(([key,value])=>
    canonical(comparable(key,value))!==canonical(comparable(key,remote[key])))
    .map(([field,local])=>({field,local:local??null,remote:remote[field]??null}));
  let savedPath:string|null=null;
  if(options.outputPath){
    // --output is an explicit local destination, not an upload input. Retain
    // project-relative semantics, and resolve parent aliases before protection.
    const requested=resolve(project.rootDir,options.outputPath);
    const destination=join(realpathSync(dirname(requested)),basename(requested));
    if(lstatSync(destination,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error('Refusing symbolic-link snapshot output');
    const path=existsSync(destination)?realpathSync(destination):destination;
    if(path===project.configPath||path===realpathSync(resolveWorkerProjectPath(project,project.config.wrangler,'wrangler')))
      throw new Error('Choose a separate deployment snapshot output; Wrangler and xapi.worker.json use different formats');
    const before=existsSync(path)?readFileSync(path):null;
    const temp=path+'.'+randomUUID()+'.tmp';
    try{
      writeFileSync(temp,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
      // Best-effort concurrent edit detection; atomic rename prevents partial
      // snapshots, but is not a cross-process compare-and-swap or file lock.
      if(existsSync(path)?(!before||!readFileSync(path).equals(before)):before!==null)
        throw new Error('Snapshot output changed while pulling; rerun to preserve the local change');
      renameSync(temp,path);savedPath=path;
    }finally{if(existsSync(temp))unlinkSync(temp);}
  }
  return {...result,differences,savedPath,nextSteps:['Review configuration differences; resources pull refreshes resource IDs without redeploying']};
}
