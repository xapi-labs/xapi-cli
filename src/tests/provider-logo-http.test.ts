import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA7sAAAAASUVORK5CYII=', 'base64');

describe('provider LOGO CLI over HTTP', () => {
  let dir: string;
  let server: ReturnType<typeof Bun.serve>;
  let uploadStatus = 201;
  let service: any;
  let requests: string[];
  let uploaded: Uint8Array;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xapi logo cli '));
    await writeFile(join(dir, 'service.json'), JSON.stringify({ name: 'Logo test', authType: 'HEADER' }));
    await writeFile(join(dir, 'logo image.png'), PNG);
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(`${req.method} ${path}`);
      expect(req.headers.get('xapi-key')).toBe('local-test-key');
      if (path.endsWith('/logo')) {
        const form = await req.formData();
        const file = form.get('file') as File;
        expect(file.type).toBe('image/png');
        expect(file.name).toBe('logo image.png');
        uploaded = new Uint8Array(await file.arrayBuffer());
        return Response.json({ url: 'https://cdn.example.com/logos/local.png' }, { status: uploadStatus });
      }
      if (req.method === 'POST') service = { ...await req.json(), id: 'service-1' };
      return Response.json(service);
    } });
  });
  afterAll(async () => { server?.stop(true); await rm(dir, { recursive: true, force: true }); });
  async function cli(...args: string[]) {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('../index.ts', import.meta.url)), 'provider', ...args], {
      env: { ...process.env, XAPI_KEY: 'local-test-key', XAPI_API_HOST: `127.0.0.1:${server.port}` }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  }
  it('sends exact multipart bytes, creates with the uploaded URL, then reads the same logoUrl', async () => {
    requests = []; uploadStatus = 201;
    const created = await cli('create', '--file', join(dir, 'service.json'), '--logo-file', join(dir, 'logo image.png'));
    expect(created.exit).toBe(0);
    expect(JSON.parse(created.stdout).logoUrl).toBe('https://cdn.example.com/logos/local.png');
    expect(Buffer.from(uploaded)).toEqual(PNG);
    expect(requests).toEqual(['POST /api/api-services/agent/logo', 'POST /api/api-services/agent/services']);
    const read = await cli('get', 'service-1');
    expect(read.exit).toBe(0);
    expect(JSON.parse(read.stdout).logoUrl).toBe(service.logoUrl);
  });
  it('exits nonzero on storage failure and never sends create or retries upload', async () => {
    requests = []; uploadStatus = 500;
    const result = await cli('create', '--file', join(dir, 'service.json'), '--logo-file', join(dir, 'logo image.png'));
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain('LOGO upload failed (HTTP 500)');
    expect(requests).toEqual(['POST /api/api-services/agent/logo']);
  });
  it('exits nonzero for an unreadable local file before contacting the API', async () => {
    // Permission bits do not restrict root; the other validation tests still run there.
    if (process.getuid?.() === 0) return;
    requests = [];
    const path = join(dir, 'private.png');
    await writeFile(path, PNG); await chmod(path, 0);
    try {
      const result = await cli('create', '--file', join(dir, 'service.json'), '--logo-file', path);
      expect(result.exit).not.toBe(0);
      expect(result.stderr).toContain('not readable');
      expect(requests).toEqual([]);
    } finally { await chmod(path, 0o600); }
  });
});
