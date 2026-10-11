import { expect, test } from 'bun:test';
import { request, RequestTimeoutError } from '../client.ts';

test('an injected fetch that never consumes its upload times out without draining or awaiting producer cleanup', async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(65_536)); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  let calls = 0;
  const fetcher = (async (_url, init) => {
    calls++;
    expect('dispatcher' in init!).toBe(false);
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  await expect(request('http://localhost/upload', { method: 'POST', body }, 80, 0, 'idle', fetcher))
    .rejects.toBeInstanceOf(RequestTimeoutError);
  expect(pulls).toBe(0);
  expect(cancelled).toBe(true);
  expect(calls).toBe(1);
});

test('empty upload chunks do not keep an injected fetch alive', async () => {
  let interval: ReturnType<typeof setInterval>;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { interval = setInterval(() => controller.enqueue(new Uint8Array()), 10); },
    cancel() { cancelled = true; clearInterval(interval); },
  });
  const fetcher = (async (_url, init) => {
    const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
    while (!(await reader.read()).done) { /* consume body */ }
    return Response.json({ ok: true });
  }) as typeof fetch;
  try {
    await expect(request('http://localhost/upload', { method: 'POST', body }, 80, 0, 'idle', fetcher))
      .rejects.toBeInstanceOf(RequestTimeoutError);
    expect(cancelled).toBe(true);
  } finally { clearInterval(interval!); }
});

test('caller cancellation stops a pending foreign upload pull and preserves the fetch error', async () => {
  let cancelled = false;
  let calls = 0;
  const abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled = true; },
  });
  const fetcher = (async (_url, init) => {
    calls++;
    const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    return Response.json({ ok: true });
  }) as typeof fetch;
  const result = request('http://localhost/upload', { method: 'POST', body, signal: abort.signal }, 1000, 0, 'idle', fetcher);
  abort.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelled).toBe(true);
  expect(calls).toBe(1);
});
