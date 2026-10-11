import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, getGlobalDispatcher } from 'undici/index.js';
import { request, uploadRequest, actionDownload, actionStream, HttpError, RequestTimeoutError,
  createArtifactControlSession } from '../client.ts';
import { deleteWorker, workerRetention, WorkerWriteUnknownError } from '../workers-client.ts';

// Bundled and run in real Node processes. Only loopback fixtures, no cloud access.
const counts = new Map<string, number>();
const failures: unknown[] = [];
const binary = Buffer.from([0, 255, 128, 13, 10, 42]);
const idle = 200;
process.env.XAPI_TRANSFER_IDLE_TIMEOUT_MS = String(idle);
const server = createServer(async (req, res) => {
  const path = req.url!;
  counts.set(path, (counts.get(path) || 0) + 1);
  try {
    assert.equal(req.headers['xapi-key'], 'local-fixture');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (path.includes('/disconnect')) { req.socket.destroy(); return; }
    if (path.includes('/partial-success') || path.includes('/partial-error')) {
      res.writeHead(path.includes('/partial-error') ? 409 : 200, { 'content-type': 'application/json', 'content-length': '1000' });
      res.write('{"unfinished":');
      setTimeout(() => res.destroy(), 30);
      return;
    }
    if (path.includes('/reject')) { res.writeHead(503); res.end('upstream rejected'); return; }
    if (path === '/redirect') { res.writeHead(307, { location: '/leaked' }); res.end(); return; }
    if (path === '/stalled' || path === '/cancel') return;
    if (path === '/multipart') {
      assert.match(req.headers['content-type']!, /^multipart\/form-data; boundary=/);
      assert.ok(body.includes(binary));
      assert.ok(body.includes(Buffer.from('name="manifest"')));
    }
    if (path === '/json') assert.deepEqual(JSON.parse(body.toString()), { payload: 'hello' });
    if (path === '/moving-upload') assert.equal(body.length, 8 * 65_536);
    if (path === '/headers') await delay(40);
    if (path === '/body') { res.write('{"ok":'); await delay(40); res.end('true}'); return; }
    if (path === '/v1/actions/execute') {
      const input = JSON.parse(body.toString());
      if (input.action_id === 'redirect') { res.writeHead(307, { location: '/leaked' }); res.end(); return; }
      res.writeHead(200, { 'content-type': input.stream ? 'text/event-stream' : 'application/octet-stream' });
      const chunk = input.stream ? Buffer.from('data: {"ok":true}\n\n') : binary;
      res.write(chunk);
      if (input.action_id === 'stall') return;
      if (input.action_id === 'broken') { setTimeout(() => res.destroy(), 30); return; }
      for (let i = 1; i < 8; i++) { await delay(50); res.write(chunk); }
      res.end(); return;
    }
    res.end('{"ok":true}');
  } catch (error) { failures.push(error); res.destroy(); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const options = { apiHost: base.slice(7), apiKey: 'local-fixture' };
const headers = { 'XAPI-Key': options.apiKey };
const root = await mkdtemp(join(process.cwd(), '.http-recovery-files-'));
const originalGlobal = getGlobalDispatcher();
const originalDispatch = Agent.prototype.dispatch;
let dispatches = 0;
Agent.prototype.dispatch = function (input, handler) {
  dispatches++;
  assert.equal(input.headersTimeout, 0);
  assert.equal(input.bodyTimeout, 0);
  return originalDispatch.call(this, input, handler);
};
try {
  for (const path of ['/headers', '/body'])
    assert.deepEqual(await request(base + path, { headers }, 1000), { ok: true });
  const session = createArtifactControlSession();
  try { assert.deepEqual(await session.request(base + '/control', { headers }, 1000, 0), { ok: true }); }
  finally { await session.close(); }

  let injected = 0;
  assert.deepEqual(await request(base + '/injected', {}, 1000, 0, 'total', (async (_url, init) => {
    injected++; assert.equal(init?.redirect, 'manual');
    return new Response('{"injected":true}');
  }) as typeof fetch), { injected: true });
  assert.equal(injected, 1); assert.equal(counts.has('/injected'), false);
  await assert.rejects(request('https://untrusted.invalid/', {}, 100), /untrusted host/);
  await assert.rejects(request(base + '/redirect', { headers }, 1000), /refusing to follow redirect/);

  assert.deepEqual(await uploadRequest(base + '/json', { method: 'POST', headers, body: JSON.stringify({ payload: 'hello' }) }), { ok: true });
  const form = new FormData();
  form.set('manifest', JSON.stringify({ name: 'fixture' }));
  form.set('file', new Blob([binary]), 'binary.bin');
  assert.deepEqual(await uploadRequest(base + '/multipart', { method: 'POST', headers, body: form }), { ok: true });
  const started = Date.now();
  const body = Readable.from((async function* () {
    for (let i = 0; i < 8; i++) { yield Buffer.alloc(65_536); await delay(50); }
  })());
  assert.deepEqual(await uploadRequest(base + '/moving-upload', { method: 'POST', headers, body, duplex: 'half' } as unknown as RequestInit), { ok: true });
  assert.ok(Date.now() - started > idle);
  await assert.rejects(uploadRequest(base + '/stalled', { method: 'POST', headers, body: 'once' }), RequestTimeoutError);
  await assert.rejects(uploadRequest(base + '/disconnect-upload', { method: 'POST', headers, body: 'once' }), /fetch failed/);
  const abort = new AbortController();
  const pending = request(base + '/cancel', { method: 'POST', headers, signal: abort.signal }, 2000, 2);
  setTimeout(() => abort.abort(), 50);
  await assert.rejects(pending, /aborted/i);
  assert.equal(counts.get('/cancel'), 1);

  const output = join(root, 'binary');
  const download = await actionDownload('moving', {}, { actionHost: options.apiHost, apiKey: options.apiKey }, output);
  assert.equal(download.bytes, binary.length * 8);
  assert.deepEqual(await readFile(output), Buffer.concat(Array(8).fill(binary)));
  for (const action of ['stall', 'broken', 'redirect']) {
    const target = join(root, action);
    await assert.rejects(actionDownload(action, {}, { actionHost: options.apiHost, apiKey: options.apiKey }, target));
    await assert.rejects(access(target));
  }
  // Forward actual SSE frames while keeping the fixture's stdout machine-readable.
  const write = process.stdout.write;
  const frames: Buffer[] = [];
  process.stdout.write = ((chunk: Uint8Array) => { frames.push(Buffer.from(chunk)); return true; }) as typeof write;
  try { await actionStream('moving', {}, { actionHost: options.apiHost, apiKey: options.apiKey }); }
  finally { process.stdout.write = write; }
  assert.equal(Buffer.concat(frames).toString(), 'data: {"ok":true}\n\n'.repeat(8));

  for (const id of ['disconnect', 'partial-success', 'reject', 'partial-error']) {
    for (const kind of ['retention', 'delete']) {
      const path = `/api/v1/workers/${id}` + (kind === 'retention' ? '/environments/preview/retention/actions' : '');
      const call = () => kind === 'retention'
        ? workerRetention(options, id, 'preview', '/actions', { action: 'pause' })
        : deleteWorker(options, id);
      await assert.rejects(call(), (error: unknown) => {
        if (id === 'reject' || id === 'partial-error') {
          assert.ok(error instanceof HttpError);
          assert.equal(error.status, id === 'reject' ? 503 : 409);
          assert.ok(!error.message.includes('UNKNOWN'));
        } else {
          assert.ok(error instanceof WorkerWriteUnknownError);
          assert.equal(error.code, 'UND_ERR_SOCKET');
          assert.ok(error.cause instanceof TypeError);
          assert.equal((error.cause.cause as { code: string }).code, 'UND_ERR_SOCKET');
          assert.match(error.message, /result is UNKNOWN/);
          assert.ok(error.message.includes(kind === 'retention'
            ? `xapi workers retention show ${id} --env preview --format json`
            : `xapi workers get ${id} --format json`));
        }
        return true;
      });
      assert.equal(counts.get(path), 1, `write replayed: ${path}`);
    }
  }
  assert.equal(counts.get('/stalled'), 1);
  assert.equal(counts.get('/disconnect-upload'), 1);
  assert.equal(counts.has('/leaked'), false);
  assert.equal(getGlobalDispatcher(), originalGlobal);
  assert.ok(dispatches > 20);
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ node: process.version, result: 'passed', dispatches,
    coverage: 'requests, injected fetch, control session, JSON/multipart/moving uploads, idle timeout, cancellation, downloads, SSE, allowlist/redirects, lifecycle disconnect/partial response exactly once, definite HTTP failures' }));
} finally {
  Agent.prototype.dispatch = originalDispatch;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
