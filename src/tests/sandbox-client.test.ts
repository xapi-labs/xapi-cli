import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as client from '../sandbox-client.ts';

describe('sandbox client', () => {
  it('never replays a failed port allocation just because its public route uses GET', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('upstream pending', { status: 502 })) as unknown as typeof globalThis.fetch);
    try {
      await expect(client.sandboxPort({ sandboxHost: 'localhost:3312', apiKey: 'test' }, 'owned', 3000)).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { fetch.mockRestore(); }
  });
  it('covers cold startup without an arbitrary one hour ceiling', () => {
    expect(client.sandboxCommandTransportMs(60)).toBe(360_000);
    expect(client.sandboxCommandTransportMs(7200)).toBe(7_500_000);
    expect(client.sandboxCommandTransportMs(7200, true)).toBe(300_000);
    for (const seconds of [0, 1.5, Infinity, Number.MAX_SAFE_INTEGER])
      expect(() => client.sandboxCommandTransportMs(seconds)).toThrow();
  });

  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => fetchSpy?.mockRestore());

  it('builds auto and provider-pinned test gateway URLs', () => {
    expect(client.sandboxBaseUrl('sandbox.test.xapi.to')).toBe('https://sandbox.test.xapi.to');
    expect(client.sandboxBaseUrl('sandbox.test.xapi.to', 'cf-edge'))
      .toBe('https://cf-edge.sandbox.test.xapi.to');
    expect(client.sandboxBaseUrl('daytona.sandbox.test.xapi.to', 'e2b'))
      .toBe('https://e2b.sandbox.test.xapi.to');
  });

  it('uses the deployed production aliases for Daytona and E2B', () => {
    expect(client.sandboxBaseUrl('sandbox.xapi.to', 'daytona'))
      .toBe('https://daytona-sandbox.sandbox.xapi.to');
    expect(client.sandboxBaseUrl('sandbox.xapi.to', 'e2b'))
      .toBe('https://e2b-sandbox.sandbox.xapi.to');
    expect(client.sandboxBaseUrl('sandbox.xapi.to', 'cf-edge'))
      .toBe('https://cf-edge.sandbox.xapi.to');
  });

  it('pins a loopback provider using the provider-scoped path', async () => {
    expect(client.sandboxBaseUrl('http://127.0.0.1:3312', 'daytona')).toBe('http://127.0.0.1:3312/providers/daytona');
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]'));
    await client.sandboxOfferings({ sandboxHost: 'http://127.0.0.1:3312', provider: 'daytona', apiKey: 'local-key' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:3312/providers/daytona/v1/offerings');
    const headers = new Headers(init.headers);
    expect(headers.has('host')).toBe(false);
    expect(headers.get('xapi-key')).toBe('local-key');
  });

  it('keeps auto and public pinning free of local routing hints', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => new Response('[]')) as unknown as typeof fetch);
    for (const opts of [
      { sandboxHost: 'localhost:3312', provider: 'auto', apiKey: 'local-key' },
      { sandboxHost: 'sandbox.xapi.to', provider: 'daytona', apiKey: 'public-key' },
    ]) await client.sandboxOfferings(opts);
    for (const [, init] of fetchSpy.mock.calls as [string, RequestInit][]) expect(new Headers(init.headers).has('x-xapi-sandbox-provider')).toBe(false);
  });

  it('retains local provider scope for raw binary downloads', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([0, 255, 7])));
    const stream = await client.sandboxFileDownload({ sandboxHost: 'localhost:3312', provider: 'daytona', apiKey: 'key' }, 'box', '/tmp/file');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/providers/daytona/v1/sandboxes/box/files/download');
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(new Uint8Array([0, 255, 7]));
  });

  it('sends cwd and background using the public command contract', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      exitCode: 0,
      stdout: '',
      stderr: '',
      background: { sessionId: 'session-1', commandId: 'command-1' },
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })) as any;

    await client.sandboxExec(
      { sandboxHost: 'sandbox.test.xapi.to', provider: 'daytona', apiKey: 'sk-test' },
      'box-1',
      {
        command: 'python3 -m http.server 25319 --bind 0.0.0.0',
        cwd: '/home/daytona/project',
        background: true,
        timeoutSeconds: 60,
      },
    );

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://daytona.sandbox.test.xapi.to/v1/sandboxes/box-1/commands');
    expect(JSON.parse(String(init.body))).toEqual({
      command: 'python3 -m http.server 25319 --bind 0.0.0.0',
      cwd: '/home/daytona/project',
      background: true,
      timeoutSeconds: 60,
    });
  });

  it('rejects provider injection and non-xapi domains before fetch', () => {
    expect(() => client.sandboxBaseUrl('sandbox.test.xapi.to', 'cf-edge.evil'))
      .toThrow(/invalid sandbox provider/);
    expect(() => client.sandboxBaseUrl('sandbox.xapi.xyz')).toThrow(/only be sent to/);
    expect(() => client.sandboxBaseUrl('evil.example')).toThrow(/untrusted host/);
    expect(() => client.sandboxBaseUrl('http://sandbox.xapi.to')).toThrow(/must use HTTPS/);
    expect(() => client.sandboxBaseUrl('ftp://localhost')).toThrow(/must use HTTP or HTTPS/);
    expect(client.sandboxBaseUrl('http://127.0.0.1:3004')).toBe('http://127.0.0.1:3004');
  });

  it('requests explicit file encodings so binary downloads are lossless', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      path: 'artifact.bin', content: 'AP+A', encoding: 'base64',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any;

    await client.sandboxFileRead(
      { sandboxHost: 'sandbox.test.xapi.to', apiKey: 'sk-test' },
      'box/unsafe',
      'folder/artifact.bin',
      'base64',
    );

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://sandbox.test.xapi.to/v1/sandboxes/box%2Funsafe/files?path=folder%2Fartifact.bin&encoding=base64',
    );
  });

  it('sends the key only to the pinned xapi gateway and encodes audit params', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any;
    await client.sandboxAudit(
      { sandboxHost: 'sandbox.test.xapi.to', provider: 'cf-edge', apiKey: 'sk-test' },
      'box/unsafe',
      'billingPeriods',
      2,
      25,
    );
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      'https://cf-edge.sandbox.test.xapi.to/v1/sandboxes/box%2Funsafe/audit?kind=billingPeriods&page=2&pageSize=25',
    );
    expect((init.headers as Record<string, string>)['XAPI-Key']).toBe('sk-test');
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({items:[]}),{headers:{'content-type':'application/json'}}));
    await client.sandboxAudit({sandboxHost:'sandbox.test.xapi.to',apiKey:'sk-test'},'box','billingPeriods',1,100,'pending');
    expect(fetchSpy.mock.calls[1][0]).toContain('billingStatus=pending');
  });

  it('uses the dedicated history endpoint with encoded filters', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any;
    await client.sandboxHistory(
      { sandboxHost: 'sandbox.test.xapi.to', provider: 'cf-edge', apiKey: 'sk-test' },
      { state: 'HISTORY', search: 'agent run', page: 2, pageSize: 25 },
    );
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://cf-edge.sandbox.test.xapi.to/v1/sandbox-history?state=HISTORY&search=agent+run&page=2&pageSize=25',
    );
  });

  it('encodes extension ids and sends structured extension input', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ result: { ready: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as any;
    await client.sandboxExtension(
      { sandboxHost: 'sandbox.test.xapi.to', provider: 'runpod', apiKey: 'sk-test' },
      'box/unsafe',
      'runpod.connection_info',
      { input: {}, idempotencyKey: 'ext-1' },
    );
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://runpod.sandbox.test.xapi.to/v1/sandboxes/box%2Funsafe/extensions/runpod.connection_info');
    expect(JSON.parse(String(init.body))).toEqual({ input: {}, idempotencyKey: 'ext-1' });
  });

  it('polls until the requested observed state', async () => {
    let calls = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      calls++;
      const state = calls < 3 ? 'PROVISIONING' : 'RUNNING';
      return new Response(JSON.stringify({ id: 'box-1', observedState: state }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any);
    const detail = await client.sandboxWait(
      { sandboxHost: 'sandbox.test.xapi.to', apiKey: 'sk-test' },
      'box-1',
      ['RUNNING'],
      1_000,
      1,
    );
    expect(detail.observedState).toBe('RUNNING');
    expect(calls).toBe(3);
  });

  it('aborts an in-flight state read when the wait deadline expires', async () => {
    let calls = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((_url: any, init: any) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true },
        );
      });
    }) as any);
    await expect(client.sandboxWait(
      { sandboxHost: 'sandbox.test.xapi.to', apiKey: 'sk-test' },
      'box-1',
      ['RUNNING'],
      20,
      1,
    )).rejects.toThrow(/within 20ms/);
    expect(calls).toBe(1);
  });

  it('does not accept a desired state returned after the wait deadline', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(JSON.stringify({ id: 'box-1', observedState: 'RUNNING' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as any);
    await expect(client.sandboxWait(
      { sandboxHost: 'sandbox.test.xapi.to', apiKey: 'sk-test' },
      'box-1',
      ['RUNNING'],
      5,
      1,
    )).rejects.toThrow(/within 5ms/);
  });

  it('interrupts a state wait promptly so callers can clean up', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'box-1', observedState: 'PROVISIONING',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2);
    await expect(client.sandboxWait(
      { sandboxHost: 'sandbox.test.xapi.to', apiKey: 'sk-test' },
      'box-1',
      ['RUNNING'],
      10_000,
      5_000,
      controller.signal,
    )).rejects.toThrow(/interrupted/);
  });
});


describe('Sandbox financial error trace',()=>{
  it('preserves operation and billing identity when the native message is long, without echoing arbitrary fields',()=>{
    const raw=JSON.stringify({code:'SANDBOX_EXTENSION_PROVIDER_ERROR',message:'timeout '.repeat(200),operationId:'native-op',executionStatus:'FAILED',billingStatus:'SETTLED',token:'private-secret'});
    const detail=JSON.parse(client.sandboxErrorDetail(raw));
    expect(detail).toMatchObject({operationId:'native-op',executionStatus:'FAILED',billingStatus:'SETTLED'});
    expect(detail.message.length).toBeGreaterThan(300);
    expect(detail.token).toBeUndefined();
    expect(client.sandboxErrorDetail('plain '.repeat(100))).toHaveLength(300);
  });
});
