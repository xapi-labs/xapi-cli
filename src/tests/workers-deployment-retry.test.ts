import {expect,test} from 'bun:test';
import {ensureActiveDeployment} from '../workers-push.ts';
import {deploymentKey,deploymentPrefix} from '../workers-deployment-state.ts';
const options={apiHost:'localhost:3020',apiKey:'unit-only'};
const env={id:'env',name:'PRODUCTION',activeDeploymentId:null,bindings:[]};
const config={compatibilityDate:'2026-10-08',compatibilityFlags:[],nativeMetadata:{placement:{mode:'off'}}};
function fixture(providerEffect:string){
 const prefix=deploymentPrefix('worker','production','artifact',config,env,[],[]);
 const failed={id:'failed',artifactId:'artifact',environmentId:'env',status:'FAILED',idempotencyKey:deploymentKey(prefix,env),providerResult:{controlOperationId:'operation'},outcome:{operationId:'operation',providerEffect,execution:'FAILED',steps:[{state:providerEffect==='REJECTED'?'REJECTED':'SKIPPED',evidence:null}]},createdAt:'2026-10-08T00:00:00Z'};
 const calls:{deploy:any[],recover:any[]}={deploy:[],recover:[]};
 const api:any={getWorker:async()=>({id:'worker',environments:[env],deployments:[failed]}),listWorkerResources:async()=>[],listWorkerSecrets:async()=>[],
  deployWorker:async(_o:any,_id:string,input:any)=>{calls.deploy.push(input);return {id:'new',status:'ACTIVE'};},
  recoverWorkerControlOperation:async(...args:any[])=>{calls.recover.push(args);return {};}};
 return {api,calls,failed};
}
for(const effect of ['NOT_DISPATCHED','REJECTED'])test('an explicit user run creates a new attempt after '+effect+' without replaying the old key',async()=>{
 const f=fixture(effect);const result=await ensureActiveDeployment(f.api,options,'worker','artifact','production',config,async()=>{},undefined,undefined,undefined,true);
 expect(result.deployment.id).toBe('new');expect(f.calls.deploy.length).toBe(1);expect(f.calls.deploy[0].idempotencyKey).not.toBe(f.failed.idempotencyKey);expect(f.calls.recover).toEqual([]);
});
for(const effect of ['UNCONFIRMED','PARTIAL_WRITES_CONFIRMED'])test('ambiguous/partial '+effect+' is observed without a new write',async()=>{
 const f=fixture(effect);await expect(ensureActiveDeployment(f.api,options,'worker','artifact','production',config,async()=>{},undefined,undefined,undefined,true)).rejects.toThrow('deployment failed');
 expect(f.calls.deploy).toEqual([]);expect(f.calls.recover.length).toBe(1);
});
test('a failure returned by this run stops without automatic retry',async()=>{
 const f=fixture('REJECTED');f.api.deployWorker=async(_o:any,_id:string,input:any)=>{f.calls.deploy.push(input);return {id:'new',status:'FAILED'};};
 await expect(ensureActiveDeployment(f.api,options,'worker','artifact','production',config,async()=>{},undefined,undefined,undefined,true)).rejects.toThrow('deployment failed');expect(f.calls.deploy.length).toBe(1);
});

test('a rejected summary with a confirmed or in-flight step cannot create a new attempt',async()=>{
 for(const state of ['CONFIRMED','UNKNOWN','DISPATCHING']){
  const f=fixture('REJECTED');f.failed.outcome.steps=[{state,evidence:null}];
  await expect(ensureActiveDeployment(f.api,options,'worker','artifact','production',config,async()=>{},undefined,undefined,undefined,true)).rejects.toThrow('deployment failed');
  expect(f.calls.deploy).toEqual([]);expect(f.calls.recover).toHaveLength(1);
 }
});

test('REJECTED needs at least one rejected step; a contradictory summary is insufficient',async()=>{
 const f=fixture('REJECTED');f.failed.outcome.steps=[{state:'SKIPPED',evidence:null}];
 await expect(ensureActiveDeployment(f.api,options,'worker','artifact','production',config,async()=>{},undefined,undefined,undefined,true)).rejects.toThrow('deployment failed');
 expect(f.calls.deploy).toEqual([]);
});
