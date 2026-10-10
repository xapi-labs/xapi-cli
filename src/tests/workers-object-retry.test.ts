import {afterAll,expect,it} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {spawn} from 'node:child_process';

let root:string|undefined,runner:Promise<string>|undefined;
afterAll(()=>{if(root)rmSync(root,{recursive:true,force:true});});
async function run(scenario:string) {
  if(!runner)runner=(async()=>{
    root=mkdtempSync(join(resolve(import.meta.dir,'../..'),'.worker-upload-test-'));
    const result=await Bun.build({entrypoints:[join(import.meta.dir,'workers-object-retry-native.ts')],
      outdir:root,target:'node',format:'esm',naming:'runner.mjs',external:['undici']});
    if(!result.success)throw new Error(result.logs.join('\n'));
    return join(root,'runner.mjs');
  })();
  const file=await runner;
  return await new Promise<any>((resolveResult,reject)=>{
    // Accelerated fixture timing; the product's 60s default is unchanged.
    const child=spawn('node',[file,scenario],{env:{...process.env,XAPI_TRANSFER_IDLE_TIMEOUT_MS:'400'},stdio:['ignore','pipe','pipe']});
    let output='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),15_000);
    child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{clearTimeout(timer);code===0?resolveResult(JSON.parse(output)):reject(new Error(stderr||'Node retry fixture timed out'));});
  });
}
for(const scenario of ['healthy','lost-response','permanent-reset','idle-once','408','429-seconds','429-date','500','502','503','504',
  'long-hint','long-hint-fit','403','redirect','cancel-body','cancel-response','cancel-backoff','deadline-backoff','invalid-expiry','expired',
  'expiry-backoff','expiry-moving','signed-expired','signed-invalid','signed-moving'])
  it(`bounded object recovery over real Node HTTP: ${scenario}`,async()=>{
    const result=await run(scenario);expect(result.scenario).toBe(scenario);
  },20_000);
