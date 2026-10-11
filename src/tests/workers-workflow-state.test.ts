import { expect, test } from 'bun:test';
import { remoteWorkerResourceState, desiredResourceFromRemote, resourceReadyForDeployment } from '../workers-resource-state.ts';
import { resourceMatches } from '../workers-push.ts';
import { deploymentPrefix } from '../workers-deployment-state.ts';

test('native Workflow pulls and compares its declared class without confusing platform host metadata', () => {
 const row={id:'r',type:'WORKFLOW',bindingName:'PIPELINE',status:'PROVISIONING',config:{nativeWorkflow:{version:1,className:'Pipeline',prepared:true}}};
 const state=remoteWorkerResourceState(row);
 expect(desiredResourceFromRemote(state)).toEqual({type:'workflow',bindingName:'PIPELINE',className:'Pipeline'});
 expect(resourceReadyForDeployment(state)).toBe(true);
 expect(resourceMatches(row,{type:'workflow',bindingName:'PIPELINE',className:'Other'})).toBe(false);
 expect(resourceMatches(row,{type:'workflow',bindingName:'PIPELINE',className:'Pipeline'})).toBe(true);
 expect(resourceReadyForDeployment(remoteWorkerResourceState({...row,config:{nativeWorkflow:{className:'Pipeline',prepared:false}}}))).toBe(false);
 expect(resourceReadyForDeployment(remoteWorkerResourceState({...row,config:{}}))).toBe(false);
 expect(resourceReadyForDeployment(remoteWorkerResourceState({...row,status:'ERROR'}))).toBe(false);
 const identity=(resource:any)=>deploymentPrefix('worker','preview','artifact',{}, {},[resource],[]);
 expect(identity(row)).toBe(identity({...row,status:'ACTIVE'}));
 expect(identity(row)).not.toBe(identity({...row,config:{nativeWorkflow:{className:'Other',prepared:true}}}));
});
