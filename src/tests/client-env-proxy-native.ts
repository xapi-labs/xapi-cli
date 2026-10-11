import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionStream, actionDownload, request, RequestTimeoutError, createArtifactControlSession } from '../client.ts';

const operation = process.argv[3];
if (process.argv[2] === '--probe') {
  const host = process.argv[4];
  const options = { actionHost: host, apiKey: 'local-proxy-fixture' };
  if (operation === 'native') {
    assert.deepEqual(await (await fetch(`http://${host}/read`)).json(), { ok: true });
  } else if (operation === 'request') {
    assert.deepEqual(await request(`http://${host}/read`, {}, 2000), { ok: true });
  } else if (operation === 'session') {
    const session = createArtifactControlSession();
    try { assert.deepEqual(await session.request(`http://${host}/read`, {}, 2000, 0), { ok: true }); }
    finally { await session.close(); }
  } else if (operation === 'timeout') {
    await assert.rejects(request(`http://${host}/stall`, {}, 80), RequestTimeoutError);
  } else if (operation === 'cancel') {
    const abort = new AbortController();
    const pending = request(`http://${host}/stall`, { signal: abort.signal }, 2000);
    setTimeout(() => abort.abort(), 80);
    await assert.rejects(pending, { name: 'AbortError' });
  } else if (operation === 'redirect') {
    await assert.rejects(request(`http://${host}/redirect`, {}, 2000), /refusing to follow redirect/);
  } else if (operation === 'stream' || operation === 'wrapper') {
    if (operation === 'wrapper') {
      const native = globalThis.fetch;
      globalThis.fetch = ((input, init) => native(input, init)) as typeof fetch;
    }
    const frames: Buffer[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: Uint8Array) => { frames.push(Buffer.from(chunk)); return true; }) as typeof write;
    try { await actionStream('stream', {}, options); }
    finally { process.stdout.write = write; }
    assert.equal(Buffer.concat(frames).toString(), 'data: proxy-fixture\n\n');
  } else if (operation === 'download') {
    const root = await mkdtemp(join(tmpdir(), 'xapi-proxy-download-'));
    try {
      const target = join(root, 'download.bin');
      const result = await actionDownload('download', {}, options, target);
      assert.equal(result.bytes, 6);
      assert.deepEqual(await readFile(target), Buffer.from([0, 255, 128, 13, 10, 42]));
    } finally { await rm(root, { recursive: true, force: true }); }
  } else throw new Error('unknown local probe');
  console.log(JSON.stringify({ result: 'passed' }));
} else {
  const mode = process.argv[2] || 'flag';
  const sockets = new Set<Duplex>();
  let targetRequests = 0;
  let proxyConnects = 0;
  const target = createServer(async (req, res) => {
    targetRequests++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    if (req.url === '/read') { res.end('{"ok":true}'); return; }
    if (req.url === '/stall') return;
    if (req.url === '/redirect') { res.writeHead(307, { location: '/read' }); res.end(); return; }
    assert.equal(req.url, '/v1/actions/execute');
    assert.equal(req.headers['xapi-key'], 'local-proxy-fixture');
    assert.equal(req.headers['proxy-authorization'], undefined);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (input.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: proxy-fixture\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([0, 255, 128, 13, 10, 42]));
    }
  });
  const proxy = createServer((_req, res) => { res.writeHead(500); res.end(); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as { port: number }).port;
  proxy.on('connect', (req, socket, head) => {
    proxyConnects++;
    // The fixture can tunnel only to its own loopback target.
    assert.equal(req.url, `127.0.0.1:${targetPort}`);
    const upstream = connect(targetPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    for (const endpoint of [socket, upstream]) {
      sockets.add(endpoint);
      endpoint.on('error', () => {});
      endpoint.on('close', () => sockets.delete(endpoint));
    }
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  const report: Record<string, { proxyConnects: number; targetRequests: number }> = {};
  try {
    for (const probe of ['native', 'request', 'session', 'stream', 'download', 'wrapper', 'timeout', 'cancel', 'redirect']) {
      const env = { ...process.env };
      // Never inherit real proxies, Node options or credentials into local probes.
      for (const key of Object.keys(env)) {
        if (/PROXY|NODE_OPTIONS|API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY/i.test(key)) delete env[key];
      }
      env.NODE_USE_ENV_PROXY = '0';
      env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
      env.HTTPS_PROXY = env.HTTP_PROXY;
      env.NO_PROXY = mode === 'no-proxy' ? '127.0.0.1' : '';
      const flags = mode === 'env' || mode === 'options' || mode === 'direct' ? [] : ['--use-env-proxy'];
      if (mode === 'env') env.NODE_USE_ENV_PROXY = '1';
      if (mode === 'options') env.NODE_OPTIONS = '"--use-env-proxy"';
      if (mode === 'disabled') { env.NODE_OPTIONS = '--use-env-proxy'; flags.push('--no-use-env-proxy'); }
      const beforeProxy = proxyConnects;
      const beforeTarget = targetRequests;
      const child = spawn(process.execPath, [...flags, fileURLToPath(import.meta.url), '--probe', probe,
        `127.0.0.1:${targetPort}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', chunk => stdout += chunk);
      // Keep failure output private: it could contain a future transport detail.
      child.stderr.resume();
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', result => { clearTimeout(timer); resolve(result); });
      });
      assert.equal(code, 0, `local ${probe} probe failed`);
      assert.equal(JSON.parse(stdout).result, 'passed');
      report[probe] = { proxyConnects: proxyConnects - beforeProxy, targetRequests: targetRequests - beforeTarget };
    }
    console.log(JSON.stringify({ node: process.version, mode, report }));
  } finally {
    for (const socket of sockets) socket.destroy();
    target.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([target, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
}
