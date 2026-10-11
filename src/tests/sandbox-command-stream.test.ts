import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { sandboxExecStream } from '../sandbox-client.ts';
import { HttpError } from '../client.ts';
const opts={sandboxHost:'localhost:3312',apiKey:'fixture'};
const event={type:'stdout',encoding:'base64',data:Buffer.from([0,255,1]).toString('base64')} as const;
const frames=(events:any[])=>events.map(e=>JSON.stringify(e)+'\n').join('');
let fetchSpy: ReturnType<typeof spyOn>|undefined;
afterEach(()=>fetchSpy?.mockRestore());
describe('CLI full native command client',()=>{
  it('uses loopback provider scope for the same original command POST',async()=>{
    fetchSpy=spyOn(globalThis,'fetch').mockResolvedValue(new Response(frames([{type:'exit',exitCode:0}]),{headers:{'X-Xapi-Command-Stream':'v1'}}));
    for await (const _ of sandboxExecStream({...opts,provider:'daytona'},'box',{command:'original'})) {}
    const [url,init]=fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:3312/providers/daytona/v1/sandboxes/box/commands/stream');
    expect(new Headers(init?.headers).has('host')).toBe(false);
    expect(JSON.parse(String(init?.body)).command).toBe('original');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('keeps binary bytes, cwd and native exit with one original POST',async()=>{
    fetchSpy=spyOn(globalThis,'fetch').mockImplementation((async(url:any,init:any)=>{
      expect(url).toBe('http://localhost:3312/v1/sandboxes/owned/commands/stream');
      expect(JSON.parse(init.body)).toEqual({command:'original',cwd:'/tmp',timeoutSeconds:7200});
      return new Response(frames([event,{type:'exit',exitCode:17}]),{headers:{'X-Xapi-Command-Stream':'v1'}});
    }) as unknown as typeof fetch);
    const received=[];for await(const item of sandboxExecStream(opts,'owned',{command:'original',cwd:'/tmp',timeoutSeconds:7200}))received.push(item);
    expect(received).toEqual([event,{type:'exit',exitCode:17}]);expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('cancels the reader and owned transport on consumer early return',async()=>{
    let aborted=false,cancelled=0;
    fetchSpy=spyOn(globalThis,'fetch').mockImplementation((async(_:any,init:any)=>{
      init.signal.addEventListener('abort',()=>aborted=true,{once:true});
      return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(frames([event])));},cancel(){cancelled++;}}),{headers:{'X-Xapi-Command-Stream':'v1'}});
    }) as unknown as typeof fetch);
    for await(const item of sandboxExecStream(opts,'owned',{command:'original'})){expect(item).toEqual(event);break;}
    expect(aborted).toBe(true);expect(cancelled).toBe(1);expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('preserves a native error instead of returning a fabricated successful exit',async()=>{
    fetchSpy=spyOn(globalThis,'fetch').mockResolvedValue(new Response(frames([event,{type:'error',status:429,message:'native rate limit'}]),{headers:{'X-Xapi-Command-Stream':'v1'}}));
    let thrown:any;try{for await(const _ of sandboxExecStream(opts,'owned',{command:'original'})){} }catch(e){thrown=e;}
    expect(thrown).toBeInstanceOf(HttpError);expect(thrown.status).toBe(429);expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('pre-cancelled commands never start an upstream operation',async()=>{
    fetchSpy=spyOn(globalThis,'fetch');const cancel=new AbortController();cancel.abort();
    await expect(sandboxExecStream(opts,'owned',{command:'original'},cancel.signal).next()).rejects.toThrow();expect(fetchSpy).not.toHaveBeenCalled();
  });
});
