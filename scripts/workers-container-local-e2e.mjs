import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'xapi-container-e2e-'));
const workerId = '22222222-2222-4222-8222-222222222222';
const requests = [];
const state = { worker: null, resources: [], artifacts: [], deployments: [] };

function canonicalArtifact(bundle) {
  const modules = [...bundle.modules]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((module) => ({
      path: module.path,
      contentBase64:
        module.encoding === 'base64'
          ? module.content
          : Buffer.from(module.content, 'utf8').toString('base64'),
      contentType: module.contentType,
    }));
  const stored = {
    ...(bundle.observability ? { observability: bundle.observability } : {}),
    ...(bundle.containers?.length ? { containers: bundle.containers } : {}),
    version: 1,
    mainModule: bundle.mainModule,
    modules,
    ...(bundle.assets ? { assets: bundle.assets } : {}),
  };
  return Buffer.from(JSON.stringify(stored));
}

function snapshot(port) {
  if (!state.worker) return null;
  const active = state.deployments.find((deployment) => deployment.status === 'ACTIVE');
  return {
    ...state.worker,
    environments: [
      {
        id: 'environment-preview',
        name: 'PREVIEW',
        enabled: true,
        dailyBudgetUsd: 0.25,
        activeDeploymentId: active?.id || null,
        publicUrl: `http://localhost:${port}/runtime`,
      },
      {
        id: 'environment-production',
        name: 'PRODUCTION',
        enabled: true,
        dailyBudgetUsd: 2,
        activeDeploymentId: null,
        publicUrl: `http://localhost:${port}/production`,
      },
    ],
    artifacts: state.artifacts,
    deployments: state.deployments,
  };
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  requests.push({ method: request.method, path: url.pathname });
  if (url.pathname === '/runtime/health') return json(response, 200, { ok: true });
  if (request.headers['xapi-key'] !== 'local-container-key') {
    return json(response, 401, { error: { code: 'unauthorized' } });
  }
  const base = '/api/v1/workers';
  if (url.pathname === base && request.method === 'GET') {
    return json(response, 200, state.worker ? [snapshot(server.address().port)] : []);
  }
  if (url.pathname === base && request.method === 'POST') {
    const input = await body(request);
    state.worker = { id: workerId, name: input.name, slug: input.slug, status: 'ACTIVE' };
    return json(response, 201, snapshot(server.address().port));
  }
  const workerPath = `${base}/${workerId}`;
  if (url.pathname === workerPath && request.method === 'GET') {
    return json(response, 200, snapshot(server.address().port));
  }
  const resourcePath = `${workerPath}/environments/preview/resources`;
  if (url.pathname === resourcePath && request.method === 'GET') {
    return json(response, 200, state.resources);
  }
  if (url.pathname === resourcePath && request.method === 'POST') {
    const input = await body(request);
    const resource = {
      id: 'resource-do-1',
      bindingName: input.bindingName,
      type: 'DURABLE_OBJECT',
      status: 'PROVISIONING',
      config: { className: input.className },
    };
    state.resources.push(resource);
    return json(response, 201, resource);
  }
  if (
    url.pathname === `${workerPath}/environments/preview/secrets` &&
    request.method === 'GET'
  ) {
    return json(response, 200, []);
  }
  if (url.pathname === `${workerPath}/artifacts` && request.method === 'GET') {
    return json(response, 200, state.artifacts);
  }
  if (url.pathname === `${workerPath}/artifacts` && request.method === 'POST') {
    const input = await body(request);
    if (!input.bundle?.containers?.length) {
      return json(response, 422, { error: { code: 'container_manifest_missing' } });
    }
    const stored = canonicalArtifact(input.bundle);
    const artifact = {
      id: 'artifact-container-1',
      idempotencyKey: input.idempotencyKey,
      contentSha256: createHash('sha256').update(stored).digest('hex'),
      sizeBytes: stored.length,
    };
    state.artifacts.push(artifact);
    return json(response, 201, artifact);
  }
  if (url.pathname === `${workerPath}/deployments` && request.method === 'POST') {
    const input = await body(request);
    const deployment = {
      id: 'deployment-container-1',
      artifactId: input.artifactId,
      environmentId: 'environment-preview',
      idempotencyKey: input.idempotencyKey,
      status: 'ACTIVE',
    };
    state.deployments.push(deployment);
    return json(response, 201, deployment);
  }
  return json(response, 404, { error: { code: 'not_found', path: url.pathname } });
});

function run(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', rejectPromise);
    child.on('close', (code) =>
      code === 0
        ? resolvePromise({ stdout, stderr })
        : rejectPromise(new Error(`CLI exited ${code}: ${stderr || stdout}`)),
    );
  });
}

try {
  await new Promise((resolvePromise) => server.listen(0, 'localhost', resolvePromise));
  const port = server.address().port;
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'wrangler.jsonc'),
    JSON.stringify({
      name: 'container-local-e2e',
      main: 'src/index.mjs',
      compatibility_date: '2026-09-21',
      durable_objects: { bindings: [{ name: 'API_CONTAINER', class_name: 'ApiContainer' }] },
    }),
  );
  writeFileSync(
    join(root, 'build.mjs'),
    `import {mkdirSync,writeFileSync} from 'node:fs';mkdirSync('dist',{recursive:true});writeFileSync('dist/worker.mjs','export class ApiContainer {}\\nexport default {fetch(){return new Response("ok")}}');`,
  );
  writeFileSync(
    join(root, 'xapi.worker.json'),
    JSON.stringify({
      version: 1,
      worker: { name: 'Container Local E2E', slug: 'container-local-e2e', template: 'worker' },
      wrangler: 'wrangler.jsonc',
      build: { command: 'node build.mjs', output: 'dist/worker.mjs' },
      containers: [
        {
          name: 'api',
          className: 'ApiContainer',
          image: 'docker.io/library/nginx:1.27-alpine',
          instanceType: 'lite',
          maxInstances: 2,
          constraints: { regions: ['APAC'] },
          rolloutActiveGracePeriod: 30,
        },
      ],
      environments: {
        preview: {
          dailyBudgetUsd: 0.25,
          healthCheck: '/health',
          resources: [{ type: 'durable_object', bindingName: 'API_CONTAINER', className: 'ApiContainer' }],
          secrets: [],
        },
        production: {
          dailyBudgetUsd: 2,
          healthCheck: '/health',
          resources: [{ type: 'durable_object', bindingName: 'API_CONTAINER', className: 'ApiContainer' }],
          secrets: [],
        },
      },
    }, null, 2),
  );
  const result = await run(
    process.execPath,
    [join(repository, 'dist/index.js'), 'workers', 'push', '--env', 'preview', '--non-interactive', '--format', 'json'],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        XAPI_ACTION_HOST: `localhost:${port}`,
        XAPI_API_HOST: `localhost:${port}`,
        XAPI_KEY: 'local-container-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output = JSON.parse(result.stdout.trim());
  const linked = JSON.parse(readFileSync(join(root, 'xapi.worker.json'), 'utf8'));
  if (
    output.status !== 'ACTIVE' ||
    output.health?.status !== 200 ||
    linked.workerId !== workerId ||
    state.resources[0]?.config?.className !== 'ApiContainer' ||
    !state.artifacts.length ||
    !state.deployments.length
  ) {
    throw new Error('Local Container acceptance assertions failed');
  }
  console.log(
    JSON.stringify({
      ok: true,
      workerId,
      artifactSha256: state.artifacts[0].contentSha256,
      deploymentId: state.deployments[0].id,
      health: output.health,
      requestCount: requests.length,
      requests,
    }),
  );
} finally {
  await new Promise((resolvePromise) => server.close(resolvePromise));
  rmSync(root, { recursive: true, force: true });
}
