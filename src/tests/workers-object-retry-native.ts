import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {uploadDirectWorkerArtifact} from '../workers-direct-upload.ts';
import {workerArtifactDirectUpload} from '../workers-artifact.ts';

// Real Node sockets, accelerated idle fixtures only; this is not R2 acceptance.
const scenario = process.argv[2];
const single = scenario !== 'healthy' && !['lost-response','permanent-reset','503'].includes(scenario);
const bodyCancel = scenario === 'cancel-body';
const input = {idempotencyKey:'retry-fixture',bundle:{version:1 as const,mainModule:'0.mjs',
  modules:Array.from({length:single ? 1 : 40},(_,i)=>({path:`${i}.mjs`,content:`export const n=${i};/*${'a'.repeat(bodyCancel ? 32*1024*1024 : 275_571)}*/`,
    encoding:'utf8' as const,contentType:'application/javascript+module' as const}))}};
const prepared=workerArtifactDirectUpload(input);
const files=[...prepared.files];
const target=files[single ? 0 : 5][0];
const attempts=new Map<string,number>();
const checked=new Set<string>();
const targetTimes:number[]=[];
let prepare=0,confirm=0,deploy=0,active=0,peak=0,retryNotBefore=0,origin='';
const failures:unknown[]=[];
const messages:string[]=[];
const caller=new AbortController();
let abortAt=0;
const abort = () => {abortAt=Date.now();caller.abort(new Error('fixture cancelled'));};
const movingTimers=new Set<ReturnType<typeof setInterval>>();
const start=Date.now();
const expiry = ['expired','expiry-backoff'].includes(scenario) ? start + (scenario==='expired' ? -1 : 300) :
  scenario==='expiry-moving' ? start+350 : start+30_000;
const signedDate = new Date(scenario==='signed-expired' ? 0 : start).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'');
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url!,origin);
    if(!url.pathname.startsWith('/object/')) {
      assert.equal(req.headers['xapi-key'],'synthetic-control-key');
      for await(const _ of req) {} // drain control body for keep-alive
      res.setHeader('content-type','application/json');
      if(url.pathname.endsWith('/confirm')) {
        confirm++;assert.equal(checked.size,files.length);
        res.end(JSON.stringify({id:'artifact',workerId:'w',...prepared.identity}));return;
      }
      if(url.pathname.endsWith('/deploy')) {deploy++;res.end('{}');return;}
      prepare++;
      res.end(JSON.stringify({uploadId:'same-session',expiresAt:scenario==='invalid-expiry' ? 'invalid' : new Date(expiry).toISOString(),nextCursor:null,
        files:files.map(([sha256,b])=>({sha256,size:b.length,
          url:origin+'/object/'+sha256+'?X-Amz-Signature=synthetic-private'+
            (scenario.startsWith('signed-') ? `&X-Amz-Date=${signedDate}&X-Amz-Expires=${scenario==='signed-invalid' ? 'NaN' : scenario==='signed-expired' ? '1' : '2'}` : ''),
          headers:{'x-amz-checksum-sha256':Buffer.from(sha256,'hex').toString('base64'),'x-amz-meta-owned':'same-header'}}))}));return;
    }
    active++;peak=Math.max(peak,active);res.once('close',()=>active--);
    const hash=url.pathname.split('/').at(-1)!;
    const n=(attempts.get(hash)||0)+1;attempts.set(hash,n);
    assert.equal(req.headers['xapi-key'],undefined);assert.equal(req.headers.authorization,undefined);
    assert.equal(req.headers['x-amz-meta-owned'],'same-header');
    assert.equal(req.headers['x-amz-checksum-sha256'],Buffer.from(hash,'hex').toString('base64'));
    if(hash===target)targetTimes.push(Date.now());
    if(bodyCancel) {req.pause();setTimeout(abort,20);return;}
    let length=0;const digest=createHash('sha256');
    for await(const chunk of req){length+=chunk.length;digest.update(chunk);}
    assert.equal(length,prepared.files.get(hash)!.length);assert.equal(digest.digest('hex'),hash);
    checked.add(hash);
    if(hash===target) {
      if(scenario==='cancel-response'){setTimeout(abort,20);return;}
      if(scenario==='expiry-moving'||scenario==='signed-moving') {
        res.writeHead(200);res.write('.');
        const timer=setInterval(()=>res.write('.'),50);movingTimers.add(timer);
        res.once('close',()=>{clearInterval(timer);movingTimers.delete(timer);});return;
      }
      if(scenario==='idle-once' && n===1)return;
      if(scenario==='permanent-reset'||(n===1 && ['lost-response','cancel-backoff','deadline-backoff','expiry-backoff'].includes(scenario))) {
        req.socket.destroy();return;
      }
      if(['403','redirect'].includes(scenario)) {
        res.writeHead(scenario==='403' ? 403 : 307, {location:'https://private.invalid/?secret=synthetic-private'});
        res.end('provider-secret synthetic-private');return;
      }
      if(n===1 && ['408','429-seconds','429-date','500','502','503','504','long-hint','long-hint-fit','overflow-hint'].includes(scenario)) {
        const status=scenario.startsWith('429') ? 429 : scenario.startsWith('long-hint') || scenario==='overflow-hint' ? 503 : Number(scenario);
        const headers:Record<string,string>={};
        if(scenario==='429-seconds') {headers['retry-after']='1';retryNotBefore=Date.now()+1000;}
        if(scenario==='429-date') {headers['retry-after']=new Date(Date.now()+2100).toUTCString();retryNotBefore=Date.parse(headers['retry-after']);}
        if(scenario==='long-hint')headers['retry-after']='30';
        if(scenario==='long-hint-fit') {headers['retry-after']='9';retryNotBefore=Date.now()+9000;}
        if(scenario==='overflow-hint')headers['retry-after']='9'.repeat(320);
        res.writeHead(status,headers);res.end('provider-secret synthetic-private');return;
      }
    }
    res.end();
  } catch(error) {failures.push(error);res.destroy();}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
origin='http://127.0.0.1:'+(server.address() as any).port;
const timeoutMs=scenario==='deadline-backoff' ? 300 : scenario==='long-hint' ? 1500 : scenario==='long-hint-fit' ? 14_000 : 10_000;
let error:any,value:any;
try {
  value=await uploadDirectWorkerArtifact(input,origin+'/workers/w/artifact-uploads',{'XAPI-Key':'synthetic-control-key'},
    timeoutMs,caller.signal,message=>{
      messages.push(message);
      if(scenario==='cancel-backoff' && message.startsWith('Retrying'))setTimeout(abort,20);
    });
}catch(failure){error=failure;}
finally {
  for(const timer of movingTimers)clearInterval(timer);
  await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
}
assert.deepEqual(failures,[]);assert.equal(prepare,1);assert.equal(deploy,0);assert.ok(peak<=8);
const attemptsAtTarget=attempts.get(target)||0;
const successful=['healthy','lost-response','503','408','429-seconds','429-date','500','502','504','idle-once','long-hint-fit'].includes(scenario);
if(successful) {
  assert.equal(error,undefined);assert.equal(value.contentSha256,prepared.identity.contentSha256);assert.equal(confirm,1);
  assert.equal(checked.size,files.length);assert.equal(attemptsAtTarget,scenario==='healthy' ? 1 : 2);
  assert.equal([...attempts.values()].reduce((a,b)=>a+b,0),files.length+(scenario==='healthy' ? 0 : 1));
  if(scenario!=='healthy')assert.ok(messages.some(message=>message.startsWith('Worker object recovered after 2/3')));
  if(retryNotBefore)assert.ok(targetTimes[1]>=retryNotBefore,`${targetTimes[1]} < ${retryNotBefore}`);
}else {
  assert.ok(error);assert.equal(confirm,0);
  const none=['invalid-expiry','expired','signed-expired','signed-invalid'].includes(scenario);
  assert.equal(attemptsAtTarget,none ? 0 : scenario==='permanent-reset' ? 3 : 1);
  if(scenario==='permanent-reset') {
    assert.equal(error.recovery.attemptCount,3);
    assert.equal(error.recovery.code,'UND_ERR_SOCKET');assert.equal(error.recovery.firstFailure.code,'UND_ERR_SOCKET');
    assert.equal(checked.size,files.length); // healthy siblings were not cancelled on the first fault
  }
  if(['expired','signed-expired','expiry-backoff','expiry-moving','signed-moving'].includes(scenario))
    assert.equal(error.recovery.failureType,'authorization_expired');
  if(['deadline-backoff','long-hint','overflow-hint'].includes(scenario))assert.equal(error.recovery.failureType,'deadline_exceeded');
  if(['403','redirect'].includes(scenario))assert.equal(error.recovery.httpStatus,scenario==='403' ? 403 : 307);
  if(scenario.startsWith('cancel-')){assert.ok(abortAt);assert.ok(Date.now()-abortAt<750);}
}
const publicOutput=JSON.stringify({messages,message:error?.message,recovery:error?.recovery});
for(const secret of ['synthetic-private','provider-secret','private.invalid','synthetic-control-key'])assert.ok(!publicOutput.includes(secret));
process.stdout.write(JSON.stringify({scenario,prepare,confirm,deploy,peak,attemptsAtTarget,checked:checked.size,
  elapsedMs:Date.now()-start,retryNotBefore,targetTimes,messages,error:error ? {message:error.message,recovery:error.recovery} : undefined})+'\n');
