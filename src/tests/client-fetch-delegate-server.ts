import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import busboy from 'busboy';
import { setTimeout as delay } from 'node:timers/promises';

// Use a real Node HTTP receiver even when the client runs in Bun: Bun's HTTP
// compatibility server can buffer the request before JS applies backpressure.
const budget = 400;
const counts = new Map<string, number>();
const binary = Buffer.from([0, 255, 128, 13, 10, 42]);
const server = createServer(async (req, res) => {
  const path = req.url!;
  counts.set(path, (counts.get(path) || 0) + 1);
  req.on('error', () => {});
  if (path === '/stalled' || path === '/cancel' || path === '/stalled-upload') { req.resume(); return; }
  const chunks: Buffer[] = [];
  const multipart = path === '/slow-multipart' ? busboy({ headers: req.headers }) : undefined;
  let fileBytes = 0;
  let manifest = '';
  multipart?.on('field', (name, value) => { if (name === 'manifest') manifest = value; });
  multipart?.on('file', (_name, file) => { file.on('data', chunk => { fileBytes += chunk.length; }); });
  try {
    for await (const chunk of req) {
      if (multipart) { if (!multipart.write(chunk)) await once(multipart, 'drain'); }
      else chunks.push(Buffer.from(chunk));
      if (path === '/slow-multipart') {
        for (let offset = 0; offset < chunk.length; offset += 65_536) await delay(3);
      }
    }
  } catch { return; } // Expected when an upload is aborted.

  if (multipart) {
    const complete = once(multipart, 'finish');
    multipart.end();
    await complete;
    assert.equal(manifest, 'preserved');
    assert.equal(fileBytes, 32 * 1024 * 1024);
    assert.equal(req.headers['x-upload-fixture'], 'preserved');
    res.end('{"ok":true}'); return;
  }
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
  if (path === '/slow-response' || path === '/stalled-response' || path === '/stalled-error') {
    res.writeHead(path === '/stalled-error' ? 409 : 200, { 'content-type': 'application/json' });
    res.write('{"ok":');
    if (path !== '/slow-response') return;
    for (let i = 0; i < 6; i++) { await delay(budget / 3); res.write(' '); }
    res.end('true}'); return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ source: 'network', bytes: body.length, contentType: req.headers['content-type'] || null,
    binaryReceived: body.includes(binary) }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
process.send!({ port: (server.address() as { port: number }).port });
process.on('message', message => {
  if (message !== 'close') return;
  server.closeAllConnections();
  server.close(() => { process.send!({ counts: [...counts] }); process.disconnect(); });
});
