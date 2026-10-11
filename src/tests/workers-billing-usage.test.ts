import {describe,expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {collectWorkerBillingUsage} from '../workers-billing-usage.ts';
import {formatWorkerBillingResponse} from '../workers-billing-output.ts';

// Byte-identical PR394 contract at 8f7071e7; fixtures are local interop evidence,
// not cloud/provider metering acceptance.
const bytes=readFileSync(new URL('./fixtures/workers-billing/workers-billing-usage-v1.json',import.meta.url));
const contract=JSON.parse(bytes.toString());
const example=()=>structuredClone(contract.examples.tail117);
const page=(names:number[],more=false,cursor:string|null=null)=>{
  const value=example(),summary=value.data.buckets[0].summaries[0];
  value.data.totals[0].quantity='2105';
  value.data.buckets=[{...value.data.buckets[0],summaries:names.map(i=>({...summary,resourceKey:'runtime:'+i,quantity:'1',eventCount:'1'}))}];
  value.data.pagination={hasMore:more,nextCursor:cursor};return value;
};

describe('approved default PG usage wire consumption',()=>{
  test('uses the exact stable backend example and renders 117 without claiming full coverage',async()=>{
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('32bd3925302349605fcd843b287d4e909165b6846a55507a7f32672b5d30f155');
    const result=await collectWorkerBillingUsage(async()=>example());
    expect(result).toEqual(example());
    const human=formatWorkerBillingResponse('usage',result);
    expect(human).toContain('Quantity                117');
    expect(human).toContain('Quantity                3');expect(human).toContain('Quantity                114');
    expect(human).toContain('INDETERMINATE');expect(human).toContain('EVENT_FINALITY_NOT_WINDOW_COVERAGE');
    expect(human).toContain('Complete through (UTC)  —');expect(human).toContain('Snapshot time (UTC)');
    expect(human).toContain('EVENT_SUM');expect(human).not.toContain('$0');
  });
  test('reads all 2105 groups by default while retaining one whole-scope total',async()=>{
    const pages=[page(Array.from({length:2000},(_,i)=>i),true,'opaque+/= cursor'),page(Array.from({length:105},(_,i)=>i+2000))];
    const queries:any[]=[];
    const result=await collectWorkerBillingUsage(async query=>{queries.push(query);return pages[queries.length-1];}) as any;
    expect(queries).toHaveLength(2);
    expect(queries[1]).toMatchObject({snapshotTime:pages[0].snapshotTime,from:pages[0].data.from,to:pages[0].data.to,
      metric:'WORKER_REQUEST',cursor:'opaque+/= cursor'});
    expect(result.data.buckets[0].summaries).toHaveLength(2105);
    expect(result.data.totals[0].quantity).toBe('2105');expect(result.data.pagination).toEqual({hasMore:false,nextCursor:null});
  });
  test('binds the first aggregate response to the requested scope, range and filters',async()=>{
    for(const query of [{from:'2026-10-10T08:35:00.000Z'},{to:'2026-10-10T08:55:00.000Z'},
      {metric:'WORKER_CPU_MS'},{resourceId:'other'},{snapshotTime:'2026-10-10T09:00:00.000Z'}])
      await expect(collectWorkerBillingUsage(async()=>example(),query)).rejects.toThrow('complete usage read unavailable');
    await expect(collectWorkerBillingUsage(async()=>example(),{},undefined,{workerId:'other',environment:'preview'})).rejects.toThrow();
    await expect(collectWorkerBillingUsage(async()=>example(),{},undefined,{workerId:'example-worker',environment:'production'})).rejects.toThrow();
  });
  test('has no inherited ledger page cap and never adds cumulative revisions or metrics',async()=>{
    let calls=0;
    const result=await collectWorkerBillingUsage(async()=>{const value=page([calls],calls<104,calls<104 ? 'cursor'+calls : null);
      value.data.totals[0].quantity='118.000000000';value.data.buckets[0].summaries[0].sourceSelection.kind='CUMULATIVE_LATEST';
      value.data.buckets[0].summaries[0].eventCount=null;calls++;return value;}) as any;
    expect(calls).toBe(105);expect(result.data.buckets[0].summaries).toHaveLength(105);
    expect(result.data.totals[0].quantity).toBe('118.000000000');
  });
  test.each(['snapshotId','snapshotTime','workerId','environment','completeThrough','dataQuality','from','to','metric','resourceId','totals','status'])
    ('rejects changed %s across pages instead of reporting a complete read',async field=>{
      const a=page([0],true,'next'),b=page([1]);
      if(field==='status')b.data.buckets[0].status='GAP';
      else if(field==='totals')b.data.totals[0].quantity='999';
      else if(['from','to'].includes(field))b.data[field]=field==='from' ? '2026-10-10T08:35:00.000Z' : '2026-10-10T08:55:00.000Z';
      else if(field==='metric'||field==='resourceId')b.data[field]='changed';
      else b[field]=field==='snapshotTime' ? '2026-10-10T08:55:31.216Z' : field==='completeThrough' ? b.data.from :
        field==='dataQuality' ? 'COMPLETE' : field==='environment' ? 'production' : 'changed';
      let n=0;await expect(collectWorkerBillingUsage(async()=>[a,b][n++])).rejects.toThrow('complete usage read unavailable');
    });
  test.each(['duplicate','repeated-cursor','empty-more','bad-source','bad-quantity','facts','missing-total','missing-cursor'])
    ('rejects inconsistent aggregate pagination: %s',async mode=>{
      const a=page([0],true,'next'),b=page([mode==='duplicate' ? 0 : 1]);
      if(mode==='repeated-cursor')b.data.pagination={hasMore:true,nextCursor:'next'};
      if(mode==='empty-more')b.data.buckets[0].summaries=[];
      if(mode==='empty-more')b.data.pagination={hasMore:true,nextCursor:'other'};
      if(mode==='bad-source')b.data.buckets[0].summaries[0].sourceSelection.kind='UNRESOLVED';
      if(mode==='bad-quantity')b.data.buckets[0].summaries[0].quantity=1;
      if(mode==='facts')b.data.buckets[0].facts=[{quantity:'999'}];
      if(mode==='missing-total')delete b.data.totals;
      if(mode==='missing-cursor')a.data.pagination.nextCursor=null;
      let n=0;await expect(collectWorkerBillingUsage(async()=>[a,b][n++])).rejects.toThrow('complete usage read unavailable');
    });
  test('cancellation and read failure return no apparently complete partial usage',async()=>{
    const caller=new AbortController();let calls=0;
    await expect(collectWorkerBillingUsage(async()=>{calls++;if(calls===2)caller.abort(new Error('owner cancelled'));
      return page([calls],calls===1,calls===1 ? 'next' : null);},{},caller.signal)).rejects.toThrow('owner cancelled');
    expect(calls).toBe(2);
    calls=0;await expect(collectWorkerBillingUsage(async()=>{calls++;if(calls===2)throw new Error('read unavailable');
      return page([0],true,'next');})).rejects.toThrow('read unavailable');expect(calls).toBe(2);
  });
  test('keeps exact quantities, observed zero and unknown separate, and normalizes UTC cutoffs',async()=>{
    const value=example(),first=value.data.buckets[0].summaries[0];
    const exact='90071992547409931234567890.00000000000000000012345678901234567890123456789';
    value.data.totals=[{metric:'WORKER_CPU_MS',quantity:exact,coverage:first.coverage},
      {metric:'WORKER_REQUEST',quantity:null,coverage:first.coverage}];
    value.data.buckets[0].summaries=[{...first,quantity:'0',eventCount:'1'},
      {...first,resourceKey:'unresolved',quantity:null,eventCount:null,sourceSelection:{kind:'UNRESOLVED',provider:null,dataset:null}}];
    value.completeThrough='2026-10-10T16:40:00+08:00';
    const human=formatWorkerBillingResponse('usage',await collectWorkerBillingUsage(async()=>value));
    expect(human).toContain(exact);expect(human).toContain('Quantity                0');
    expect(human).toContain('Quantity                —');expect(human).toContain('2026-10-10T08:40:00.000Z');
    expect(human).not.toContain('e+');expect(human).not.toContain('$0');
  });
  test('legacy reads remain readable, without invented totals or complete coverage',async()=>{
    const value=example();delete value.data.totals;delete value.data.pagination;
    value.data.buckets.forEach((bucket:any)=>{delete bucket.summaries;bucket.facts=[{metric:'WORKER_REQUEST',quantity:'3'}];});
    value.dataQuality='COMPLETE';
    expect(await collectWorkerBillingUsage(async()=>value)).toBe(value);
    const human=formatWorkerBillingResponse('usage',value);
    expect(human).toContain('Legacy usage observations');expect(human).toContain('Data quality            INDETERMINATE');
    expect(human).toContain('Quantity                3');expect(human).toContain('aggregate totals and coverage are unavailable');
  });
});
