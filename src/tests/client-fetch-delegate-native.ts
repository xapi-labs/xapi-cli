import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { request, uploadRequest, actionDownload, actionStream, RequestTimeoutError } from '../client.ts';

// The preload delegates unchanged to Node's actual native fetch, including on
// Node 26. No synthetic responses and no undici dispatcher shim in the preload.
const calls = (globalThis as any).__preloadFetchCalls as Array<{ url: string; method?: string }>;
assert.ok(calls, 'run with the delegate preload');
const nativeFetch = (globalThis as any).__preloadOriginalFetch as typeof fetch;
const budget = 400;
process.env.XAPI_TRANSFER_IDLE_TIMEOUT_MS = String(budget);
const counts = new Map<string, number>();
const binary = Buffer.from([0, 255, 128, 13, 10, 42]);
const server = createServer(async (req, res) => {
  const path = req.url!;
  counts.set(path, (counts.get(path) || 0) + 1);
  req.on('error', () => {});
  if (path === '/stalled' || path === '/cancel' || path === '/bounded-upload') { req.resume(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks);
  if (path === '/redirect') { res.writeHead(307, { location: '/leaked' }); res.end(); return; }
  if (path === '/disconnect') { req.socket.destroy(); return; }
  if (path === '/v1/actions/execute') {
    const input = JSON.parse(body.toString());
    res.writeHead(200, { 'content-type': input.stream ? 'text/event-stream' : 'application/octet-stream' });
    const chunk = input.stream ? Buffer.from('data: native\n\n') : binary;
    res.write(chunk);
    if (input.action_id === 'stalled') return;
    for (let i = 1; i < 6; i++) { await delay(budget / 3); if (res.destroyed) return; res.write(chunk); }
    res.end(); return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ source: 'network', bytes: body.length, contentType: req.headers['content-type'] || null,
    binaryReceived: body.includes(binary) }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
const base = `http://${host}`;
const root = await mkdtemp(join(process.cwd(), '.delegate-fetch-files-'));
const options = { actionHost: host };
try {
  assert.equal((await request<{source:string}>(base + '/read', {}, 2000)).source, 'network');
  const json = JSON.stringify({ value: 'native upload' });
  assert.equal((await uploadRequest<{bytes:number}>(base + '/json', { method: 'POST', body: json })).bytes, Buffer.byteLength(json));
  const form = new FormData(); form.set('binary', new Blob([binary]), 'file.bin');
  const multipart = await uploadRequest<{binaryReceived:boolean;contentType:string}>(base + '/multipart', { method: 'POST', body: form });
  assert.equal(multipart.binaryReceived, true); assert.match(multipart.contentType, /^multipart\/form-data/);

  // Explicit native injection is honored, not replaced with the library fetch.
  const intercepted = calls.length;
  assert.equal((await request<{source:string}>(base + '/explicit-native', {}, 2000, 0, 'total', nativeFetch)).source, 'network');
  assert.equal(calls.length, intercepted);
  let injected = 0;
  const explicit = (async (url, init) => {
    injected++; assert.ok(init?.signal); assert.equal('dispatcher' in init!, false);
    return nativeFetch(url, init);
  }) as typeof fetch;
  await request(base + '/explicit-wrapper', {}, 2000, 0, 'total', explicit);
  assert.equal(injected, 1); assert.equal(calls.length, intercepted);

  // Total deadline and caller cancellation still abort the native request.
  await assert.rejects(request(base + '/stalled', { method: 'POST', body: 'once' }, budget), RequestTimeoutError);
  const abort = new AbortController();
  const cancelled = request(base + '/cancel', { method: 'POST', signal: abort.signal }, 2000, 2);
  setTimeout(() => abort.abort(), budget / 2);
  await assert.rejects(cancelled, /aborted/i);
  await assert.rejects(uploadRequest(base + '/disconnect', { method: 'POST', body: 'once' }), /fetch failed/);

  // Foreign fetch has no socket progress hooks: its upload budget is a total
  // bound, even if a request body is still producing bytes. It never replays.
  const body = Readable.from((async function* () {
    for (let i = 0; i < 8; i++) { yield binary; await delay(budget / 3); }
  })());
  await assert.rejects(uploadRequest(base + '/bounded-upload', { method: 'POST', body, duplex: 'half' } as unknown as RequestInit), RequestTimeoutError);

  const output = join(root, 'download');
  const downloadStart = Date.now();
  await actionDownload('moving', {}, options, output);
  assert.ok(Date.now() - downloadStart > budget);
  assert.deepEqual(await readFile(output), Buffer.concat(Array(6).fill(binary)));
  const stalled = join(root, 'stalled');
  await assert.rejects(actionDownload('stalled', {}, options, stalled), RequestTimeoutError);
  await assert.rejects(access(stalled));
  const write = process.stdout.write;
  const frames: Buffer[] = [];
  process.stdout.write = ((chunk: Uint8Array) => { frames.push(Buffer.from(chunk)); return true; }) as typeof write;
  try {
    const streamStart = Date.now();
    await actionStream('moving', {}, options);
    assert.ok(Date.now() - streamStart > budget);
    assert.equal(Buffer.concat(frames).toString(), 'data: native\n\n'.repeat(6));
    await assert.rejects(actionStream('stalled', {}, options), RequestTimeoutError);
  } finally { process.stdout.write = write; }

  await assert.rejects(request(base + '/redirect', {}, 2000), /refusing to follow redirect/);
  await assert.rejects(request('https://untrusted.invalid/', {}, 100), /untrusted host/);
  assert.equal(counts.has('/leaked'), false);
  for (const [path, count] of counts) assert.equal(count, path === '/v1/actions/execute' ? 4 : 1, `unexpected replay: ${path}`);
  assert.equal(calls.length, 12);
  console.log(JSON.stringify({ node: process.version, result: 'passed', intercepted: calls.length,
    coverage: 'transparent native delegate request/JSON/multipart upload/SSE/download, explicit native/wrapper injection, total timeout, cancellation, bounded foreign upload, response idle, cleanup, no replay, redirect/allowlist' }));
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
