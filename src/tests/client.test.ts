/**
 * Tests for the low-level HTTP client: host allowlist enforcement and
 * exponential-backoff retry on transient failures.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { request, actionCall, deleteOAuthBinding, listOAuthProviders } from '../client.ts';

const OK = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

/** Install a fetch mock, casting past bun's `typeof fetch` (which requires a `preconnect` prop). */
function mockFetch(impl: () => Response | Promise<Response>) {
  return spyOn(globalThis, 'fetch').mockImplementation(impl as any);
}

describe('client.request', () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let prevRetryBase: string | undefined;

  beforeEach(() => {
    prevRetryBase = process.env.XAPI_RETRY_BASE_MS;
    process.env.XAPI_RETRY_BASE_MS = '1'; // keep backoff instant in tests
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    if (prevRetryBase === undefined) delete process.env.XAPI_RETRY_BASE_MS;
    else process.env.XAPI_RETRY_BASE_MS = prevRetryBase;
  });

  describe('host allowlist', () => {
    it('refuses to contact a non-allowlisted host and never calls fetch', async () => {
      fetchSpy = mockFetch(OK);
      await expect(request('https://evil.com/steal', { method: 'GET' })).rejects.toThrow(/untrusted host/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('allows an xapi.to host', async () => {
      fetchSpy = mockFetch(OK);
      const res = await request<{ ok: boolean }>('https://action.xapi.to/health', { method: 'GET' });
      expect(res).toEqual({ ok: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry', () => {
    it('does NOT retry by default (fail-safe for non-idempotent writes)', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return new Response('busy', { status: 503 });
      });
      await expect(request('https://action.xapi.to/x', { method: 'GET' })).rejects.toThrow('HTTP 503');
      expect(calls).toBe(1);
    });

    it('retries a 503 then succeeds when retries are opted in', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return calls === 1 ? new Response('busy', { status: 503 }) : OK();
      });
      const res = await request<{ ok: boolean }>('https://action.xapi.to/x', { method: 'GET' }, 5_000, 2);
      expect(res).toEqual({ ok: true });
      expect(calls).toBe(2);
    });

    it('retries a transient network error then succeeds', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        if (calls === 1) throw new TypeError('fetch failed');
        return OK();
      });
      const res = await request<{ ok: boolean }>('https://action.xapi.to/x', { method: 'GET' }, 5_000, 2);
      expect(res).toEqual({ ok: true });
      expect(calls).toBe(2);
    });

    it('does NOT retry a 400 even when retries are enabled (client error)', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return new Response('bad request', { status: 400 });
      });
      await expect(request('https://action.xapi.to/x', { method: 'GET' }, 5_000, 2)).rejects.toThrow('HTTP 400');
      expect(calls).toBe(1);
    });

    it('does NOT mistake an HTTP error body containing network words for a network failure', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return new Response('invalid network parameter', { status: 400 });
      });
      await expect(request('https://action.xapi.to/x', { method: 'GET' }, 5_000, 2)).rejects.toThrow('HTTP 400');
      expect(calls).toBe(1);
    });

    it('does NOT retry a 500 even when retries are enabled (possible non-idempotent side effect)', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return new Response('boom', { status: 500 });
      });
      await expect(request('https://action.xapi.to/x', { method: 'GET' }, 5_000, 2)).rejects.toThrow('HTTP 500');
      expect(calls).toBe(1);
    });

    it('gives up after exhausting retries on repeated 503s (3 attempts total)', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return new Response('busy', { status: 503 });
      });
      await expect(request('https://action.xapi.to/x', { method: 'GET' }, 5_000, 2)).rejects.toThrow('HTTP 503');
      expect(calls).toBe(3);
    });
  });

  describe('redirects', () => {
    it('refuses to follow a redirect and does not retry (never leaks the key)', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location: 'https://evil.com/' } });
      });
      await expect(request('https://action.xapi.to/x', { method: 'GET' })).rejects.toThrow(/refusing to follow redirect/);
      expect(calls).toBe(1);
    });
  });

  describe('actionCall retry policy', () => {
    it('does NOT auto-retry the execute endpoint by default (writes may be non-idempotent)', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return new Response('busy', { status: 503 });
      });
      await expect(
        actionCall('x-official.2_tweets', { body: { text: 'hi' } }, { actionHost: 'action.xapi.to', apiKey: 'sk' }, 'POST'),
      ).rejects.toThrow('HTTP 503');
      expect(calls).toBe(1);
    });

    it('retries when a caller opts in (e.g. idempotent task.poll)', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return calls === 1 ? new Response('busy', { status: 503 }) : OK();
      });
      const res = await actionCall('task.poll', { task_id: 't' }, { actionHost: 'action.xapi.to', apiKey: 'sk' }, undefined, 2);
      expect(res).toEqual({ ok: true });
      expect(calls).toBe(2);
    });

    it('bounds the in-flight request by an explicit timeoutMs (aborts a slow request)', async () => {
      // fetch honors the abort signal; the 15ms timeout must fire before the 500ms response.
      fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(((_url: any, opts: any) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(OK()), 500);
          opts?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
        })) as any);
      await expect(
        actionCall('task.poll', {}, { actionHost: 'action.xapi.to', apiKey: 'sk' }, undefined, 0, 15),
      ).rejects.toThrow(/timed out/);
    });
  });

  describe('per-endpoint retry policy', () => {
    it('deleteOAuthBinding (DELETE) does NOT retry — avoids a spurious 404 after a lost success', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return new Response('gateway', { status: 503 });
      });
      await expect(deleteOAuthBinding('bind-1', 'jwt', 'api.xapi.to')).rejects.toThrow('HTTP 503');
      expect(calls).toBe(1);
    });

    it('listOAuthProviders (GET) retries transient failures (idempotent read)', async () => {
      let calls = 0;
      fetchSpy = mockFetch(async () => {
        calls++;
        return calls === 1
          ? new Response('busy', { status: 503 })
          : new Response(JSON.stringify([{ id: 'p1' }]), { status: 200, headers: { 'content-type': 'application/json' } });
      });
      const res = await listOAuthProviders('api.xapi.to');
      expect(res).toEqual([{ id: 'p1' }] as any);
      expect(calls).toBe(2);
    });
  });
});
