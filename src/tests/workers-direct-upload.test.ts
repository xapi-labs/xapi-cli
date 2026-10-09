import {afterEach,describe,expect,it} from 'bun:test';
import {createServer,type Server} from 'node:http';
import {createHash} from 'node:crypto';
import {uploadDirectWorkerArtifact} from '../workers-direct-upload.ts';

const servers:Server[]=[];
afterEach(async()=>{
  await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>{
    server.close(()=>resolve());server.closeAllConnections();
  })));
});
const bytes=Buffer.from('export default {fetch(){return new Response("test")}}');
const sha=createHash('sha256').update(bytes).digest('hex');
const input={idempotencyKey:'direct-test-artifact',moduleCode:bytes.toString('utf8')};
async function fixture(mode:'normal'|'bad-channel'|'bad-checksum'|'reject'|'redirect'|'stall'|'lost-confirm'='normal') {
  const calls:Array<{method:string,path:string,key?:string,body:Buffer}>=[];
  let host='';let upload=0;
  const server=createServer(async(req,res)=>{
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
      if(mode==='lost-confirm'){res.writeHead(200,{'content-type':'application/json'});res.end('{');return;}
      res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'artifact',contentSha256:sha}));return;
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
describe('Worker direct upload with real HTTP channels',()=>{
  it('sends only bytes/checksum to the object channel and confirms once',async()=>{
    const f=await fixture();expect(await uploadDirectWorkerArtifact(input,f.apiUrl,headers)).toMatchObject({id:'artifact',contentSha256:sha});
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
