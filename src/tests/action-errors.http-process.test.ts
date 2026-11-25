import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'xapi-http-errors-'));
const preload = join(root, 'isolate-config.mjs');
writeFileSync(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const exists = fs.existsSync;
fs.existsSync = p => String(p).endsWith('/.xapi/config.json') ? false : exists(p);
syncBuiltinESMExports();
`);
const blob = 'x'.repeat(1024 * 1024);
let reply: (req: IncomingMessage, res: ServerResponse) => void;
let requests = 0;
let host: string;
const server = createServer(async (req, res) => {
  requests++;
  for await (const _ of req) { /* Drain the real HTTP request. */ }
  reply(req, res);
});

beforeAll(async () => {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

function call(flags: string[] = [], slowConsumer = false): Promise<{ code: number | null; stdout: string; stderr: string }> {
  requests = 0;
  return new Promise((done, reject) => {
    const child = spawn('node', ['--import', preload, resolve(import.meta.dir, '../../dist/index.js'), 'call', 'fixture.action', '--input', '{}', ...flags], {
      env: { PATH: process.env.PATH, XAPI_KEY: 'xapi_http_fixture_only', XAPI_ACTION_HOST: host, XAPI_OUTPUT: 'json' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', part => stdout += part);
    child.stderr.on('data', part => stderr += part);
    child.on('error', reject);
    // Deliberately apply backpressure; this timer is a test stimulus, not the
    // production mechanism deciding whether output has drained.
    if (slowConsumer) { child.stdout.pause(); setTimeout(() => child.stdout.resume(), 150); }
    child.on('close', code => done({ code, stdout, stderr }));
  });
}

describe('built Node CLI with real HTTP and pipe backpressure', () => {
  test('flushes the complete large business failure before exiting', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, data: { blob }, error: { code: 'UPSTREAM_ERROR', message: 'Rejected' } }));
    };
    const result = await call([], true);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout).data.blob).toBe(blob);
    expect(JSON.parse(result.stderr).detail.code).toBe('UPSTREAM_ERROR');
    expect(requests).toBe(1);
  });

  test('flushes large structured stderr without losing fields after the message', async () => {
    reply = (_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: blob, code: 'INVALID_INPUT', details: [{ instancePath: '/body/name', message: 'required' }] }));
    };
    const result = await call();
    expect(result.code).toBe(1);
    const detail = JSON.parse(result.stderr).detail;
    expect(detail.message).toBe(blob);
    expect(detail.code).toBe('INVALID_INPUT');
    expect(detail.details[0].instancePath).toBe('/body/name');
    expect(requests).toBe(1);
  });

  for (const mode of ['json', 'stream', 'download']) {
    test(`${mode}: a truncated HTTP error keeps status and Retry-After`, async () => {
      reply = (_req, res) => {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
        res.write('{"code":"RATE_LIMIT",');
        setTimeout(() => res.destroy(), 40);
      };
      const target = join(root, `${mode}.bin`);
      const result = await call(mode === 'stream' ? ['--stream'] : mode === 'download' ? ['--output', target] : []);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stderr).detail).toMatchObject({ status: 429, code: 'HTTP_429', retry_after_ms: 7000, outcome: 'failed' });
      expect(requests).toBe(1);
      expect(existsSync(target)).toBe(false);
    });
  }
});
