import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../config.ts';
import * as format from '../format.ts';
import { provider } from '../commands/provider.ts';
import { providerRequest, redactProvider } from '../provider-client.ts';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const report = (state: string, review: unknown = null) => ({ revision: { id: 'rev-1', state }, review });

describe('provider lifecycle commands', () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof spyOn>;
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let configSpy: ReturnType<typeof spyOn>;
  let oldExit: typeof process.exitCode;
  let oldRetry: string | undefined;
  const calls: Array<{ url: string; method: string; headers: Headers; body: any; signal?: AbortSignal }> = [];
  let respond: (call: typeof calls[number]) => Response | Promise<Response>;
  const file = async (value: unknown, name = 'input.json') => {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xapi-provider-'));
    calls.length = 0;
    oldExit = process.exitCode;
    process.exitCode = 0;
    oldRetry = process.env.XAPI_RETRY_BASE_MS;
    process.env.XAPI_RETRY_BASE_MS = '1';
    respond = () => json({});
    configSpy = spyOn(config, 'getConfig').mockReturnValue({ actionHost: 'action.xapi.to', apiKey: 'sk-cli-secret' });
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('cli error'); }) as any);
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (url: any, options: RequestInit) => {
      const call = { url: String(url), method: options.method!, headers: new Headers(options.headers),
        body: options.body ? JSON.parse(String(options.body)) : undefined, signal: options.signal ?? undefined };
      calls.push(call);
      expect(options.redirect).toBe('manual');
      return respond(call);
    }) as any);
  });

  afterEach(async () => {
    fetchSpy.mockRestore(); outputSpy.mockRestore(); errSpy.mockRestore(); configSpy.mockRestore();
    process.exitCode = oldExit;
    if (oldRetry === undefined) delete process.env.XAPI_RETRY_BASE_MS;
    else process.env.XAPI_RETRY_BASE_MS = oldRetry;
    await rm(dir, { recursive: true, force: true });
  });

  it('completes import, configuration, submission, and polling on scoped management routes', async () => {
    let polls = 0;
    respond = call => {
      expect(call.headers.get('XAPI-KEY')).toBe('sk-cli-secret');
      expect(call.url).toStartWith('https://api.xapi.to/api/api-services/agent/');
      if (call.url.endsWith('register-api-service')) return json({ success: true,
        apiService: { id: 'svc-1', activeVersionId: 'rev-1', activeVersion: { id: 'rev-1', state: 'DRAFT' } }, validation: { warnings: [] } }, 201);
      if (call.method === 'PATCH') return json({ id: 'rev-1', state: 'SANDBOX', ...call.body });
      if (call.url.endsWith('/submit')) return json({ state: 'IN_REVIEW', willReview: true });
      return json(report(++polls === 1 ? 'IN_REVIEW' : 'PUBLISHED'));
    };
    const spec = { openapi: '3.0.3', info: { title: 'Example', version: '1.0' }, paths: {} };
    await provider(['import'], { file: await file(spec), 'private-headers-file': await file({ Authorization: 'Bearer upstream-secret' }, 'headers.json') });
    expect(calls[0].body).toEqual({ openApiSpec: spec, privateHeaders: { Authorization: 'Bearer upstream-secret' } });
    expect(outputSpy.mock.calls[0][0]).toMatchObject({ serviceId: 'svc-1', revisionId: 'rev-1', state: 'DRAFT' });
    await provider(['update', 'svc-1'], { revision: 'rev-1', file: await file({ privateHeaders: { Authorization: 'Bearer upstream-secret' } }) });
    expect(calls[1].method).toBe('PATCH');
    expect(calls[1].url).toEndWith('/services/svc-1/versions/rev-1');
    expect(JSON.stringify(outputSpy.mock.calls)).not.toContain('upstream-secret');
    await provider(['submit', 'svc-1'], { revision: 'rev-1', changelog: 'Initial release' });
    expect(calls[2].body).toEqual({ changelog: 'Initial release' });
    await provider(['wait', 'svc-1'], { revision: 'rev-1', interval: '1ms', timeout: '1s' });
    expect(outputSpy.mock.calls.at(-1)?.[0]).toMatchObject({ success: true, reason: 'published' });
    expect(process.exitCode).toBe(0);
  });

  it('treats HTTP 201 application validation failures as failures with structured diagnostics', async () => {
    respond = () => json({ success: false, validation: { errors: [{ field: 'openapi', message: 'Must be 3.0.3' }] } }, 201);
    await provider(['import'], { file: await file({ openapi: '2.0' }) });
    expect(process.exitCode).toBe(1);
    expect(outputSpy.mock.calls[0][0]).toMatchObject({ success: false, validation: { errors: [{ field: 'openapi', message: 'Must be 3.0.3' }] } });
    expect(calls.length).toBe(1);
  });

  it('rejects malformed and non-object files without exposing input or making requests', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{"privateHeaders": "upstream-secret"');
    await expect(provider(['import'], { file: path })).rejects.toThrow('cli error');
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain('upstream-secret');
    await expect(provider(['import'], { file: await file([]) })).rejects.toThrow('cli error');
    expect(calls).toHaveLength(0);
  });

  it('guards endpoint merges while allowing explicit additions and full replacements', async () => {
    respond = () => json({ state: 'SANDBOX' });
    const path = await file({ endpoints: [{ name: 'search', method: 'GET', path: '/search' }] });
    await expect(provider(['update', 'svc'], { file: path, revision: 'rev-1' })).rejects.toThrow('cli error');
    expect(calls).toHaveLength(0);
    await provider(['update', 'svc'], { file: path, revision: 'rev-1', mode: 'replace' });
    expect(calls[0].method).toBe('PUT');
    await provider(['update', 'svc'], { file: path, revision: 'rev-1', 'allow-new-endpoints': 'true' });
    expect(calls[1].method).toBe('PATCH');
    await provider(['update', 'svc'], { file: await file({ endpoints: [{ id: 'ep-1', costPerCall: '0.002' }] }), revision: 'rev-1' });
    expect(calls[2].body.endpoints[0].id).toBe('ep-1');
  });

  it('gets owner configuration and overview with credentials redacted', async () => {
    respond = call => call.url.endsWith('version-overview') ? json({ currentMajor: 1, majors: [] })
      : json({ id: 'svc', activeVersion: { id: 'rev-1', version: 'v1.0' },
        currentVersion: { id: 'rev-1', authConfig: 'raw-secret', privateHeaders: { Custom: 'custom-secret' },
          endpoints: [{ id: 'ep-1', bodySchema: { type: 'object', properties: { token: { type: 'string' }, name: { type: 'string' } } } }] },
        description: 'raw-secret custom-secret' });
    await provider(['get', 'svc'], { version: 'v1.0' });
    expect(calls[0].url).toEndWith('/services/svc?version=v1.0');
    expect(calls).toHaveLength(1);
    expect(outputSpy.mock.calls[0][0]).toMatchObject({ id: 'svc', currentVersion: { id: 'rev-1' } });
    expect(JSON.stringify(outputSpy.mock.calls)).not.toContain('raw-secret');
    expect(JSON.stringify(outputSpy.mock.calls)).not.toContain('custom-secret');
    expect(outputSpy.mock.calls[0][0].currentVersion.endpoints).toEqual([
      { id: 'ep-1', bodySchema: { type: 'object', properties: { token: { type: 'string' }, name: { type: 'string' } } } },
    ]);
  });

  it('uses public rules without credentials and owner list with scoped key', async () => {
    await provider(['spec-rules'], {});
    expect(calls[0].headers.has('XAPI-KEY')).toBe(false);
    await provider(['list'], {});
    expect(calls[1].url).toEndWith('/agent/services');
    expect(calls[1].headers.get('XAPI-KEY')).toBe('sk-cli-secret');
  });

  it('never retries import, update, or submit, and does not print server-echoed secrets', async () => {
    respond = () => new Response('upstream-secret sk-cli-secret truncated-upstream', { status: 503 });
    const path = await file({});
    for (const [args, flags] of [
      [['import'], { file: path }],
      [['update', 'svc'], { revision: 'rev-1', file: path }],
      [['submit', 'svc'], { revision: 'rev-1' }],
    ] as [string[], Record<string, string>][]) {
      await expect(provider(args, flags)).rejects.toThrow('cli error');
    }
    expect(calls).toHaveLength(3);
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain('secret');
    expect(errSpy.mock.calls[0][1]).toContain('No automatic retry');
  });

  it('does not print server-echoed secrets from existing provider commands', async () => {
    respond = () => new Response('sk-cli-secret upstream-private-value', { status: 400 });
    await expect(provider(['create'], { file: await file({
      name: 'Example',
      privateHeaders: { Authorization: 'upstream-private-value' },
    }) })).rejects.toThrow('cli error');
    expect(calls).toHaveLength(1);
    expect(errSpy).toHaveBeenCalledWith('provider request failed', 'HTTP 400');
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain('upstream-private-value');
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain('sk-cli-secret');
  });

  it('does not expose malformed JSON fragments from existing provider commands', async () => {
    const path = join(dir, 'legacy-bad.json');
    await writeFile(path, '{"privateHeaders":{"Authorization":"upstream-private-value"}');
    await expect(provider(['create'], { file: path })).rejects.toThrow('cli error');
    expect(calls).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledWith('provider request failed', 'cli error');
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain('upstream-private-value');
  });

  it('reports scope requirements on 403 and fails immediately', async () => {
    respond = () => new Response('private error body', { status: 403 });
    await expect(provider(['submit', 'svc'], { revision: 'rev-1' })).rejects.toThrow('cli error');
    expect(errSpy.mock.calls[0][1]).toContain('service:publish');
    expect(calls).toHaveLength(1);
  });

  it('explains the backend immutable-revision conflict without echoing server input', async () => {
    respond = () => json({ code: 'REVISION_NOT_EDITABLE', message: 'private-secret', state: 'PUBLISHED' }, 409);
    await expect(provider(['update', 'svc'], { revision: 'rev-1', file: await file({ description: 'changed' }) })).rejects.toThrow('cli error');
    expect(errSpy.mock.calls[0][1]).toContain('Only DRAFT or SANDBOX');
    expect(errSpy.mock.calls[0][1]).not.toContain('private-secret');
    expect(calls).toHaveLength(1);
  });

  it('does not accept approval as publication, and waits through approved IN_REVIEW', async () => {
    respond = () => json(report(calls.length === 1 ? 'IN_REVIEW' : 'PUBLISHED', { status: 'APPROVED', outcome: 'passed' }));
    await provider(['wait', 'svc'], { revision: 'rev-1', interval: '1ms' });
    expect(calls).toHaveLength(2);
    expect(outputSpy.mock.calls[0][0]).toMatchObject({ success: true });
  });

  for (const [state, review, reason] of [
    ['SANDBOX', { status: 'AUTO_FAILED', outcome: 'rejected' }, 'rejected'],
    ['IN_REVIEW', { status: 'PENDING_HUMAN', outcome: 'pending_human' }, 'manual_review_required'],
    ['DRAFT', null, 'not_published'], ['SUSPENDED', null, 'not_published'],
  ] as const) {
    it(`returns nonzero for ${state}/${reason}`, async () => {
      respond = () => json(report(state, review));
      await provider(['wait', 'svc'], { revision: 'rev-1' });
      expect(process.exitCode).toBe(1);
      expect(outputSpy.mock.calls[0][0]).toMatchObject({ success: false, reason });
      expect(calls).toHaveLength(1);
    });
  }

  it('recovers from transient poll errors within the attempt cap', async () => {
    respond = () => calls.length === 1 ? new Response('busy', { status: 503 }) : json(report('PUBLISHED'));
    await provider(['wait', 'svc'], { revision: 'rev-1', interval: '1ms', 'max-attempts': '2' });
    expect(calls).toHaveLength(2);
    expect(process.exitCode).toBe(0);
  });

  it('caps transient errors and honors Retry-After without exceeding the deadline', async () => {
    respond = () => new Response('busy', { status: 429, headers: { 'Retry-After': '120' } });
    const start = Date.now();
    await provider(['wait', 'svc'], { revision: 'rev-1', interval: '1ms', timeout: '30ms' });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(calls).toHaveLength(1);
    expect(outputSpy.mock.calls[0][0]).toMatchObject({ reason: 'timeout', success: false });
    calls.length = 0;
    await provider(['wait', 'svc'], { revision: 'rev-1', 'max-attempts': '1' });
    expect(calls).toHaveLength(1);
    expect(outputSpy.mock.calls.at(-1)?.[0]).toMatchObject({ reason: 'max_attempts' });
  });

  it('aborts an in-flight poll at the overall timeout', async () => {
    respond = call => new Promise((_, reject) => call.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const start = Date.now();
    await provider(['wait', 'svc'], { revision: 'rev-1', timeout: '30ms' });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(calls).toHaveLength(1);
    expect(outputSpy.mock.calls[0][0]).toMatchObject({ reason: 'timeout' });
  });

  it('rejects empty, mismatched, and unknown-state review responses', async () => {
    for (const value of [null, { revision: { id: 'different', state: 'PUBLISHED' } }, report('NEW_STATE')]) {
      respond = () => value === null ? new Response(null, { status: 204 }) : json(value);
      await expect(provider(['wait', 'svc'], { revision: 'rev-1' })).rejects.toThrow('cli error');
    }
    expect(calls).toHaveLength(3);
  });

  it('validates command flags and IDs before HTTP requests', async () => {
    for (const [args, flags] of [
      [['wait', 'svc'], { revision: 'rev-1', timeout: '0s' }],
      [['wait', 'svc'], { revision: 'rev-1', interval: 'true' }],
      [['wait', 'svc'], { revision: 'rev-1', 'max-attempts': '0' }],
      [['submit', 'svc'], {}], [['wait', '..'], { revision: 'rev-1' }],
      [['submit', '   '], { revision: 'rev-1' }],
      [['submit', 'svc'], { revision: 'rev-1', changelog: 'x'.repeat(2001) }],
      [['import'], { file: 'true' }], [['update', 'svc'], { revision: 'rev-1', mode: 'typo' }],
    ] as [string[], Record<string, string>][]) await expect(provider(args, flags)).rejects.toThrow('cli error');
    expect(calls).toHaveLength(0);
  });

  it('refuses redirects and does not forward credentials', async () => {
    respond = () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } });
    await expect(providerRequest('services', 'key')).rejects.toThrow('refusing to follow redirect');
    expect(calls).toHaveLength(1);
  });

  it('redacts nested secret fields and known credential echoes', () => {
    const value = redactProvider({ versions: [{ privateHeaders: { 'X-Custom': 'value-secret' }, authConfig: 'cipher-secret' }],
      message: 'value-secret cipher-secret sk-cli-secret', headers: { Authorization: 'Bearer abc' } }, ['sk-cli-secret']);
    expect(JSON.stringify(value)).not.toContain('secret');
    expect(JSON.stringify(value)).not.toContain('Bearer abc');
  });

  it('preserves token/password/auth schema definitions and unrelated types', () => {
    const properties = { token: { type: 'string', description: 'Authentication token' }, password: { type: 'string' }, authConfig: { type: 'object' } };
    const definitions = {
      bodySchema: { type: 'object', properties },
      params: { token: { type: 'string' } },
      pathParams: { secret: { type: 'string' } },
      responses: [{ status: 200, schema: { type: 'object', properties } }],
      headers: { Authorization: { type: 'string', description: 'Caller authorization' } },
      openApiSpec: { openapi: '3.0.3', components: { schemas: { Credentials: { type: 'object', properties } } } },
      description: 'string object Authentication token',
    };
    expect(redactProvider(definitions)).toEqual(definitions);
  });

  it('still redacts real credentials and their echoes inside preserved schemas', () => {
    const value = redactProvider({
      privateHeaders: { 'X-Custom': 'actual-upstream-key' },
      headers: { Authorization: 'Bearer another-key' },
      bodySchema: { properties: { token: { type: 'string', example: 'actual-upstream-key' } } },
    });
    expect(value).toEqual({ privateHeaders: '[REDACTED]', headers: { Authorization: '[REDACTED]' },
      bodySchema: { properties: { token: { type: 'string', example: '[REDACTED]' } } } });
  });
});
