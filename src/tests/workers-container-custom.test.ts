import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importWranglerProject } from '../workers-wrangler-import.ts';
import { loadWorkerProject, workerContainerSchema, workerEnvironmentContainers } from '../workers-project.ts';
import { deploymentPrefix } from '../workers-deployment-state.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('Wrangler custom instance survives import and participates in deployment identity', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'container-custom-'))); roots.push(root);
  const instance_type = { vcpu: 1, memory_mib: 3072, disk_mb: 5500 };
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'custom-container', main: 'index.mjs',
    durable_objects: { bindings: [{ name: 'APP', class_name: 'App' }] },
    containers: [{ name: 'app', class_name: 'App', image: 'docker.io/library/nginx:alpine', instance_type, max_instances: 1 }] }));
  expect(importWranglerProject({ cwd: root, wranglerPath: 'wrangler.jsonc' }).wrote).toBe(true);
  const config = loadWorkerProject(root).config;
  const containers = workerEnvironmentContainers(config, 'preview')!;
  expect(containers[0].instanceType).toEqual(instance_type);
  const prefix = deploymentPrefix('worker', 'preview', 'artifact', { containers }, {}, [], []);
  expect(deploymentPrefix('worker', 'preview', 'artifact', { containers:
    [{ ...containers[0], instanceType: { ...instance_type, disk_mb: 5600 } }] }, {}, [], [])).not.toBe(prefix);
});
test('custom size rejects unpriceable fields, without imposing an xAPI resource ceiling', () => {
  const input = { name: 'app', className: 'App', image: 'docker.io/library/nginx:alpine' };
  expect(workerContainerSchema.safeParse({ ...input, instanceType: { vcpu: 8, memory_mib: 24576, disk_mb: 50000 } }).success).toBe(true);
  expect(workerContainerSchema.safeParse({ ...input, instanceType: { vcpu: 1, memory_mib: 3072 } }).success).toBe(false);
  expect(workerContainerSchema.safeParse({ ...input, instanceType: { vcpu: '1', memory_mib: 3072, disk_mb: 5500 } }).success).toBe(false);
});
test.each(['dev', 'standard'])('Wrangler %s alias survives import and project validation', alias => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'container-alias-'))); roots.push(root);
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({ name: 'alias-container', main: 'index.mjs',
    durable_objects: { bindings: [{ name: 'APP', class_name: 'App' }] },
    containers: [{ name: 'app', class_name: 'App', image: 'docker.io/library/nginx:alpine', instance_type: alias, max_instances: 1 }] }));
  expect(importWranglerProject({ cwd: root, wranglerPath: 'wrangler.jsonc' }).wrote).toBe(true);
  expect(workerEnvironmentContainers(loadWorkerProject(root).config, 'preview')![0].instanceType).toBe(alias);
});
