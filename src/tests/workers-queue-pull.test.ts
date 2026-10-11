import {afterEach,expect,spyOn,test} from 'bun:test';
import {workerQueueMessages,configureWorkerQueueConsumer} from '../workers-client.ts';
const options={apiHost:'test.xapi.to',apiKey:'unit-queue-pull'};let mock:ReturnType<typeof spyOn>|undefined;
afterEach(()=>mock?.mockRestore());
for(const action of ['pull','ack'] as const)test('native Queue '+action+' forwards once with scoped path and unchanged body',async()=>{
 const body=action==='pull'?{batch_size:100,visibility_timeout_ms:0,future_option:false}:{acks:[{lease_id:'opaque-lease'}],retries:[{lease_id:'opaque-retry',delay_seconds:0}]};
 mock=spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({messages:[],ackCount:1}),{headers:{'content-type':'application/json'}})) as any;
 await workerQueueMessages(options,'worker/id','preview','resource/id',action,body);
 const [url,init]=mock!.mock.calls[0] as any[];expect(url).toBe('https://test.xapi.to/api/v1/workers/worker%2Fid/environments/preview/resources/resource%2Fid/queue/messages/'+action);expect(JSON.parse(init.body)).toEqual(body);expect(init.method).toBe('POST');expect(url).not.toContain('opaque-lease');expect(mock).toHaveBeenCalledTimes(1);
 mock!.mockRejectedValue(new Error('response lost'));await expect(workerQueueMessages(options,'w','preview','q',action,body)).rejects.toThrow('response lost');expect(mock).toHaveBeenCalledTimes(2);
});
test('consumer HTTP Pull configuration needs no logical queue handler or provider credential',async()=>{
 mock=spyOn(globalThis,'fetch').mockResolvedValue(new Response('{}',{headers:{'content-type':'application/json'}})) as any;
 await configureWorkerQueueConsumer(options,'w','preview','q',{type:'http_pull',settings:{batch_size:3,visibility_timeout_ms:1000}});
 const [url,init]=mock!.mock.calls[0] as any[];expect(url).toEndWith('/q/queue-consumer');expect(JSON.parse(init.body)).toEqual({type:'http_pull',settings:{batch_size:3,visibility_timeout_ms:1000}});expect(mock).toHaveBeenCalledTimes(1);
});
