import {afterAll,expect,test} from 'bun:test';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';

const contract=JSON.parse(readFileSync(new URL('./fixtures/workers-billing/workers-billing-usage-v1.json',import.meta.url),'utf8'));
let root:string|undefined,entry:Promise<string>|undefined;
afterAll(()=>{if(root)rmSync(root,{recursive:true,force:true});});
async function runner() {
  if(!entry)entry=(async()=>{
    root=mkdtempSync(join(resolve(import.meta.dir,'../..'),'.worker-usage-test-'));
    const result=await Bun.build({entrypoints:[join(import.meta.dir,'../index.ts')],outdir:root,target:'node',format:'esm',
      naming:'cli.mjs',external:['undici','@openai/agents','acorn','busboy','jsonc-parser','smol-toml','zod']});
    if(!result.success)throw new Error(result.logs.join('\n'));return join(root,'cli.mjs');
  })();return entry;
}

for(const scenario of ['human','legacy','changed-context'])test(`real Node CLI default usage read: ${scenario}`,async()=>{
  const calls:Array<Record<string,string>>=[];
  const server=createServer((req,res)=>{
    expect(req.method).toBe('GET');expect(req.headers['xapi-key']).toBe('synthetic-usage-key');
    const url=new URL(req.url!,'http://127.0.0.1');calls.push(Object.fromEntries(url.searchParams));
    const value=structuredClone(contract.examples.tail117);
    if(scenario==='legacy') {
      delete value.data.totals;delete value.data.pagination;value.dataQuality='COMPLETE';
      value.data.buckets.forEach((bucket:any)=>{delete bucket.summaries;bucket.facts=[{metric:'WORKER_REQUEST',quantity:'3'}];});
    }else {
      value.data.buckets=[value.data.buckets[calls.length===1 ? 0 : 1]];
      value.data.pagination={hasMore:calls.length===1,nextCursor:calls.length===1 ? 'opaque+/= cursor' : null};
      if(scenario==='changed-context' && calls.length===2)value.snapshotId='different';
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify(value));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const file=await runner(),env={...process.env};
    for(const key of Object.keys(env))if(/API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY/i.test(key))delete env[key];
    env.XAPI_KEY='synthetic-usage-key';env.XAPI_API_HOST='127.0.0.1:'+(server.address() as any).port;
    const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolveResult,reject)=>{
      const child=spawn('node',[file,'workers','billing','usage','example-worker','--env','preview'],{env,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';const timer=setTimeout(()=>child.kill('SIGKILL'),20_000);
      child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
      child.on('error',error=>{clearTimeout(timer);reject(error);});
      child.on('close',code=>{clearTimeout(timer);resolveResult({code,stdout,stderr});});
    });
    if(scenario==='changed-context'){expect(result.code).not.toBe(0);expect(result.stdout).toBe('');expect(result.stderr).toContain('complete usage read unavailable');}
    else {
      expect(result.code).toBe(0);expect(result.stdout).toContain('xAPI Worker Billing · Usage');
      expect(result.stdout).toContain('Data quality            INDETERMINATE');expect(result.stdout).toContain('Complete through (UTC)  —');
      if(scenario==='human'){
        expect(calls).toHaveLength(2);expect(calls[1]).toMatchObject({snapshotTime:contract.examples.tail117.snapshotTime,
          from:contract.examples.tail117.data.from,to:contract.examples.tail117.data.to,metric:'WORKER_REQUEST',cursor:'opaque+/= cursor'});
        expect(result.stdout).toContain('Quantity                117');expect(result.stdout).toContain('Quantity                114');
        expect(result.stdout.match(/Quantity                117/g)).toHaveLength(1);
      }else {expect(calls).toHaveLength(1);expect(result.stdout).toContain('Legacy usage observations');}
    }
    expect(result.stdout+result.stderr).not.toContain('synthetic-usage-key');
  } finally {await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
},30_000);
