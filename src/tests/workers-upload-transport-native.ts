import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {createArtifactUploadTransport} from '../client.ts';

// Run in Node against real sockets; never a substitute for R2 acceptance.
const scenario = process.argv[2];
const idle = Number(process.env.XAPI_TRANSFER_IDLE_TIMEOUT_MS || 60_000);
const delay = (ms:number) => new Promise(resolve=>setTimeout(resolve,ms));
const large = scenario === 'large' || scenario === 'slow' || scenario === 'body-stall';
const bytes = Buffer.alloc(large ? 32 * 1024 * 1024 : 64, 97);
const checksum = createHash('sha256').update(bytes).digest('base64');
let puts=0, active=0, peak=0, checked=0;
const sockets=new Set<unknown>();
const failures:unknown[]=[];
const server=createServer(async(req,res)=>{
  puts++;active++;peak=Math.max(peak,active);sockets.add(req.socket);
  res.on('close',()=>active--);
  try {
    assert.equal(req.headers['x-amz-checksum-sha256'],checksum);
    assert.equal(req.headers['xapi-key'],undefined);
    assert.equal(req.headers.authorization,undefined);
    if(scenario==='disconnect'){req.socket.destroy();return;}
    if(scenario==='body-stall'){req.pause();return;}
    const hash=createHash('sha256');let received=0;
    for await(const chunk of req){hash.update(chunk);received+=chunk.length;
      if(scenario==='slow')await delay(idle===60_000 ? 140 : 8);
    }
    assert.equal(received,bytes.length);assert.equal(hash.digest('base64'),checksum);checked++;
    if(scenario==='independent'&&req.url?.includes('index=0'))return;
    if(scenario==='response-stall')return;
    if(scenario==='reject'||scenario==='redirect'){
      res.writeHead(scenario==='reject'?403:307,{location:'https://private.invalid/?X-Amz-Signature=secret'});
      res.end('signed URL and credential must never appear');return;
    }
    if(scenario==='response-wait')await delay(idle/2);
    if(scenario==='queue')await delay(idle/5);
    if(scenario==='response-moving'||scenario==='independent'){
      res.writeHead(200);for(let i=0;i<8;i++){res.write('.');await delay(idle/4);}res.end();return;
    }
    res.end();
  }catch(error){failures.push(error);res.destroy();}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const transport=createArtifactUploadTransport();
const start=Date.now(),cpu=process.cpuUsage();let maxRss=process.memoryUsage().rss;
const sample=setInterval(()=>{maxRss=Math.max(maxRss,process.memoryUsage().rss);},20);
try {
  const url='http://127.0.0.1:'+(server.address() as any).port+'/?X-Amz-Signature=secret';
  const count=scenario==='queue'?24:scenario==='independent'?8:1;
  const results=await Promise.allSettled(Array.from({length:count},(_,index)=>transport.upload(url+'&index='+index,bytes,
    {'x-amz-checksum-sha256':checksum},new AbortController().signal)));
  assert.deepEqual(failures,[]);
  const failed=['disconnect','body-stall','response-stall','reject','redirect','independent'].includes(scenario);
  assert.equal(results.filter(result=>result.status==='rejected').length,failed?1:0);
  assert.equal(puts,count);assert.ok(peak<=8);assert.ok(sockets.size<=8);
  if(!failed)assert.equal(checked,count);
  if(scenario==='slow'||scenario==='response-moving')assert.ok(Date.now()-start>idle);
  const error=results[0].status==='rejected'?results[0].reason:undefined;
  if(error){
    const output=JSON.stringify({message:error.message,diagnostic:error.diagnostic});
    assert.ok(!output.includes('secret'));assert.ok(!output.includes('private.invalid'));
    assert.equal(error.diagnostic.objectSizeBytes,bytes.length);
    assert.equal(error.diagnostic.failureType,scenario.endsWith('stall')||scenario==='independent'?'idle_timeout':
      scenario==='disconnect'?'transport_error':'http_error');
    if(scenario==='response-stall'||scenario==='independent'){
      assert.equal(error.diagnostic.phase,'awaiting_response');assert.equal(error.diagnostic.bodySentBytes,bytes.length);
    }
    if(scenario==='body-stall')assert.equal(error.diagnostic.phase,'sending_body');
    if(scenario==='reject'||scenario==='redirect')assert.equal(error.diagnostic.httpStatus,scenario==='reject'?403:307);
    if(scenario==='disconnect')assert.equal(error.diagnostic.code,'UND_ERR_SOCKET');
  }
  process.stdout.write(JSON.stringify({scenario,elapsedMs:Date.now()-start,puts,peak,sockets:sockets.size,
    checked,maxRss,cpuMicros:process.cpuUsage(cpu),error:error?{name:error.name,message:error.message,diagnostic:error.diagnostic}:undefined})+'\n');
}finally{
  clearInterval(sample);await transport.close();
  await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});
}
