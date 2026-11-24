import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { request, uploadRequest, actionDownload, actionStream } from '../client.ts';

// Static imports ensure --import really installs the override before client.ts.
const calls = (globalThis as any).__preloadFetchCalls as Array<{ url: string; method?: string }>;
assert.ok(calls, 'run with the fetch preload');
let networkRequests = 0;
const server = createServer((_req, res) => { networkRequests++; res.end('{"source":"network"}'); });
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
const base = `http://${host}`;
const root = await mkdtemp(join(process.cwd(), '.preload-fetch-files-'));
try {
  assert.deepEqual(await request(base + '/read', {}, 1000), { source: 'preload' });
  assert.deepEqual(await uploadRequest(base + '/upload', { method: 'POST', body: 'bytes' }), { source: 'preload' });
  const file = join(root, 'download');
  await actionDownload('download', {}, { actionHost: host }, file);
  assert.equal(await readFile(file, 'utf8'), '{"source":"preload"}');
  const write = process.stdout.write;
  const frames: Buffer[] = [];
  process.stdout.write = ((chunk: Uint8Array) => { frames.push(Buffer.from(chunk)); return true; }) as typeof write;
  try { await actionStream('stream', {}, { actionHost: host }); }
  finally { process.stdout.write = write; }
  assert.equal(Buffer.concat(frames).toString(), 'data: preload\n\n');
  assert.deepEqual(calls.map(call => [new URL(call.url).pathname, call.method]), [
    ['/read', undefined], ['/upload', 'POST'], ['/v1/actions/execute', 'POST'], ['/v1/actions/execute', 'POST'],
  ]);
  let injected = 0;
  assert.deepEqual(await request(base + '/explicit', {}, 1000, 0, 'total', (async () => {
    injected++; return new Response('{"source":"explicit"}');
  }) as unknown as typeof fetch), { source: 'explicit' });
  assert.equal(injected, 1); assert.equal(calls.length, 4);
  globalThis.fetch = (async () => new Response('{"source":"late"}')) as unknown as typeof fetch;
  assert.deepEqual(await request(base + '/late', {}, 1000), { source: 'late' });
  assert.equal(networkRequests, 0, 'a fetch override was bypassed');
  const unexpectedNetworkRequests = networkRequests;
  globalThis.fetch = (globalThis as any).__preloadOriginalFetch;
  assert.deepEqual(await request(base + '/restored', {}, 1000), { source: 'network' });
  assert.equal(networkRequests, 1, 'restored native fetch must use the compatible transport');
  assert.equal(globalThis.fetch, (globalThis as any).__preloadOriginalFetch);
  console.log(JSON.stringify({ node: process.version, result: 'passed', unexpectedNetworkRequests,
    restoredNetworkRequests: networkRequests, intercepted: calls.length }));
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
