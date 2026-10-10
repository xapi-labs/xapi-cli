import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {HttpError} from '../client.ts';
import {WorkerArtifactConfirmationPendingError} from '../workers-direct-upload.ts';
import type {WorkerArtifactUploadRequest} from '../workers-artifact.ts';

// Large HTTP fixtures run the shipped Node transport. Bun's undici socket teardown
// can stall under repeated PUTs; the server and assertions still live in bun:test.
let fixtureRoot:string|undefined;
let runner:Promise<string>|undefined;
const activeChildren=new Set<ChildProcess>();
const NATIVE_PROCESS_TIMEOUT_MS=25_000;
export async function cleanupNativeWorkerUploadChildren() {
  await Promise.all([...activeChildren].map(child=>new Promise<void>(resolveClose=>{
    child.once('close',()=>resolveClose());
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');
  })));
}
export async function cleanupNativeWorkerUpload() {
  await cleanupNativeWorkerUploadChildren();
  if(fixtureRoot)rmSync(fixtureRoot,{recursive:true,force:true});
  fixtureRoot=undefined;runner=undefined;
}
async function nativeRunner() {
  if(!runner)runner=(async()=>{
    fixtureRoot=mkdtempSync(join(resolve(import.meta.dir,'../..'),'.worker-upload-test-'));
    const entry=join(fixtureRoot,'entry.ts');
    writeFileSync(entry,`import {uploadDirectWorkerArtifact} from '../src/workers-direct-upload.ts';
      let raw='';for await(const chunk of process.stdin)raw+=chunk;
      const args=JSON.parse(raw);
      try {const value=await uploadDirectWorkerArtifact(...args);process.stdout.write(JSON.stringify({value}));}
      catch(error) {process.stdout.write(JSON.stringify({error:{name:error.name,message:error.message,status:error.status,recovery:error.recovery}}));}
    `);
    const result=await Bun.build({entrypoints:[entry],outdir:fixtureRoot,target:'node',format:'esm',
      naming:'runner.mjs',external:['undici']});
    if(!result.success)throw new Error('Native Worker upload test runner compilation failed: '+result.logs.join('\n'));
    return join(fixtureRoot,'runner.mjs');
  })();
  return runner;
}

export async function nativeWorkerUpload(input:WorkerArtifactUploadRequest,apiUrl:string,headers:HeadersInit) {
  const file=await nativeRunner();
  const output=await new Promise<string>((resolveOutput,reject)=>{
    const child=spawn('node',[file],{stdio:['pipe','pipe','pipe']});
    activeChildren.add(child);
    let stdout='',stderrBytes=0,timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},NATIVE_PROCESS_TIMEOUT_MS);
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderrBytes+=Buffer.byteLength(chunk);});
    child.once('error',error=>{clearTimeout(timer);activeChildren.delete(child);reject(error);});
    child.stdin.once('error',error=>{child.kill('SIGKILL');reject(new Error('Native Worker upload fixture input failed: '+error.name));});
    child.once('close',(code,signal)=>{
      clearTimeout(timer);activeChildren.delete(child);
      if(code===0&&!timedOut)resolveOutput(stdout);
      else reject(new Error(`Native Worker upload fixture failed: code=${code??'null'}, signal=${signal??'none'}, timedOut=${timedOut}, stderrBytes=${stderrBytes}, stdoutBytes=${Buffer.byteLength(stdout)}`));
    });
    child.stdin.end(JSON.stringify([input,apiUrl,headers,30_000]));
  });
  const result=JSON.parse(output) as {value?:unknown;error?:{name:string;message:string;status?:number;recovery?:Record<string,unknown>}};
  if(result.error) {
    const error=result.error;
    if(error.name==='WorkerArtifactConfirmationPendingError'&&error.recovery) {
      const recovery=error.recovery;
      const failure=recovery.firstFailure as {type:string;status?:number};
      const original=failure.status!==undefined?new HttpError(failure.status,'test transport failure'):
        Object.assign(new Error('test transport failure'),{name:failure.type});
      throw new WorkerArtifactConfirmationPendingError(String(recovery.uploadId),String(recovery.idempotencyKey),
        String(recovery.status),String(recovery.statusEndpoint),original);
    }
    if(error.name==='HttpError'&&error.status!==undefined)throw new HttpError(error.status,error.message);
    throw Object.assign(new Error(error.message),{name:error.name});
  }
  return result.value;
}
