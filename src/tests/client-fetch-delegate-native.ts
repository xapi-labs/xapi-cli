import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { request, uploadRequest, actionDownload, actionStream, RequestTimeoutError, HttpError } from '../client.ts';

// The preload delegates unchanged to Node's actual native fetch, including on
// Node 26. No synthetic responses and no undici dispatcher shim in the preload.
const calls = (globalThis as any).__preloadFetchCalls as Array<{ url: string; method?: string }>;
const preloaded = !!calls;
assert.ok(preloaded || process.versions.bun, 'run Node with the delegate preload');
const nativeFetch = ((globalThis as any).__preloadOriginalFetch || globalThis.fetch) as typeof fetch;
const budget = 400;
process.env.XAPI_TRANSFER_IDLE_TIMEOUT_MS = String(budget);
const binary = Buffer.from([0, 255, 128, 13, 10, 42]);
const server = spawn(process.versions.bun ? 'node' : process.execPath,
  [fileURLToPath(new URL('./client-fetch-delegate-server.mjs', import.meta.url))],
  { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
const [{ port }] = await once(server, 'message');
const host = `127.0.0.1:${port}`;
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
  const intercepted = (calls?.length || 0);
  assert.equal((await request<{source:string}>(base + '/explicit-native', {}, 2000, 0, 'total', nativeFetch)).source, 'network');
  assert.equal((calls?.length || 0), intercepted);
  let injected = 0;
  const explicit = (async (url, init) => {
    injected++; assert.ok(init?.signal); assert.equal('dispatcher' in init!, false);
    return nativeFetch(url, init);
  }) as typeof fetch;
  await request(base + '/explicit-wrapper', {}, 2000, 0, 'total', explicit);
  assert.equal(injected, 1); assert.equal((calls?.length || 0), intercepted);

  // Total deadline and caller cancellation still abort the native request.
  await assert.rejects(request(base + '/stalled', { method: 'POST', body: 'once' }, budget), RequestTimeoutError);
  const abort = new AbortController();
  const cancelled = request(base + '/cancel', { method: 'POST', signal: abort.signal }, 2000, 2);
  setTimeout(() => abort.abort(), budget / 2);
  await assert.rejects(cancelled, /aborted/i);
  await assert.rejects(uploadRequest(base + '/disconnect', { method: 'POST', body: 'once' }), /fetch failed|socket connection was closed/);

  // A producer making progress must be allowed past the idle window.
  const body = Readable.from((async function* () {
    for (let i = 0; i < 8; i++) { yield binary; await delay(budget / 3); }
  })());
  const started = Date.now();
  const moving = await uploadRequest<{bytes:number}>(base + '/moving-upload', { method: 'POST', body, duplex: 'half' } as unknown as RequestInit);
  assert.equal(moving.bytes, 8 * binary.length);
  assert.ok(Date.now() - started > budget);

  // Real FormData and native fetch, with the HTTP receiver providing backpressure.
  // Validate the generated boundary by parsing the received multipart bytes.
  const largeForm = new FormData();
  largeForm.set('manifest', 'preserved');
  largeForm.set('file', new Blob([new Uint8Array(32 * 1024 * 1024)]), 'large.bin');
  const multipartStart = Date.now();
  await uploadRequest(base + '/slow-multipart', { method: 'POST', body: largeForm,
    headers: { 'X-Upload-Fixture': 'preserved' } });
  assert.ok(Date.now() - multipartStart > budget);

  let sourceCancelled = false;
  const stalledBody = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(binary); },
    pull() { return new Promise(() => {}); },
    cancel() { sourceCancelled = true; },
  });
  await assert.rejects(uploadRequest(base + '/stalled-upload', { method: 'POST', body: stalledBody }), RequestTimeoutError);
  assert.equal(sourceCancelled, true);

  // No asynchronous producer work: awaiting each read only queues microtasks.
  // The client must let its real idle timer run even when every chunk is empty.
  let emptyPulls = 0;
  let emptyCancelled = false;
  const emptyBody = new ReadableStream<Uint8Array>({
    pull(controller) { emptyPulls++; controller.enqueue(new Uint8Array()); },
    cancel() { emptyCancelled = true; },
  }, { highWaterMark: 0 });
  const emptyStart = Date.now();
  await assert.rejects(uploadRequest(base + '/empty-upload', { method: 'POST', body: emptyBody }), RequestTimeoutError);
  assert.ok(emptyPulls > 64);
  assert.equal(emptyCancelled, true);
  assert.ok(Date.now() - emptyStart >= budget);
  assert.ok(Date.now() - emptyStart < budget * 5);
  assert.deepEqual(await uploadRequest(base + '/slow-response', { method: 'POST', body: 'once' }), { ok: true });
  await assert.rejects(uploadRequest(base + '/stalled-response', { method: 'POST', body: 'once' }), RequestTimeoutError);

  await assert.rejects(uploadRequest(base + '/stalled-error', { method: 'POST', body: 'once' }),
    (error: unknown) => error instanceof HttpError && error.status === 409 && error.cause instanceof Error);

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
  const stopped = once(server, 'message');
  server.send('close');
  const [{ counts: entries }] = await stopped;
  const counts = new Map<string, number>(entries);
  assert.equal(counts.has('/leaked'), false);
  for (const [path, count] of counts) assert.equal(count, path === '/v1/actions/execute' ? 4 : 1, `unexpected replay: ${path}`);
  if (preloaded) assert.equal(calls.length, 18);
  console.log(JSON.stringify({ node: process.version, result: 'passed', intercepted: (calls?.length || 0),
    emptyUpload: { pulls: emptyPulls, cancelled: emptyCancelled },
    coverage: 'transparent native delegate request/JSON/multipart upload/SSE/download, explicit native/wrapper injection, total timeout, cancellation, progressing multipart upload beyond idle budget, synchronous empty producer idle timeout, stalled upload/response cancellation, response idle, definite HTTP rejection, cleanup, no replay, redirect/allowlist' }));
} finally {
  server.kill();
  await rm(root, { recursive: true, force: true });
}
