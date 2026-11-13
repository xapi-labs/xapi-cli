import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { actionSaveJson, HttpError } from '../client.ts';

const opts = { actionHost: 'action.xapi.to', apiKey: 'sk-local-test' };
const envelope = {
  success: true,
  data: { text: '完整结果', nested: { values: [1, 2, 3] } },
  billing: { cost_usd: '0.00000042', cost_status: 'charged', upstream_calls: [{ cost_usd: '0.00000042' }] },
  request_id: 'request-file-test',
  meta: { provider: 'synthetic' },
};

describe('actionSaveJson', () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'xapi-json-output-')); });
  afterEach(async () => { fetchSpy?.mockRestore(); await rm(dir, { recursive: true, force: true }); });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });

  it('reserves a private file before one execution, preserving the complete envelope and JSON mode', async () => {
    const target = join(dir, 'result.json');
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
      expect((await stat(target)).size).toBe(0);
      expect((await stat(target)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(String(init?.body))).toEqual({ action_id: 'test.action', input: { q: 'hello' }, method: 'POST' });
      return reply(envelope);
    }) as typeof fetch);
    const saved = await actionSaveJson('test.action', { q: 'hello' }, opts, target, 'POST');
    const text = await readFile(target, 'utf8');
    expect(JSON.parse(text)).toEqual(envelope);
    expect(saved).toEqual({ output: resolve(target), bytes: Buffer.byteLength(text) });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses existing files and symlinks before execution without removing or overwriting them', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');
    const existing = join(dir, 'existing.json');
    const link = join(dir, 'link.json');
    await writeFile(existing, 'keep');
    await symlink(existing, link);
    for (const target of [existing, link]) {
      await expect(actionSaveJson('test.action', {}, opts, target)).rejects.toThrow('already exists');
      expect(await readFile(target, 'utf8')).toBe('keep');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not execute when the output parent does not exist', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');
    await expect(actionSaveJson('test.action', {}, opts, join(dir, 'missing', 'result.json'))).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([401, 429, 503])('saves a full HTTP %i error envelope and never retries execution', async status => {
    const failure = { ...envelope, success: false, data: { error: 'upstream failed', details: 'x'.repeat(1000) } };
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply(failure, status));
    const target = join(dir, 'error.json');
    await expect(actionSaveJson('test.action', {}, opts, target)).rejects.toBeInstanceOf(HttpError);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(failure);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { message: 'Business failure' },
    { statusCode: 401, error: 'Unauthorized', message: 'Invalid key' },
    { statusCode: 403, error: 'OAuth Required', message: 'OAuth required' },
  ])('saves HTTP 200 business errors before rejecting', async data => {
    const failure = { ...envelope, success: false, data };
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply(failure));
    const target = join(dir, 'business-error.json');
    await expect(actionSaveJson('test.action', {}, opts, target)).rejects.toThrow();
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(failure);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Response('not json', { status: 200 }),
    new Response('upstream unavailable', { status: 503 }),
    new Response(null, { status: 204 }),
  ])('cleans up when there is no complete JSON response', async response => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const target = join(dir, 'invalid.json');
    await expect(actionSaveJson('test.action', {}, opts, target)).rejects.toThrow();
    await expect(stat(target)).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('cleans up a network failure without replaying the execute request', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const target = join(dir, 'network.json');
    await expect(actionSaveJson('test.action', {}, opts, target)).rejects.toThrow('fetch failed');
    await expect(stat(target)).rejects.toThrow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('cleans up partial file writes without executing a second time', async () => {
    const probe = await open(join(dir, 'probe'), 'wx');
    const prototype = Object.getPrototypeOf(probe);
    const original = prototype.writeFile;
    await probe.close();
    const writeSpy = spyOn(prototype, 'writeFile').mockImplementation(async function(this: any, data: any) {
      await original.call(this, String(data).slice(0, 5), 'utf8');
      throw new Error('simulated disk full');
    });
    const target = join(dir, 'partial.json');
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(reply(envelope));
    try {
      await expect(actionSaveJson('test.action', {}, opts, target)).rejects.toThrow('simulated disk full');
      await expect(stat(target)).rejects.toThrow();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally { writeSpy.mockRestore(); }
  });

  it('applies the host allowlist before transport and removes its own reserved file', async () => {
    fetchSpy = spyOn(globalThis, 'fetch');
    const target = join(dir, 'blocked.json');
    await expect(actionSaveJson('test.action', {}, { ...opts, actionHost: 'example.invalid' }, target)).rejects.toThrow('untrusted host');
    await expect(stat(target)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('call --output-json process exit and stdout', () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let calls: number;
  let body: unknown;
  let status: number;
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'xapi-json-cli-')));
    calls = 0; body = envelope; status = 200;
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => { calls++; return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); } });
  });
  afterEach(async () => { server.stop(true); await rm(dir, { recursive: true, force: true }); });
  async function run(flags: string[]) {
    const proc = Bun.spawn([process.execPath, '--no-env-file', resolve(import.meta.dir, '../index.ts'), 'call', 'test.action', '--input', '{}', ...flags], {
      cwd: dir,
      env: { PATH: process.env.PATH!, HOME: dir, XAPI_KEY: 'sk-local-test', XAPI_ACTION_HOST: `127.0.0.1:${server.port}` },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, stdout, stderr };
  }

  it('keeps default JSON stdout unchanged and prints only a receipt in file mode', async () => {
    const ordinary = await run([]);
    expect(ordinary.code).toBe(0); expect(JSON.parse(ordinary.stdout)).toEqual(envelope);
    const saved = await run(['--output-json', 'result.json']);
    expect(saved.code).toBe(0); expect(saved.stderr).toBe('');
    expect(JSON.parse(saved.stdout)).toEqual({ success: true, output: join(dir, 'result.json'), bytes: (await stat(join(dir, 'result.json'))).size });
    expect(JSON.parse(await readFile(join(dir, 'result.json'), 'utf8'))).toEqual(envelope);
    expect(saved.stdout).not.toContain(envelope.request_id); expect(calls).toBe(2);
  });

  it.each([200, 503])('exits nonzero after preserving a full %i failure envelope exactly once', async httpStatus => {
    status = httpStatus; body = { ...envelope, success: false, data: { message: 'operation failed' } };
    const result = await run(['--output-json', 'error.json']);
    expect(result.code).toBe(1); expect(result.stdout).toBe('');
    expect(result.stderr).toContain('call failed');
    expect(JSON.parse(await readFile(join(dir, 'error.json'), 'utf8'))).toEqual(body);
    expect(calls).toBe(1);
  });

  it('rejects conflicting or missing output options before any execution', async () => {
    for (const flags of [
      ['--output-json'], ['--output-json', ''], ['--output-json', '-'],
      ['--output-json', 'result.json', '--output', 'raw.bin'],
      ['--output-json', 'result.json', '--stream'],
      ['--output-json', 'result.json', '--code', 'curl'],
    ]) {
      const result = await run(flags);
      expect(result.code).toBe(1); expect(result.stderr).toContain('--output-json');
    }
    expect(calls).toBe(0);
    await expect(stat(join(dir, 'result.json'))).rejects.toThrow();
  });
});
