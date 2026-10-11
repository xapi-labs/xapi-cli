// Node conformance for the shipped Undici transport; all traffic stays on loopback.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
import { mkdtempSync, realpathSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { request } from 'undici/index.js';
import { exportWorkerData, streamExportDownload, DataExportError, type DownloadTransport } from '../workers-data-export.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(),'workers-export-native-')));
const payload = gzipSync(Buffer.from('SQL-fixture '.repeat(10000)));
const sockets = new Set<number>();
let requests = 0, mode = 'reuse';
const timers: ReturnType<typeof setTimeout>[] = [];
const server = createServer((req,res) => {
  requests++; sockets.add(req.socket.remotePort!);
  for (const name of ['xapi-key','authheader','authorization','cookie']) assert.equal(req.headers[name],undefined);
  assert.equal(req.headers['if-match'],'"opaque-native-multipart-2"');
  if (mode === 'redirect') { res.writeHead(307,{location:'https://evil.invalid/?SIGNED_SECRET'});res.end('SECRET_PROVIDER');return; }
  if (mode === 'idle') {res.writeHead(200,{etag:'"opaque-native-multipart-2"'});res.write('x');return;}
  res.writeHead(200,{etag:'"opaque-native-multipart-2"','content-length':String(payload.length),'content-encoding':'gzip',
    'content-type':'application/sql','x-amz-meta-native':'retained','set-cookie':'NEVER_RETAIN'});
  let offset=0;
  const send=()=>{
    if(offset>=payload.length){res.end();return;}
    res.write(payload.subarray(offset,offset+32));offset+=32;
    timers.push(setTimeout(send,mode==='stream'?70:10));
  };send();
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=(server.address() as {port:number}).port;
const agents=new Set<unknown>();
const transport=((url,options)=>{
  assert.match(String(url),/^https:\/\/native\.r2\.cloudflarestorage\.com\//);
  assert.equal(options!.maxRedirections,0);assert.equal(options!.method,'GET');
  agents.add(options!.dispatcher);
  return request(`http://127.0.0.1:${port}/object`,options);
}) as DownloadTransport;
const descriptor={method:'GET',url:'https://native.r2.cloudflarestorage.com/object?SIGNED_SECRET',expiresAt:new Date(Date.now()+60_000).toISOString(),headers:{'If-Match':'"opaque-native-multipart-2"'}};
const object={key:'../unicode/中文',size:payload.length,etag:'opaque-native-multipart-2'};
try{
  const result=await exportWorkerData('r2',{
    listWorkerResources:async()=>[{id:'r',bindingName:'DB',status:'ACTIVE',type:'R2_BUCKET'}],
    workerDataExportRequest:async(_options,_worker,_env,_resource,path)=>path.startsWith('/r2/export-objects')?
      {objects:Array.from({length:12},(_,i)=>({...object,key:object.key+i})),nextCursor:null}:descriptor,
  },{apiHost:'test.xapi.to',apiKey:'SECRET_XAPI'},
  {workerId:'w',environment:'preview',binding:'DB',output:join(root,'objects')},{downloadTransport:transport});
  assert.equal(result.completed,12);assert.equal(agents.size,1);assert.equal(sockets.size,4);assert.equal(requests,12);
  assert.equal(JSON.stringify(result).includes('SIGNED_SECRET'),false);
  mode='stream';
  const output=join(root,'stream');const file=await open(output,'wx',0o600);
  let writes=0;
  try{
    const pending=streamExportDownload(descriptor,{write:async(buffer:Buffer,offset:number,size:number)=>{
      writes++;return file.write(buffer,offset,Math.min(7,size));},sync:()=>file.sync()} as any,object,
      {transport,budgets:{connect:2000,idle:200}});
    await new Promise(resolve=>setTimeout(resolve,150));
    assert(statSync(output).size>0);assert(statSync(output).size<payload.length);
    const receipt=await pending;assert.equal(receipt.bytes,payload.length);assert(readFileSync(output).equals(payload));assert(writes>10);
    assert.equal(receipt.headers['content-encoding'],'gzip');assert.equal(receipt.headers['x-amz-meta-native'],'retained');assert.equal(receipt.headers['set-cookie'],undefined);
  }finally{await file.close();}
  for(const scenario of ['redirect','idle']){
    mode=scenario;const file=await open(join(root,scenario),'wx',0o600);const before:number=requests;
    try{
      await assert.rejects(streamExportDownload(descriptor,file,undefined,{transport,budgets:{connect:2000,idle:50}}),(error:unknown)=>{
        assert(error instanceof DataExportError);assert.equal(error.message.includes('SECRET'),false);
        if(scenario==='redirect')assert.equal(error.details.httpStatus,307);
        else assert.match(error.message,/timed out/);return true;
      });assert.equal(requests,before+1);
    }finally{await file.close();}
  }
  process.stdout.write(JSON.stringify({status:'passed',checks:['Node streaming','partial writes','credential isolation','raw metadata','redirect rejection','idle timeout','four connection reuse']}));
}finally{
  for(const timer of timers)clearTimeout(timer);
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true});
}
