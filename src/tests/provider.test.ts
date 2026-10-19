import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from '../client.ts';
import * as config from '../config.ts';
import * as format from '../format.ts';
import { provider } from '../commands/provider.ts';

describe('provider command', () => {
  let uploadSpy: ReturnType<typeof spyOn>;
  let requestSpy: ReturnType<typeof spyOn>;
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let configSpy: ReturnType<typeof spyOn>;
  const temporary: string[] = [];

  beforeEach(() => {
    uploadSpy = spyOn(client, 'uploadRequest').mockResolvedValue({ url: 'https://cdn.example.com/logos/test.png' });
    requestSpy = spyOn(client, 'apiKeyApiRequest').mockResolvedValue({ ok: true });
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
    configSpy = spyOn(config, 'getConfig').mockReturnValue({ actionHost: 'action.xapi.to', apiKey: 'sk-provider' });
  });

  afterEach(async () => {
    uploadSpy.mockRestore();
    requestSpy.mockRestore();
    outputSpy.mockRestore();
    errSpy.mockRestore();
    configSpy.mockRestore();
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function createFiles(body: Record<string, unknown> = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'xapi-provider-logo-'));
    temporary.push(dir);
    const service = join(dir, 'service.json');
    const logo = join(dir, 'my logo.png');
    await writeFile(service, JSON.stringify({ name: 'Weather', ...body }));
    await writeFile(logo, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA7sAAAAASUVORK5CYII=', 'base64'));
    return { dir, service, logo };
  }

  it('uploads binary multipart before creating with the returned remote URL', async () => {
    const { service, logo } = await createFiles();
    uploadSpy.mockImplementationOnce(async () => {
      expect(requestSpy).not.toHaveBeenCalled();
      return { url: 'https://cdn.example.com/logos/test.png' };
    });
    await provider(['create'], { file: service, 'logo-file': logo });
    const [url, init] = uploadSpy.mock.calls[0];
    expect(url).toBe('https://api.xapi.to/api/api-services/agent/logo');
    expect(init.headers).toEqual({ 'XAPI-KEY': 'sk-provider' });
    const image = init.body.get('file');
    expect(image.name).toBe('my logo.png');
    expect(image.type).toBe('image/png');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(await readFile(logo));
    expect(requestSpy.mock.calls[0][3]).toEqual({ method: 'POST', body: { name: 'Weather', logoUrl: 'https://cdn.example.com/logos/test.png' } });
    expect(uploadSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['image/jpeg', 'ffd8ffe000104a46494600010100000100010000ffd9'],
    ['image/gif', '47494638396101000100800000000000ffffff2c00000000010001000002024401003b'],
    ['image/webp', '524946461a000000574542505650384c0d0000002f00000010071011118888fe0700'],
  ])('detects %s from file content rather than its name', async (mime, hex) => {
    const { service, logo } = await createFiles();
    await writeFile(logo, Buffer.from(hex, 'hex'));
    await provider(['create'], { file: service, 'logo-file': logo });
    expect(uploadSpy.mock.calls[0][1].body.get('file').type).toBe(mime);
    expect(requestSpy.mock.calls[0][3].body.logoUrl).toBe('https://cdn.example.com/logos/test.png');
  });

  it('accepts the exact 10 MB boundary', async () => {
    const { service, logo } = await createFiles();
    const bytes = Buffer.alloc(10 * 1024 * 1024);
    (await readFile(logo)).copy(bytes);
    await writeFile(logo, bytes);
    await provider(['create'], { file: service, 'logo-file': logo });
    expect(uploadSpy.mock.calls[0][1].body.get('file').size).toBe(bytes.length);
  });

  it.each([{}, { logoUrl: 'https://example.com/existing.png' }])('preserves JSON and skips upload when no local LOGO is supplied: %j', async (body) => {
    const { service } = await createFiles(body);
    await provider(['create'], { file: service });
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(requestSpy.mock.calls[0][3].body).toEqual({ name: 'Weather', ...body });
  });

  it('rejects conflicting URL or missing LOGO argument before any write', async () => {
    const { service, logo } = await createFiles({ logoUrl: 'https://example.com/existing.png' });
    await expect(provider(['create'], { file: service, 'logo-file': logo })).rejects.toThrow();
    expect(errSpy.mock.calls[0][0]).toContain('conflicts');
    await expect(provider(['create'], { file: service, 'logo-file': 'true' })).rejects.toThrow();
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it.each(['missing', 'directory', 'unsupported', 'oversized'])('rejects %s local images without a write', async (kind) => {
    const { dir, service, logo } = await createFiles();
    if (kind === 'unsupported') await writeFile(logo, '<svg/>');
    if (kind === 'oversized') await writeFile(logo, Buffer.alloc(10 * 1024 * 1024 + 1));
    const path = kind === 'missing' ? join(dir, 'missing.png') : kind === 'directory' ? dir : logo;
    await expect(provider(['create'], { file: service, 'logo-file': path })).rejects.toThrow();
    expect(uploadSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 400, 500])('stops creation on upload HTTP %s without echoing response secrets', async (status) => {
    const { service, logo } = await createFiles();
    uploadSpy.mockRejectedValueOnce(new client.HttpError(status, 'sensitive-server-body'));
    await expect(provider(['create'], { file: service, 'logo-file': logo })).rejects.toThrow();
    expect(requestSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(errSpy.mock.calls)).toContain(`HTTP ${status}`);
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain('sensitive-server-body');
  });

  it.each([{}, { url: '/local/image.png' }, { url: 'file:///tmp/logo.png' }, { url: 'data:image/png;base64,x' }])('rejects upload responses without a remote URL: %j', async (response) => {
    const { service, logo } = await createFiles();
    uploadSpy.mockResolvedValueOnce(response);
    await expect(provider(['create'], { file: service, 'logo-file': logo })).rejects.toThrow();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('stops creation when the upload connection fails', async () => {
    const { service, logo } = await createFiles();
    uploadSpy.mockRejectedValueOnce(new Error('network failure with sk-provider'));
    await expect(provider(['create'], { file: service, 'logo-file': logo })).rejects.toThrow();
    expect(requestSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(errSpy.mock.calls)).toContain('Check network');
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain('sk-provider');
  });

  it('rejects logo-file on update rather than silently ignoring it', async () => {
    await expect(provider(['update', 'service-1'], { 'logo-file': './logo.png' })).rejects.toThrow();
    expect(requestSpy).not.toHaveBeenCalled();
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('uploads About Markdown as service metadata without retrying the write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xapi-provider-test-'));
    temporary.push(dir);
    const about = join(dir, 'ABOUT.md');
    await writeFile(about, '# About\n\nLong description.');

    await provider(['update', 'service/unsafe'], {
      'about-file': about,
      website: 'https://example.com',
    });

    expect(requestSpy).toHaveBeenCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/api-services/agent/services/service%2Funsafe',
      {
        method: 'PATCH',
        body: {
          aboutMarkdown: '# About\n\nLong description.',
          website: 'https://example.com',
        },
      },
    );
  });

  it('creates a service with an explicitly configured per-user rate limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xapi-provider-create-test-'));
    temporary.push(dir);
    const service = join(dir, 'service.json');
    await writeFile(service, JSON.stringify({ name: 'Weather', accessMode: 'PROXY' }));

    await provider(['create'], {
      file: service,
      'rate-limit-requests': '100',
      'rate-limit-period-seconds': '60',
    });

    expect(requestSpy).toHaveBeenCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/api-services/agent/services',
      {
        method: 'POST',
        body: {
          name: 'Weather',
          accessMode: 'PROXY',
          rateLimitConfig: { requests: 100, periodSeconds: 60 },
        },
      },
    );
  });

  it('updates or clears a service rate limit without metadata', async () => {
    await provider(['update', 'service-1'], {
      'rate-limit-requests': '250',
      'rate-limit-period-seconds': '3600',
    });

    expect(requestSpy).toHaveBeenLastCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/api-services/agent/services/service-1',
      {
        method: 'PATCH',
        body: { rateLimitConfig: { requests: 250, periodSeconds: 3600 } },
      },
    );

    await provider(['update', 'service-1'], { 'clear-rate-limit': 'true' });

    expect(requestSpy).toHaveBeenLastCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/api-services/agent/services/service-1',
      { method: 'PATCH', body: { rateLimitConfig: null } },
    );
  });

  it('publishes a revision with changelog content and no automatic retry', async () => {
    await provider(['publish', 'service-1', 'revision-1'], {
      changelog: 'Added provider metrics',
    });

    expect(requestSpy).toHaveBeenCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/api-services/agent/services/service-1/revisions/revision-1/submit',
      { method: 'POST', body: { changelog: 'Added provider metrics' } },
    );
  });

  it('links a primary skill using service:update', async () => {
    await provider(['skill', 'link', 'service-1', 'skill-1'], {});

    expect(requestSpy).toHaveBeenCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/api-services/agent/services/service-1',
      { method: 'PATCH', body: { linkedSkillId: 'skill-1' } },
    );
  });

  it('queries provider events with the opaque cursor unchanged', async () => {
    await provider(['events'], { after: 'opaque+/cursor=', limit: '25' });

    const path = String(requestSpy.mock.calls[0]?.[2]);
    const url = new URL(`https://api.xapi.to${path}`);
    expect(url.pathname).toBe('/api/agent/events');
    expect(url.searchParams.get('after')).toBe('opaque+/cursor=');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(requestSpy.mock.calls[0]?.[3]).toEqual({ retries: 2 });
  });

  it('writes a scaffold without silently overwriting an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xapi-scaffold-test-'));
    temporary.push(dir);
    const destination = join(dir, 'generated-skill', 'SKILL.md');
    requestSpy.mockResolvedValue({ scaffoldMarkdown: '# Generated', currentFingerprint: { major: 1 } });

    await provider(['skill', 'scaffold', 'service-1'], { output: destination });
    expect(await readFile(destination, 'utf8')).toBe('# Generated');

    await expect(provider(['skill', 'scaffold', 'service-1'], { output: destination })).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('provider request failed', expect.stringContaining('EEXIST'));
  });

  it('requires explicit confirmation for delete', async () => {
    await expect(provider(['delete', 'service-1'], {})).rejects.toThrow('err called');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('rejects bare value-taking flags before network or file I/O', async () => {
    for (const [args, flags] of [
      [['get', 'service-1'], { version: 'true' }],
      [['rollback', 'service-1', '1'], { revision: 'true' }],
      [['events'], { after: 'true' }],
      [['skill', 'scaffold', 'service-1'], { output: 'true' }],
      [['skill', 'fingerprint', 'service-1'], { 'skill-version-id': 'true' }],
      [['delete', 'service-1'], { confirm: 'true' }],
      [['update', 'service-1'], {
        'rate-limit-requests': 'true',
        'rate-limit-period-seconds': '60',
      }],
    ] as Array<[string[], Record<string, string>]>) {
      requestSpy.mockClear();
      await expect(provider(args, flags)).rejects.toThrow('err called');
      expect(requestSpy).not.toHaveBeenCalled();
    }
  });

  it('rejects contradictory metadata flags before network I/O', async () => {
    await expect(provider(['update', 'service-1'], {
      about: '# New',
      'clear-about': 'true',
    })).rejects.toThrow('err called');
    expect(requestSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      '--clear-about cannot be combined with --about or --about-file',
    );
  });

  it('rejects incomplete, conflicting, or out-of-range rate-limit flags before network I/O', async () => {
    for (const flags of [
      { 'rate-limit-requests': '100' },
      {
        'rate-limit-requests': '100',
        'rate-limit-period-seconds': '60',
        'clear-rate-limit': 'true',
      },
      {
        'rate-limit-requests': '1000001',
        'rate-limit-period-seconds': '60',
      },
      {
        'rate-limit-requests': '100',
        'rate-limit-period-seconds': '86401',
      },
    ] as Array<Record<string, string>>) {
      requestSpy.mockClear();
      await expect(provider(['update', 'service-1'], flags)).rejects.toThrow('err called');
      expect(requestSpy).not.toHaveBeenCalled();
    }
  });
});
