import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { deployWorker, putWorkerSecret } from '../workers-client.ts';

// Real local HTTP and the real client. CF results are fixtures, not live CF evidence.
test('deployment waits through an unsent conflict and keeps exactly the same request', async () => {
  const writes: string[] = [], requests: string[] = [], events: string[] = [];
  let acceptedWrites = 0;
  const server = createServer(async (req, res) => {
    requests.push(req.method + ' ' + req.url);
    expect(req.headers['xapi-key']).toBe('local-fixture-only');
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify({ operationId: 'previous', state: 'FINALIZED',
        occupiesTarget: false, resultUnconfirmed: false, retryReady: true }));
      return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    writes.push(body);
    if (writes.length === 1) {
      res.statusCode = 409;
      res.end(JSON.stringify({ code: 'worker_control_operation_pending', operationId: 'previous',
        state: 'WRITING', pendingReason: 'TARGET_BUSY', requestAccepted: false, requestDispatched: false }));
    } else {
      acceptedWrites++;
      res.end(JSON.stringify({ id: 'v3', status: 'ACTIVE' }));
    }
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address() as { port: number };
    const result = await deployWorker({
      apiHost: '127.0.0.1:' + address.port, apiKey: 'local-fixture-only',
      operationWait: { onWait: e => events.push(e.phase) },
    }, 'worker/id', { artifactId: 'immutable-artifact', environment: 'preview', idempotencyKey: 'same-key' });
    expect(result).toEqual({ id: 'v3', status: 'ACTIVE' });
    expect(writes).toHaveLength(2); expect(writes[0]).toBe(writes[1]);
    expect(acceptedWrites).toBe(1);
    expect(requests).toEqual([
      'POST /api/v1/workers/worker%2Fid/deployments',
      'GET /api/v1/workers/worker%2Fid/control-operations/previous',
      'POST /api/v1/workers/worker%2Fid/deployments',
    ]);
    expect(events).toEqual(['waiting', 'ready']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);

test('Secret waits using the same metadata-only query and does not leak its value into progress', async () => {
  let writes = 0;
  const bodies: string[] = [], events: string[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') {
      res.end(JSON.stringify({ operationId: 'secret-prior', state: 'FINALIZED',
        occupiesTarget: false, resultUnconfirmed: false, retryReady: true }));
      return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    bodies.push(body);
    if (++writes === 1) {
      res.statusCode = 409;
      res.end(JSON.stringify({ code: 'worker_control_operation_pending', operationId: 'secret-prior',
        state: 'WRITING', pendingReason: 'TARGET_BUSY', requestAccepted: false, requestDispatched: false }));
    } else res.end(JSON.stringify({ providerStatus: 'ACTIVE' }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const address = server.address() as { port: number };
    expect(await putWorkerSecret({ apiHost: '127.0.0.1:' + address.port, apiKey: 'fixture',
      operationWait: { onWait: e => events.push(JSON.stringify(e)) } },
      'worker', 'preview', 'TOKEN', 'private-fixture-value')).toEqual({ providerStatus: 'ACTIVE' });
    expect(bodies).toHaveLength(2); expect(bodies[0]).toBe(bodies[1]);
    expect(events.join('')).not.toContain('private-fixture-value');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);
