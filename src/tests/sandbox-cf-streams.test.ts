import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

async function consume(body: string, consumer = 'consumeCfLogs') {
  const server = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({
    start(controller) {
      const bytes = Buffer.from(body);
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  try {
    const helper = fileURLToPath(new URL('../sandbox-cf-streams.ts', import.meta.url));
    const child = spawn(process.execPath, ['-e', `import {${consumer}} from ${JSON.stringify(helper)}; await ${consumer}(${JSON.stringify('http://127.0.0.1:' + server.port)});`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on('data', x => stdout.push(x)); child.stderr.on('data', x => stderr.push(x));
    const [code] = await once(child, 'exit');
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
  } finally { server.stop(true); }
}

test('CF log CLI consumer preserves fragmented binary stdout and stderr', async () => {
  const stdout = Buffer.from([0, 255, 128, 10, 13, 65]), stderr = Buffer.from([1, 254, 10]);
  const frame = (event: string, value: unknown) => 'event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n';
  const result = await consume(frame('stdout', { data: stdout.toString('base64') }) + frame('stderr', { data: stderr.toString('base64') }) + frame('end', { exitCode: 0 }));
  expect(result.code).toBe(0); expect(result.stdout).toEqual(stdout); expect(result.stderr).toEqual(stderr);
});

test('CF log CLI consumer detects an interrupted source instead of claiming success', async () => {
  const result = await consume('event: stdout\ndata: {"data":"b2s="}\n\n');
  expect(result.code).not.toBe(0); expect(result.stdout.toString()).toBe('ok');
  expect(result.stderr.toString()).toContain('without its completion frame');
});

test('CF file watch preserves fragmented native masks and Unicode/newline paths', async () => {
  const frame = (event: string, value: unknown) => 'event: ' + event + '\ndata: ' + JSON.stringify(value) + '\n\n';
  const path = '/workspace/中文\nname.txt';
  const result = await consume(frame('ready', { path: '/workspace', recursive: true }) + frame('change', {
    path, events: ['MOVED_TO', 'ISDIR'], cookie: '0123abcd',
  }) + frame('end', { exitCode: 0 }), 'consumeCfFileEvents');
  expect(result.code).toBe(0);
  expect(result.stdout.toString().trim().split('\n').map(line => JSON.parse(line))).toEqual([
    { event: 'ready', path: '/workspace', recursive: true },
    { event: 'change', path, events: ['MOVED_TO', 'ISDIR'], cookie: '0123abcd' },
  ]);
});

test('CF file watch reports native errors and incomplete streams honestly', async () => {
  const failed = await consume('event: error\ndata: {"error":"native watch path missing"}\n\n', 'consumeCfFileEvents');
  expect(failed.code).not.toBe(0);
  expect(failed.stderr.toString()).toContain('native watch path missing');
  const interrupted = await consume('event: ready\ndata: {"path":"/workspace"}\n\n', 'consumeCfFileEvents');
  expect(interrupted.code).not.toBe(0);
  expect(interrupted.stderr.toString()).toContain('without its completion frame');
});
