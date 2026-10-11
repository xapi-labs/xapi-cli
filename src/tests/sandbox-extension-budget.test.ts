import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { cloudflareExtensionExecutionMs, sandboxExtensionTimeoutMs } from '../sandbox-extension-budget.ts';
import { sandboxExtension } from '../sandbox-client.ts';
import fixtures from './sandbox-extension-budget.fixtures.json';

describe('Cloudflare extension budget parity', () => {
  for (const fixture of fixtures) {
    it(`matches Adapter/Gateway execution fixture: ${fixture.name}`, () => {
      expect(cloudflareExtensionExecutionMs(fixture.extensionId, fixture.input, fixture.upstreamMs)).toBe(fixture.executionMs ?? undefined);
      // CLI uses default Gateway wake/upstream configuration, not local overrides.
      const coverage = cloudflareExtensionExecutionMs(fixture.extensionId, fixture.input);
      expect(sandboxExtensionTimeoutMs(fixture.extensionId, fixture.input))
        .toBe(coverage === undefined ? 180_000 : Math.max(180_000, coverage + 230_000));
    });
  }
  it('preserves the native per-action default and sums explicit wait milliseconds', () => {
    expect(sandboxExtensionTimeoutMs('cloudflare.browser.automate', {})).toBe(320_000);
    expect(sandboxExtensionTimeoutMs('cloudflare.browser.automate', {
      timeoutMs: 90_000, actions: [{ type: 'wait', milliseconds: 65_000 }, { type: 'click' }], extract: [{}],
    })).toBe(835_000);
  });
  it('covers explicit Vercel native wait and retains defaults for ordinary get',()=>{
    expect(sandboxExtensionTimeoutMs('vercel.command.get',{wait:true})).toBe(180000);
    expect(sandboxExtensionTimeoutMs('vercel.command.get',{wait:true,timeoutMs:1200000})).toBe(1300000);
    expect(sandboxExtensionTimeoutMs('vercel.command.get',{timeoutMs:1200000})).toBe(180000);
    expect(sandboxExtensionTimeoutMs('vercel.command.kill',{wait:true,timeoutMs:1200000})).toBe(180000);
    expect(()=>sandboxExtensionTimeoutMs('vercel.command.get',{wait:true,timeoutMs:0})).toThrow('positive');
  });
  it('keeps every other provider and untimed extension at its existing 180s timeout', () => {
    for (const extensionId of ['daytona.code.run', 'e2b.code.run', 'cloudflare.future.unknown', 'cloudflare.process.start'])
      expect(sandboxExtensionTimeoutMs(extensionId, { timeoutMs: 1_200_000 })).toBe(180_000);
  });
  it('does not clamp unsafe milliseconds or arithmetic overflow', () => {
    expect(() => sandboxExtensionTimeoutMs('cloudflare.browser.automate', { timeoutMs: Number.MAX_SAFE_INTEGER })).toThrow('safe integer');
    expect(() => sandboxExtensionTimeoutMs('cloudflare.session.exec', { timeoutMs: Number.MAX_SAFE_INTEGER })).toThrow('safe integer');
  });
});

describe('Sandbox extension single-POST contract', () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  let timerSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { fetchSpy?.mockRestore(); timerSpy?.mockRestore(); });
  const opts = { sandboxHost: 'sandbox.test.xapi.to', apiKey: 'test', provider: 'cf-edge' };
  it('preserves exact body/idempotency key while using cumulative CF transport coverage', async () => {
    const body = { input: { timeoutMs: 90_000, actions: [{ type: 'wait', milliseconds: 65_000 }, { type: 'click', selector: '#go' }], extract: [{}] }, idempotencyKey: 'stable-key' };
    timerSpy = spyOn(globalThis, 'setTimeout');
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ result: { complete: true } })) as any;
    expect(await sandboxExtension(opts, 'box/unsafe', 'cloudflare.browser.automate', body)).toEqual({ result: { complete: true } });
    expect(fetchSpy!.mock.calls.length).toBe(1);
    const [url, init] = fetchSpy!.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://cf-edge.sandbox.test.xapi.to/v1/sandboxes/box%2Funsafe/extensions/cloudflare.browser.automate');
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify(body));
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(timerSpy.mock.calls.some((call: unknown[]) => call[1] === 835_000)).toBe(true);
  });
  it('keeps native errors and never retries a failed paid browser call', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('native Browser Run timeout', { status: 422 })) as any;
    await expect(sandboxExtension(opts, 'box', 'cloudflare.browser.automate', { input: { timeoutMs: 90_000 }, idempotencyKey: 'one-call' })).rejects.toThrow('native Browser Run timeout');
    expect(fetchSpy!.mock.calls.length).toBe(1);
  });
  it('does not replay a lost response even when the transport budget is long', async () => {
    const native = new TypeError('fetch failed');
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(native) as any;
    await expect(sandboxExtension(opts, 'box', 'cloudflare.code.run', { input: { code: 'write-once', timeoutMs: 1_200_000 }, idempotencyKey: 'one-call' })).rejects.toBe(native);
    expect(fetchSpy!.mock.calls.length).toBe(1);
  });
  it('rejects unrepresentable budgets before sending any paid operation', () => {
    fetchSpy = spyOn(globalThis, 'fetch') as any;
    expect(() => sandboxExtension(opts, 'box', 'cloudflare.browser.automate', { input: { timeoutMs: Number.MAX_SAFE_INTEGER } })).toThrow('safe integer');
    expect(fetchSpy!.mock.calls.length).toBe(0);
  });
});
