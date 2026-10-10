import {afterEach,describe,expect,it} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync,realpathSync,statSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join} from 'node:path';
import {initWorkerProject} from '../workers-init.ts';
import {pullWorkerDeploymentConfiguration} from '../workers-pull.ts';
import {loadWorkerProject,workerEnvironmentContainers} from '../workers-project.ts';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const options={apiHost:'localhost:3000',apiKey:'test'};
function fixture(){const parent=mkdtempSync(join(tmpdir(),'worker-pull-'));roots.push(parent);
  const root=initWorkerProject({cwd:parent,target:'demo'}).rootDir;
  const configPath=join(root,'xapi.worker.json'),config=JSON.parse(readFileSync(configPath,'utf8'));
  config.workerId='12345678-1234-4234-8234-123456789abc';writeFileSync(configPath,JSON.stringify(config));
  const wrangler=join(root,config.wrangler);const source=readFileSync(wrangler,'utf8');
  const remote={environment:'preview',available:true,activeDeploymentId:'v2',source:'confirmed-deployment-snapshot',
    configuration:{version:1,compatibilityDate:'2026-10-01',compatibilityFlags:['nodejs_compat'],
      variables:{vars:{PUBLIC:'remote'}},nativeMetadata:{future_option:{enabled:true}},requiredSecrets:['TOKEN']}};
  return {root,wrangler,source,remote};
}
describe('deployment configuration pull',()=>{
  it('compares effective environment Container clearing, image and rollout overrides',async()=>{
    const f=fixture(),path=join(f.root,'xapi.worker.json');
    const config=JSON.parse(readFileSync(path,'utf8'));
    config.containers=[{name:'app',className:'AppContainer',image:'docker.io/library/nginx:alpine'}];
    for(const env of ['preview','production'])config.environments[env].resources=[{type:'durable_object',bindingName:'APP',className:'AppContainer'}];
    const selected=[{...config.containers[0],image:'docker.io/library/nginx:stable',rolloutActiveGracePeriod:30}];
    for(const override of [undefined,[],selected]) {
      config.environments.preview.containers=override;writeFileSync(path,JSON.stringify(config));
      const effective=workerEnvironmentContainers(loadWorkerProject(f.root).config,'preview');
      const base={cwd:f.root,environment:'preview' as const,clientOptions:options};
      const matching=await pullWorkerDeploymentConfiguration({...base,client:async()=>({...f.remote,
        configuration:{...f.remote.configuration,containers:effective}})});
      expect(matching.differences.some((difference:any)=>difference.field==='containers')).toBe(false);
      const changed=await pullWorkerDeploymentConfiguration({...base,client:async()=>({...f.remote,
        configuration:{...f.remote.configuration,containers:override===undefined?selected:config.containers}})});
      expect(changed.differences).toContainEqual({field:'containers',local:effective,
        remote:override===undefined?selected:config.containers});
    }
    delete config.containers;config.environments.preview.containers=selected;
    delete config.environments.production.containers;writeFileSync(path,JSON.stringify(config));
    const result=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'production',clientOptions:options,
      client:async()=>({...f.remote,environment:'production',configuration:{...f.remote.configuration,containers:selected}})});
    expect(result.differences).toContainEqual({field:'containers',local:[],remote:selected});
  });
  it('compares required Secret names from both project and Wrangler while preserving the complete snapshot',async()=>{
    const f=fixture();const path=join(f.root,'xapi.worker.json');const config=JSON.parse(readFileSync(path,'utf8'));
    config.environments.preview.secrets=['PROJECT_KEY','SHARED_KEY'];writeFileSync(path,JSON.stringify(config));
    const wrangler=JSON.parse(readFileSync(f.wrangler,'utf8'));
    wrangler.secrets={required:['WRANGLER_KEY','SHARED_KEY']};writeFileSync(f.wrangler,JSON.stringify(wrangler));
    const before=readFileSync(f.wrangler,'utf8');
    const remote={...f.remote,configuration:{...f.remote.configuration,requiredSecrets:['REMOTE_KEY','SHARED_KEY'],
      artifactId:'snapshot-artifact',resourceIds:{STATE:'owned-id'},future_field:{enabled:false}}};
    const result=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'preview',clientOptions:options,
      outputPath:'required-secrets.json',client:async()=>remote});
    expect(result.differences).toContainEqual({field:'requiredSecrets',
      local:['PROJECT_KEY','SHARED_KEY','WRANGLER_KEY'],remote:['REMOTE_KEY','SHARED_KEY']});
    expect(result.differences.some((difference:any)=>['artifactId','resourceIds','future_field'].includes(difference.field))).toBe(false);
    expect(JSON.parse(readFileSync(result.savedPath!,'utf8')).configuration).toEqual(remote.configuration);
    expect(readFileSync(f.wrangler,'utf8')).toBe(before);
    expect(readFileSync(path,'utf8')).toBe(JSON.stringify(config));
  });
  it('compares required Secret names as a set and distinguishes clearing requirements from an empty legacy envelope',async()=>{
    const f=fixture();const path=join(f.root,'xapi.worker.json');const config=JSON.parse(readFileSync(path,'utf8'));
    config.environments.preview.secrets=['B','A'];writeFileSync(path,JSON.stringify(config));
    const base={cwd:f.root,environment:'preview' as const,clientOptions:options};
    const ordered=await pullWorkerDeploymentConfiguration({...base,client:async()=>({...f.remote,
      configuration:{...f.remote.configuration,requiredSecrets:['B','A','A']}})});
    expect(ordered.differences.some((difference:any)=>difference.field==='requiredSecrets')).toBe(false);
    config.environments.preview.secrets=[];writeFileSync(path,JSON.stringify(config));
    const cleared=await pullWorkerDeploymentConfiguration({...base,client:async()=>f.remote});
    expect(cleared.differences).toContainEqual({field:'requiredSecrets',local:[],remote:['TOKEN']});
    for(const requiredSecrets of [undefined,null,[]]) {
      const result=await pullWorkerDeploymentConfiguration({...base,client:async()=>({...f.remote,
        configuration:{...f.remote.configuration,requiredSecrets}})});
      expect(result.differences.some((difference:any)=>difference.field==='requiredSecrets')).toBe(false);
    }
  });

  it('reads remote once, displays differences and saves unknown native fields without touching Wrangler',async()=>{
    const f=fixture();let calls=0;
    const result=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'preview',clientOptions:options,
      outputPath:'deployment-snapshot.json',client:async(_options,id,env)=>{calls++;expect(id).toBe('12345678-1234-4234-8234-123456789abc');expect(env).toBe('preview');return f.remote;}});
    expect(calls).toBe(1);expect(result.differences.some((item:any)=>item.field==='nativeMetadata')).toBe(true);
    expect(JSON.parse(readFileSync(result.savedPath!,'utf8')).configuration.nativeMetadata).toEqual({future_option:{enabled:true}});
    expect(readFileSync(f.wrangler,'utf8')).toBe(f.source);
  });
  it('never overwrites the project configuration or a symbolic-link output',async()=>{
    const f=fixture();const base={cwd:f.root,environment:'preview' as const,clientOptions:options,client:async()=>f.remote};
    await expect(pullWorkerDeploymentConfiguration({...base,outputPath:'xapi.worker.json'})).rejects.toThrow('separate');
    symlinkSync(f.wrangler,join(f.root,'linked.json'));
    await expect(pullWorkerDeploymentConfiguration({...base,outputPath:'linked.json'})).rejects.toThrow();
    expect(readFileSync(f.wrangler,'utf8')).toBe(f.source);
  });
  it('exports to explicit parent-relative and absolute destinations with private mode, without changing input boundaries',async()=>{
    const f=fixture();const base={cwd:f.root,environment:'preview' as const,clientOptions:options,client:async()=>f.remote};
    for(const outputPath of ['../parent-evidence.json',join(f.root,'..','absolute-evidence.json')]) {
      const result=await pullWorkerDeploymentConfiguration({...base,outputPath});
      expect(result.savedPath).toBe(join(realpathSync(join(f.root,'..')),outputPath.includes('absolute')?'absolute-evidence.json':'parent-evidence.json'));
      expect(JSON.parse(readFileSync(result.savedPath!,'utf8')).configuration).toEqual(f.remote.configuration);
      expect(statSync(result.savedPath!).mode&0o777).toBe(0o600);
    }
    expect(readFileSync(f.wrangler,'utf8')).toBe(f.source);
    const {loadWorkerProject,resolveWorkerProjectPath}=await import('../workers-project.ts');
    expect(()=>resolveWorkerProjectPath(loadWorkerProject(f.root),'../outside.mjs','build.output')).toThrow('inside the Worker project');
  });
  it('protects configuration through parent directory aliases while allowing ordinary exports through aliases',async()=>{
    const f=fixture();const alias=join(f.root,'..','project-alias');symlinkSync(f.root,alias,'dir');
    const config=readFileSync(join(f.root,'xapi.worker.json'),'utf8');
    const base={cwd:f.root,environment:'preview' as const,clientOptions:options,client:async()=>f.remote};
    await expect(pullWorkerDeploymentConfiguration({...base,outputPath:join(alias,'xapi.worker.json')})).rejects.toThrow('separate');
    await expect(pullWorkerDeploymentConfiguration({...base,outputPath:join(alias,basename(f.wrangler))})).rejects.toThrow('separate');
    const result=await pullWorkerDeploymentConfiguration({...base,outputPath:join(alias,'alias-snapshot.json')});
    expect(result.savedPath).toBe(join(realpathSync(f.root),'alias-snapshot.json'));
    expect(readFileSync(join(f.root,'xapi.worker.json'),'utf8')).toBe(config);expect(readFileSync(f.wrangler,'utf8')).toBe(f.source);
  });
  it('refuses existing and dangling symbolic-link endpoints outside the project without touching their targets',async()=>{
    const f=fixture();const parent=join(f.root,'..'),link=join(parent,'linked-output.json'),dangling=join(parent,'dangling-output.json');
    symlinkSync(f.wrangler,link);symlinkSync(join(parent,'nonexistent.json'),dangling);
    const base={cwd:f.root,environment:'preview' as const,clientOptions:options,client:async()=>f.remote};
    await expect(pullWorkerDeploymentConfiguration({...base,outputPath:link})).rejects.toThrow('symbolic-link');
    await expect(pullWorkerDeploymentConfiguration({...base,outputPath:dangling})).rejects.toThrow('symbolic-link');
    expect(readFileSync(f.wrangler,'utf8')).toBe(f.source);
  });
  it('atomically replaces an explicitly chosen existing snapshot and leaves no temporary file',async()=>{
    const f=fixture();const parent=join(f.root,'..'),output=join(parent,'existing.json');writeFileSync(output,'old snapshot');
    const result=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'preview',clientOptions:options,client:async()=>f.remote,outputPath:output});
    expect(JSON.parse(readFileSync(result.savedPath!,'utf8')).configuration).toEqual(f.remote.configuration);
    expect(readdirSync(parent).some(name=>name.endsWith('.tmp'))).toBe(false);
  });
  it('reports unavailable legacy snapshots without writing fabricated configuration',async()=>{
    const f=fixture();const result=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'preview',clientOptions:options,
      client:async()=>({environment:'preview',available:false,reason:'historical_configuration_unavailable'})});
    expect(result.available).toBe(false);expect(result.savedPath).toBeNull();
  });
  it('compares absent and empty Queue aliases equally without changing the saved native snapshot',async()=>{
    const f=fixture();const remote={...f.remote,configuration:{...f.remote.configuration,queueBindingAliases:{}}};
    const result=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'preview',clientOptions:options,outputPath:'empty-aliases.json',client:async()=>remote});
    expect(result.differences.some((difference:any)=>difference.field==='queueBindingAliases')).toBe(false);
    expect(result.configuration.queueBindingAliases).toEqual({});
    expect(JSON.parse(readFileSync(result.savedPath!,'utf8')).configuration.queueBindingAliases).toEqual({});
    const changed=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'preview',clientOptions:options,client:async()=>({...remote,configuration:{...remote.configuration,queueBindingAliases:{TASKS:'QUEUE'}}})});
    expect(changed.differences).toContainEqual({field:'queueBindingAliases',local:null,remote:{TASKS:'QUEUE'}});
  });
  it('compares absent and empty native metadata equally while retaining real changes and snapshot values',async()=>{
    const f=fixture();
    for(const nativeMetadata of [null,{}]) {
      const remote={...f.remote,configuration:{...f.remote.configuration,nativeMetadata}};
      const result=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'preview',clientOptions:options,
        outputPath:'native-empty.json',client:async()=>remote});
      expect(result.differences.some((difference:any)=>difference.field==='nativeMetadata')).toBe(false);
      expect(JSON.parse(readFileSync(result.savedPath!,'utf8')).configuration.nativeMetadata).toEqual(nativeMetadata);
    }
    const changed=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'preview',clientOptions:options,client:async()=>f.remote});
    expect(changed.differences.some((difference:any)=>difference.field==='nativeMetadata')).toBe(true);
  });
  it('compares absent and empty public vars equally without altering native snapshots',async()=>{
    const f=fixture();
    for(const variables of [undefined,null,{}, {vars:{}}]) {
      const remote={...f.remote,configuration:{...f.remote.configuration,variables}};
      const result=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'preview',clientOptions:options,
        outputPath:'vars-empty.json',client:async()=>remote});
      expect(result.differences.some((difference:any)=>difference.field==='variables')).toBe(false);
      expect(JSON.parse(readFileSync(result.savedPath!,'utf8')).configuration.variables).toEqual(variables);
    }
    for(const variables of [{vars:{EMPTY:''}},{vars:{ZERO:0}},{vars:{FLAG:false}},{vars:{NIL:null}},
      {vars:{},future_field:false},{vars:null}]) {
      const remote={...f.remote,configuration:{...f.remote.configuration,variables}};
      const result=await pullWorkerDeploymentConfiguration({cwd:f.root,environment:'preview',clientOptions:options,
        outputPath:'vars-real.json',client:async()=>remote});
      expect(result.differences).toContainEqual({field:'variables',local:null,remote:variables});
      expect(JSON.parse(readFileSync(result.savedPath!,'utf8')).configuration.variables).toEqual(variables);
    }
  });
});
