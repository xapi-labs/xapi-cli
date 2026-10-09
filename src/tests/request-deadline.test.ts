import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { requestDeadline, REQUEST_TIMER_CHUNK_MS } from '../request-deadline.ts';
import { sandboxExtension } from '../sandbox-client.ts';

describe('request deadline timer', () => {
  let timerSpy: ReturnType<typeof spyOn> | undefined;
  let clearSpy: ReturnType<typeof spyOn> | undefined;
  let fetchSpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => { timerSpy?.mockRestore(); clearSpy?.mockRestore(); fetchSpy?.mockRestore(); });
  it('preserves a normal single timer and its cleanup', () => {
    let expired = false;
    const timer = { unref() {} } as any;
    timerSpy = spyOn(globalThis, 'setTimeout').mockReturnValue(timer);
    clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    const deadline = requestDeadline(() => { expired = true; }, 180_000);
    expect(timerSpy.mock.calls.length).toBe(1);
    expect(timerSpy.mock.calls[0]![1]).toBe(180_000);
    (timerSpy.mock.calls[0]![0] as () => void)();
    expect(expired).toBe(true);
    deadline.dispose();
    expect(clearSpy.mock.calls[0]![0]).toBe(timer);
  });
  it('chains a large deadline without overflowing or firing early and clears its current timer', () => {
    let calls = 0;
    const first = {} as any;
    const second = {} as any;
    timerSpy = spyOn(globalThis, 'setTimeout').mockReturnValueOnce(first).mockReturnValueOnce(second);
    clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    const deadline = requestDeadline(() => { calls++; }, REQUEST_TIMER_CHUNK_MS + 65_000);
    expect(timerSpy.mock.calls[0]![1]).toBe(REQUEST_TIMER_CHUNK_MS);
    (timerSpy.mock.calls[0]![0] as () => void)();
    expect(calls).toBe(0);
    expect(timerSpy.mock.calls[1]![1]).toBe(65_000);
    (timerSpy.mock.calls[1]![0] as () => void)();
    expect(calls).toBe(1);
    deadline.dispose();
    expect(clearSpy.mock.calls[0]![0]).toBe(second);
  });
  it('sends exactly one long extension POST with a safe active signal and disposes its timer', async () => {
    timerSpy = spyOn(globalThis, 'setTimeout');
    clearSpy = spyOn(globalThis, 'clearTimeout');
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(false);
      return Response.json({ result: { complete: true } });
    }) as any);
    const body = { input: { timeoutMs: REQUEST_TIMER_CHUNK_MS + 65_000, command: 'one-call', sessionId: 'session' }, idempotencyKey: 'same-key' };
    await sandboxExtension({ sandboxHost: 'sandbox.test.xapi.to', apiKey: 'test' }, 'box', 'cloudflare.session.exec', body);
    expect(fetchSpy.mock.calls.length).toBe(1);
    expect(fetchSpy.mock.calls[0]![1]?.body).toBe(JSON.stringify(body));
    expect(timerSpy.mock.calls.some((call: unknown[]) => call[1] === REQUEST_TIMER_CHUNK_MS)).toBe(true);
    expect(clearSpy.mock.calls.length).toBeGreaterThan(0);
  });
  it('retains the existing request timeout error without a write retry', async () => {
    let callback: () => void;
    timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      callback = fn;
      return {};
    }) as any);
    clearSpy = spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init?: RequestInit) => {
      callback();
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException('aborted', 'AbortError');
    }) as any);
    await expect(sandboxExtension({ sandboxHost: 'sandbox.test.xapi.to', apiKey: 'test' }, 'box', 'cloudflare.browser.automate', { input: {} })).rejects.toThrow('request timed out after 320000ms');
    expect(fetchSpy.mock.calls.length).toBe(1);
  });
});
