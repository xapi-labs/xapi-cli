import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerManagedResourceSchema, loadWorkerProject } from '../workers-project.ts';
import { initWorkerProject } from '../workers-init.ts';
import { createWorkerPlan } from '../workers-plan.ts';
import { pullProjectResources } from '../workers-project-resources.ts';
import { importWranglerProject } from '../workers-wrangler-import.ts';
import { ensureManagedResources, resourceMatches } from '../workers-push.ts';

const roots: string[] = [];
const workerId = '12345678-1234-4234-8234-123456789abc';
const declaration = { type: 'workflow' as const, bindingName: 'FLOW', className: 'NativeFlow', workflowName: 'daily-flow' };
const remote = (prepared = true) => ({ id: 'flow', type: 'WORKFLOW', bindingName: 'FLOW', status: 'PROVISIONING', config: { nativeWorkflow: { version: 1, ...declaration, prepared } } });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'xapi-native-workflow-'))); roots.push(parent);
  const root = initWorkerProject({ cwd: parent, target: 'demo' }).rootDir;
  const path = join(root, 'xapi.worker.json'); const config = JSON.parse(readFileSync(path, 'utf8'));
  config.workerId = workerId; config.environments.preview.resources = [declaration]; config.environments.preview.secrets = [];
  writeFileSync(path, JSON.stringify(config)); return root;
}
const options = { apiHost: 'localhost:3148', apiKey: 'unit-fixture' };
function client(resources: unknown[]) {
  return { getWorkerVariableState: async()=>({environment:'preview',exists:false,activeDeploymentId:null,variables:[]}), listWorkers: async () => [], listWorkerResources: async () => resources, listWorkerSecrets: async () => [],
    getWorker: async () => ({ id: workerId, slug: 'demo-worker', environments: [{ id: 'env', name: 'PREVIEW', dailyBudgetUsd: null }], artifacts: [], deployments: [] }) };
}

test('allows native and legacy Workflow declarations but rejects names without a native class and foreign IDs', () => {
  expect(workerManagedResourceSchema.parse(declaration)).toEqual(declaration);
  expect(workerManagedResourceSchema.parse({ type: 'workflow', bindingName: 'LEGACY' })).toEqual({ type: 'workflow', bindingName: 'LEGACY' });
  expect(workerManagedResourceSchema.safeParse({ type: 'workflow', bindingName: 'FLOW', workflowName: 'daily' }).success).toBe(false);
  expect(workerManagedResourceSchema.safeParse({ type: 'queue', bindingName: 'Q', className: 'Flow' }).success).toBe(false);
  expect(workerManagedResourceSchema.safeParse({ ...declaration, providerResourceId: 'foreign' }).success).toBe(false);
});

test('plan accepts only prepared native Workflow provisioning and catches identity drift', async () => {
  const root = project(); const resource = remote();
  const run = () => createWorkerPlan({ cwd: root, environment: 'preview', clientOptions: options, client: client([resource]) });
  expect((await run()).actions.find(a => a.key === 'FLOW')?.operation).toBe('NO_CHANGE');
  resource.config.nativeWorkflow.prepared = false;
  expect((await run()).actions.find(a => a.key === 'FLOW')?.operation).toBe('BLOCKED');
  resource.config.nativeWorkflow.prepared = true; resource.config.nativeWorkflow.className = 'OtherFlow';
  expect((await run()).actions.find(a => a.key === 'FLOW')?.operation).toBe('BLOCKED');
  resource.config.nativeWorkflow.className = declaration.className; resource.config.nativeWorkflow.workflowName = 'other-flow';
  expect((await run()).actions.find(a => a.key === 'FLOW')?.operation).toBe('BLOCKED');
});

test('pull preserves native Workflow metadata and ignores deployment-owned Container applications', async () => {
  const root = project(); const path = join(root, 'xapi.worker.json'); const config = JSON.parse(readFileSync(path, 'utf8'));
  config.environments.preview.resources = []; writeFileSync(path, JSON.stringify(config));
  await pullProjectResources({ cwd: root, environments: ['preview'], clientOptions: options, client: client([
    remote(), { id: 'container', type: 'CONTAINER_APPLICATION', bindingName: 'CONTAINER_generated', status: 'ACTIVE' },
  ]) });
  expect(loadWorkerProject(root).config.environments.preview.resources).toEqual([declaration]);
  const previous = readFileSync(path, 'utf8');
  const pending = await pullProjectResources({ cwd: root, environments: ['preview'], clientOptions: options, client: client([remote(false)]) });
  expect(pending.environments[0].pending).toEqual([{bindingName:'FLOW',status:'PROVISIONING',declared:true}]);
  expect(readFileSync(path, 'utf8')).toBe(previous);
});

test('resource creation transmits native Workflow requirements without a physical provider identifier', async () => {
  let input: unknown; let created=false;
  const result = await ensureManagedResources({ listWorkerResources: async () => created ? [remote()] : [], createWorkerResource: async (_o, _id, _env, value) => { input = value; created=true; return remote(); } }, options, workerId, 'preview', [declaration]);
  expect(input).toEqual(declaration); expect(result.created).toEqual(['FLOW']);
  expect(resourceMatches(remote(), declaration)).toBe(true);
  expect(resourceMatches(remote(), { ...declaration, className: 'Other' })).toBe(false);
  expect(resourceMatches(remote(), { type: 'workflow', bindingName: 'FLOW' })).toBe(false);
});

test('Wrangler import retains Workflow class but provisions a new platform-owned identity', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'xapi-import-native-workflow-'))); roots.push(root);
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'workflow-demo', main: 'src/index.ts', workflows: [{ binding: 'FLOW', class_name: 'NativeFlow', name: 'owned-local-workflow' }] }));
  expect(importWranglerProject({ cwd: root, wranglerPath: 'wrangler.jsonc' }).wrote).toBe(true);
  expect(loadWorkerProject(root).config.environments.preview.resources).toEqual([{ type: 'workflow', bindingName: 'FLOW', className: 'NativeFlow' }]);
  expect(readFileSync(join(root, 'xapi.worker.json'), 'utf8')).not.toContain('owned-local-workflow');
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'workflow-demo', main: 'src/index.ts', workflows: [{ binding: 'FLOW', class_name: 'NativeFlow', script_name: 'foreign-script' }] }));
  const external = importWranglerProject({ cwd: root, wranglerPath: 'wrangler.jsonc', force: true });
  expect(external.wrote).toBe(false);
  expect(external.report.entries).toContainEqual(expect.objectContaining({category:'UNSUPPORTED',path:'workflows[0].script_name',message:expect.stringContaining('external Workflow script')}));
});
