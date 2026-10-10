import {afterAll,afterEach,describe,expect,it} from 'bun:test';
import {createServer,type Server} from 'node:http';
import {createHash} from 'node:crypto';
import {uploadDirectWorkerArtifact} from '../workers-direct-upload.ts';
import {workerArtifactDirectUpload,type WorkerArtifactUploadRequest} from '../workers-artifact.ts';
import {cleanupNativeWorkerUpload,cleanupNativeWorkerUploadChildren,nativeWorkerUpload} from './workers-direct-upload-native.ts';
afterAll(cleanupNativeWorkerUpload);

const servers:Server[]=[];
const nativeServers:Array<{stop(closeActiveConnections?:boolean):void}>=[];
afterEach(async()=>{
  await cleanupNativeWorkerUploadChildren();
  for(const server of nativeServers.splice(0))server.stop(true);
  await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>{
    server.close(()=>resolve());server.closeAllConnections();
  })));
});
const bytes=Buffer.from('export default {fetch(){return new Response("test")}}');
const sha=createHash('sha256').update(bytes).digest('hex');
const input={idempotencyKey:'direct-test-artifact',moduleCode:bytes.toString('utf8')};
async function fixture(mode:'normal'|'bad-channel'|'bad-checksum'|'reject'|'reject-confirm'|'redirect'|'stall'|'lost-confirm'='normal') {
  const calls:Array<{method:string,path:string,key?:string,body:Buffer}>=[];
  let host='';let upload=0;
  const server=createServer(async(req,res)=>{
    res.setHeader('connection','close');
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const body=Buffer.concat(chunks);
    const path=req.url!;calls.push({method:req.method!,path,key:req.headers['xapi-key'] as string,body});
    if(path.startsWith('/object/')){
      if(mode==='stall')return;
      if(mode==='reject'){res.writeHead(403);res.end('bad authorization');return;}
      if(mode==='redirect'){res.writeHead(307,{Location:host+'/unexpected'});res.end();return;}
      expect(req.headers['x-amz-checksum-sha256']).toBe(Buffer.from(sha,'hex').toString('base64'));
      expect(body).toEqual(bytes);res.end();return;
    }
    if(path.endsWith('/confirm')){
      if(mode==='reject-confirm'){res.writeHead(400);res.end('Worker object is missing or has wrong checksum');return;}
      if(mode==='lost-confirm'){res.writeHead(200,{'content-type':'application/json'});res.end('{');return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'artifact',contentSha256:sha,sizeBytes:bytes.length}));return;
    }
    const id='upload-'+(++upload);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({uploadId:id,
      expiresAt:new Date(Date.now()+900000).toISOString(),nextCursor:null,
      files:[{sha256:sha,size:bytes.length,url:mode==='bad-channel'?'https://attacker.example/upload':host+'/object/'+id,
        headers:{'x-amz-checksum-sha256':mode==='bad-checksum'?'wrong':Buffer.from(sha,'hex').toString('base64')}}]}));
  });servers.push(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  host='http://127.0.0.1:'+(server.address() as any).port;
  return {apiUrl:host+'/api/v1/workers/w/artifact-uploads',calls};
}
const headers={'XAPI-KEY':'private-api-key','Content-Type':'application/json'};

type RecoveryMode='normal'|'ready'|'compact'|'pending'|'expired'|'wrong-hash'|'wrong-size'|'wrong-owner'|'wrong-key'|'unknown'|'old-api'|'delayed-confirm'|'async-confirm'|'failed-confirm';
async function recoveryFixture(mode:RecoveryMode,requestInput:WorkerArtifactUploadRequest=input) {
  const prepared=workerArtifactDirectUpload(requestInput);
  const files=[...prepared.files].map(([sha256,content])=>({sha256,size:content.length}));
  const artifact={id:'immutable-artifact',workerId:'w',idempotencyKey:requestInput.idempotencyKey,...prepared.identity};
  const calls={prepare:0,put:0,pages:[] as number[],confirm:0,status:0};
  let host='';
  const json=(value:unknown)=>Response.json(value);
  const page=(cursor:number)=>({uploadId:'owned-session',expiresAt:new Date(Date.now()+900000).toISOString(),
    nextCursor:cursor+128<files.length?cursor+128:null,
    files:files.slice(cursor,cursor+128).map(file=>({...file,url:host+'/object/'+file.sha256,
      headers:{'x-amz-checksum-sha256':Buffer.from(file.sha256,'hex').toString('base64')}}))});
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
    const path=new URL(req.url).pathname+new URL(req.url).search;
    const body=Buffer.from(await req.arrayBuffer());
    if(path.startsWith('/object/')) {
      calls.put++;expect(req.headers.get('xapi-key')??undefined).toBeUndefined();
      const sha256=path.split('/').at(-1)!;
      expect(req.headers.get('x-amz-checksum-sha256')).toBe(Buffer.from(sha256,'hex').toString('base64'));
      expect(body.equals(prepared.files.get(sha256)!)).toBe(true);
      return new Response();
    }
    if(path.endsWith('/status')) {
      calls.status++;
      if(mode==='old-api')return new Response(null,{status:404});
      if(mode==='failed-confirm')return json({uploadId:'owned-session',status:'FAILED',error:{code:'worker_artifact_integrity_failed',status:400}});
      if(mode==='async-confirm'&&calls.status<3)return json({uploadId:'owned-session',status:'CONFIRMING',progress:{stage:'VERIFYING',completedFiles:calls.status,totalFiles:3}});
      if(mode==='pending'||(mode==='delayed-confirm'&&calls.status===1))return json({uploadId:'owned-session',status:'UPLOADING'});
      if(mode==='expired'||mode==='unknown')return json({uploadId:'owned-session',status:mode==='expired'?'EXPIRED':'UNKNOWN'});
      return json({uploadId:'owned-session',status:'READY',artifact:{...artifact,
        ...(mode==='wrong-hash'?{contentSha256:'0'.repeat(64)}:{}),
        ...(mode==='wrong-size'?{sizeBytes:artifact.sizeBytes+1}:{}),
        ...(mode==='wrong-owner'?{workerId:'someone-else'}:{}),
        ...(mode==='wrong-key'?{idempotencyKey:'different-upload'}:{})}});
    }
    if(path.endsWith('/confirm')) {
      calls.confirm++;
      if(mode==='async-confirm'||mode==='failed-confirm') {expect(JSON.parse(body.toString()).async).toBe(true);return json({uploadId:'owned-session',status:'QUEUED'});}
      if(mode==='delayed-confirm'){return new Response('lost confirmation response',{status:502});}
      return json(artifact);
    }
    if(req.method==='POST') {
      calls.prepare++;
      return json(['normal','delayed-confirm','compact','async-confirm','failed-confirm'].includes(mode)?page(0):{...page(0),files:[],nextCursor:null});
    }
    const cursor=Number(new URL(path,host).searchParams.get('cursor'));calls.pages.push(cursor);
    return json(mode==='normal'?page(cursor):{...page(cursor),files:[],nextCursor:null});
  }});nativeServers.push(server);
  host='http://127.0.0.1:'+server.port;
  return {apiUrl:host+'/api/v1/workers/w/artifact-uploads',calls,artifact};
}
describe('Worker direct upload with real HTTP channels',()=>{
  it.each([128,129,257])('uploads %s unique blobs across full authorization pages, including duplicate paths and zero bytes',async count=>{
    const modules=Array.from({length:count},(_,i)=>({path:`module-${i}.mjs`,content:i===0?'':`export const value=${i};`,encoding:'utf8' as const,contentType:'application/javascript+module' as const}));
    modules.push({...modules[0],path:'duplicate-empty.mjs'},{...modules[1],path:'duplicate-content.mjs'});
    const requestInput={idempotencyKey:'multipage-normal',bundle:{version:1 as const,mainModule:'module-1.mjs',modules}};
    const f=await recoveryFixture('normal',requestInput);
    expect(await nativeWorkerUpload(requestInput,f.apiUrl,headers)).toEqual(f.artifact);
    expect(f.calls.put).toBe(count);expect(f.calls.confirm).toBe(1);expect(f.calls.status).toBe(0);
    expect(f.calls.pages).toEqual(count>256?[128,256]:count>128?[128]:[]);
  },30_000);
  it('polls durable confirmation without resending PUT or confirmation',async()=>{
    const f=await recoveryFixture('async-confirm');
    expect(await nativeWorkerUpload(input,f.apiUrl,headers)).toEqual(f.artifact);
    expect(f.calls).toMatchObject({prepare:1,put:1,confirm:1,status:3});
  });
  it('preserves a terminal validation failure instead of deploying or replaying',async()=>{
    const f=await recoveryFixture('failed-confirm');
    await expect(nativeWorkerUpload(input,f.apiUrl,headers)).rejects.toThrow('worker_artifact_integrity_failed');
    expect(f.calls.confirm).toBe(1);expect(f.calls.put).toBe(1);
  });
  it('uses bounded parallel PUTs and reuses object connections across a page',async()=>{
    const modules=Array.from({length:40},(_,i)=>({path:`${i}.mjs`,content:`export const n=${i};`,
      encoding:'utf8' as const,contentType:'application/javascript+module' as const}));
    const requestInput={idempotencyKey:'parallel-keepalive',bundle:{version:1 as const,mainModule:'0.mjs',modules}};
    const prepared=workerArtifactDirectUpload(requestInput);let host='',active=0,peak=0,puts=0;
    const sockets=new Set<unknown>();
    const server=createServer(async(req,res)=>{
      const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const body=Buffer.concat(chunks);const path=req.url!;
      if(path.startsWith('/object/')) {
        sockets.add(req.socket);active++;peak=Math.max(peak,active);puts++;
        const hash=path.split('/').at(-1)!;expect(body.equals(prepared.files.get(hash)!)).toBe(true);
        expect(req.headers['xapi-key']).toBeUndefined();
        await new Promise(resolve=>setTimeout(resolve,20));active--;res.end();return;
      }
      res.setHeader('content-type','application/json');
      if(path.endsWith('/confirm'))res.end(JSON.stringify({id:'parallel-artifact',workerId:'w',...prepared.identity}));
      else res.end(JSON.stringify({uploadId:'parallel-session',expiresAt:new Date(Date.now()+900000),nextCursor:null,
        files:[...prepared.files].map(([sha256,bytes])=>({sha256,size:bytes.length,url:host+'/object/'+sha256,
          headers:{'x-amz-checksum-sha256':Buffer.from(sha256,'hex').toString('base64')}}))}));
    });servers.push(server);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));host='http://127.0.0.1:'+(server.address() as any).port;
    expect(await nativeWorkerUpload(requestInput,host+'/api/v1/workers/w/artifact-uploads',headers)).toHaveProperty('id');
    expect(puts).toBe(40);expect(peak).toBeGreaterThan(1);expect(peak).toBeLessThanOrEqual(8);
    expect(sockets.size).toBeLessThanOrEqual(8);
  });
  it('recovers an already confirmed session using its owned immutable identity without PUT or confirm',async()=>{
    const f=await recoveryFixture('ready');
    expect(await uploadDirectWorkerArtifact(input,f.apiUrl,headers)).toEqual(f.artifact);
    expect(f.calls).toEqual({prepare:1,put:0,pages:[],confirm:0,status:1});
  });
  it('recovers READY after compaction between pages with more than 128 distinct blobs',async()=>{
    const modules=Array.from({length:257},(_,i)=>({path:`module-${i}.mjs`,content:`export const value=${i};`,encoding:'utf8' as const,contentType:'application/javascript+module' as const}));
    const requestInput={idempotencyKey:'multipage-compact',bundle:{version:1 as const,mainModule:'module-0.mjs',modules}};
    const f=await recoveryFixture('compact',requestInput);
    expect(await nativeWorkerUpload(requestInput,f.apiUrl,headers)).toEqual(f.artifact);
    expect(f.calls).toEqual({prepare:1,put:128,pages:[128],confirm:0,status:1});
  },30_000);
  it.each(['wrong-hash','wrong-size','wrong-owner','wrong-key'] as const)('rejects READY with %s',async mode=>{
    const f=await recoveryFixture(mode);
    await expect(uploadDirectWorkerArtifact(input,f.apiUrl,headers)).rejects.toThrow('does not match the upload identity');
    expect(f.calls.confirm).toBe(0);expect(f.calls.put).toBe(0);
  });
  it.each(['pending','expired','old-api'] as const)('keeps missing files a failure when status is %s',async mode=>{
    const f=await recoveryFixture(mode);
    await expect(uploadDirectWorkerArtifact(input,f.apiUrl,headers)).rejects.toThrow('Worker upload has missing files');
    expect(f.calls.status).toBe(1);expect(f.calls.confirm).toBe(0);
  });
  it('rejects unknown status without repeating prepare or confirmation',async()=>{
    const f=await recoveryFixture('unknown');
    await expect(uploadDirectWorkerArtifact(input,f.apiUrl,headers)).rejects.toThrow('Invalid Worker upload status');
    expect(f.calls.prepare).toBe(1);expect(f.calls.confirm).toBe(0);
  });
  it('waits briefly for an in-flight confirmation and recovers READY without replaying it',async()=>{
    const f=await recoveryFixture('delayed-confirm');
    expect(await uploadDirectWorkerArtifact(input,f.apiUrl,headers)).toEqual(f.artifact);
    expect(f.calls).toEqual({prepare:1,put:1,pages:[],confirm:1,status:2});
  },30_000);
  it('sends only bytes/checksum to the object channel and confirms once',async()=>{
    const f=await fixture();expect(await uploadDirectWorkerArtifact(input,f.apiUrl,headers)).toMatchObject({id:'artifact',contentSha256:sha,sizeBytes:bytes.length});
    expect(f.calls.map(c=>c.method)).toEqual(['POST','PUT','POST']);
    expect(f.calls[0].key).toBe(headers['XAPI-KEY']);expect(f.calls[1].key).toBeUndefined();
    expect(f.calls[2].key).toBe(headers['XAPI-KEY']);
    expect(f.calls[0].body.toString()).not.toContain(bytes.toString());
  });
  it.each(['bad-channel','bad-checksum'] as const)('rejects invalid %s without sending bytes or confirming',async mode=>{
    const f=await fixture(mode);await expect(uploadDirectWorkerArtifact(input,f.apiUrl,headers)).rejects.toThrow();
    expect(f.calls.length).toBe(1);
  });
  it.each(['reject','redirect'] as const)('does not retry an object %s or follow redirects',async mode=>{
    const f=await fixture(mode);await expect(uploadDirectWorkerArtifact(input,f.apiUrl,headers)).rejects.toThrow('Worker object upload failed');
    expect(f.calls.length).toBe(2);expect(f.calls[1].key).toBeUndefined();
  });
  it('does not replay a lost confirmation',async()=>{
    const f=await fixture('lost-confirm');await expect(uploadDirectWorkerArtifact(input,f.apiUrl,headers)).rejects.toThrow();
    expect(f.calls.filter(c=>c.path.endsWith('/confirm')).length).toBe(1);
  });
  it('preserves missing-byte or checksum rejection from confirmation without replay or status recovery',async()=>{
    const f=await fixture('reject-confirm');
    await expect(uploadDirectWorkerArtifact(input,f.apiUrl,headers)).rejects.toThrow('Worker object is missing or has wrong checksum');
    expect(f.calls.map(c=>c.method)).toEqual(['POST','PUT','POST']);
  });
  it('cancels an upload without confirming and immediately starts a new upload',async()=>{
    const stalled=await fixture('stall');const controller=new AbortController();
    const cancelled=uploadDirectWorkerArtifact(input,stalled.apiUrl,headers,5000,controller.signal);
    const outcome=cancelled.catch(error=>error as Error);
    for(let i=0;i<100&&!stalled.calls.some(c=>c.method==='PUT');i++)await new Promise(r=>setTimeout(r,5));
    controller.abort(new Error('owner cancelled'));expect((await outcome as Error).message).toContain('owner cancelled');
    expect(stalled.calls.some(c=>c.path.endsWith('/confirm'))).toBe(false);
    const next=await fixture();await expect(uploadDirectWorkerArtifact({...input,idempotencyKey:'new-upload-after-exit'},next.apiUrl,headers)).resolves.toMatchObject({id:'artifact'});
  });
});
