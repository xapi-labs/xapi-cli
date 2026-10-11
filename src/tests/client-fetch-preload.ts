// Executed by Node --import before the HTTP client module is evaluated.
const originalFetch = globalThis.fetch;
(globalThis as any).__preloadOriginalFetch = originalFetch;
const calls: Array<{ url: string; method?: string }> = [];
(globalThis as any).__preloadFetchCalls = calls;
function intercept(input: RequestInfo | URL, init?: RequestInit) {
  calls.push({ url: String(input), method: init?.method });
  if (init?.redirect !== 'manual' || !init.signal || 'dispatcher' in init)
    throw new Error('preload received incompatible options or lost security/deadline options');
  if (process.env.XAPI_TEST_PRELOAD_DELEGATE === '1') return originalFetch(input, init);
  if (init.headers && new Headers(init.headers).get('Accept') === 'text/event-stream')
    return Promise.resolve(new Response('data: preload\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  return Promise.resolve(new Response('{"source":"preload"}'));
}
// A copied .toString must not make a wrapper look like Node's built-in fetch.
Object.defineProperty(intercept, 'toString', { value: () => String(originalFetch) });
globalThis.fetch = process.env.XAPI_TEST_PRELOAD_PROXY === '1'
  ? new Proxy(originalFetch, { apply: (_target, _thisArg, args) => intercept(args[0], args[1]) })
  : intercept as typeof fetch;
