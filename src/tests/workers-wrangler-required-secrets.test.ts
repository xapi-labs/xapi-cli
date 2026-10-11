import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readWranglerDeploymentSettings} from '../workers-wrangler-import.ts';
import {deploymentPrefix} from '../workers-deployment-state.ts';
test('deployment declaration records names from selected Wrangler and project environments without values',()=>{
 const root=mkdtempSync(join(tmpdir(),'required-secrets-'));
 try {writeFileSync(join(root,'wrangler.jsonc'),JSON.stringify({secrets:{required:['TOP_TOKEN']},env:{production:{secrets:{required:['PROD_TOKEN','PROJECT_TOKEN']}}}}));
 const project={rootDir:root,config:{wrangler:'wrangler.jsonc',environments:{preview:{secrets:['PROJECT_TOKEN'],resources:[]},production:{secrets:['PROJECT_TOKEN'],resources:[]}}}} as any;
 const preview=readWranglerDeploymentSettings(project,'preview'),prod=readWranglerDeploymentSettings(project,'production');
 expect(preview.requiredSecrets).toEqual(['PROJECT_TOKEN','TOP_TOKEN']);
 expect(prod.requiredSecrets).toEqual(['PROD_TOKEN','PROJECT_TOKEN']);
 const state={bindings:[]};
 expect(deploymentPrefix('w','preview','a',preview,state,[],[])).not.toBe(deploymentPrefix('w','preview','a',{...preview,requiredSecrets:['PROJECT_TOKEN']},state,[],[]));
 }finally{rmSync(root,{recursive:true,force:true});}
});
