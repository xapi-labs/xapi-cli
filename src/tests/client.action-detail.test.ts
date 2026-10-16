import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { actionCall, actionGet, HttpError } from '../client.ts';

describe('action detail lookup', () => {
  let restoreFetch: (() => void) | undefined;
  afterEach(() => restoreFetch?.());

  it.each(['categories', 'search', 'services', 'batch', 'execute', 'solana', 'solana.root'])(
    'looks up %s through batch without hitting a collection route',
    async (id) => {
      const actions = [{ id, method: 'GET' }, { id, method: 'POST' }];
      const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({ actions, missing_ids: [] }),
      );
      restoreFetch = () => fetchSpy.mockRestore();
      expect(await actionGet(id, { actionHost: 'action.xapi.to', apiKey: 'test-key' })).toEqual(actions);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, options] = fetchSpy.mock.calls[0]!;
      expect(String(url)).toBe('https://action.xapi.to/v1/actions/batch');
      expect(options?.method).toBe('POST');
      expect(JSON.parse(String(options?.body))).toEqual({ ids: [id] });
      expect(new Headers(options?.headers).get('XAPI-Key')).toBe('test-key');
    },
  );

  it('preserves an exact UUID even when the returned human ID differs', async () => {
    const uuid = 'c8363ff2-8bfb-4ce0-a64a-3b7e8e56706a';
    const actions = [{ id: 'solana.root', uuid, method: 'POST', endpoint: { path: '/root' } }];
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ actions, missing_ids: [] }),
    );
    restoreFetch = () => fetchSpy.mockRestore();
    expect(await actionGet(uuid, { actionHost: 'action.xapi.to' })).toEqual(actions);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body))).toEqual({ ids: [uuid] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves root methods and distinct schemas', async () => {
    const actions = [
      { id: 'solana', method: 'GET', input: { type: 'object', properties: { query: {} } } },
      { id: 'solana', method: 'POST', input: { type: 'object', properties: { body: {} } } },
    ];
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ actions, missing_ids: [] }),
    );
    restoreFetch = () => fetchSpy.mockRestore();
    expect(await actionGet('solana', { actionHost: 'action.xapi.to' })).toEqual(actions);
  });

  it('forwards the discovered UUID and selected method unchanged to execute', async () => {
    const uuid = 'c8363ff2-8bfb-4ce0-a64a-3b7e8e56706a';
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }));
    restoreFetch = () => fetchSpy.mockRestore();
    await actionCall(uuid, { body: { value: 1 } }, { actionHost: 'action.xapi.to' }, 'POST');
    const [url, options] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://action.xapi.to/v1/actions/execute');
    expect(JSON.parse(String(options?.body))).toEqual({
      action_id: uuid, method: 'POST', input: { body: { value: 1 } },
    });
  });

  it('preserves not-found semantics for a missing ID', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ actions: [], missing_ids: ['missing'] }),
    );
    restoreFetch = () => fetchSpy.mockRestore();
    const error = await actionGet('missing', { actionHost: 'action.xapi.to' }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
  });

  it('does not replace a stale UUID with a root alias', async () => {
    const uuid = 'c8363ff2-8bfb-4ce0-a64a-3b7e8e56706a';
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ actions: [], missing_ids: [uuid] }),
    );
    restoreFetch = () => fetchSpy.mockRestore();
    await expect(actionGet(uuid, { actionHost: 'action.xapi.to' })).rejects.toThrow('HTTP 404');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('preserves not-found semantics for an empty success response', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ actions: [], missing_ids: [] }),
    );
    restoreFetch = () => fetchSpy.mockRestore();
    await expect(actionGet('missing', { actionHost: 'action.xapi.to' })).rejects.toThrow('HTTP 404');
  });

  it.each([401, 403, 404])('propagates HTTP %s without trying a legacy route', async (status) => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({ message: 'Access denied or unavailable' }, { status }),
    );
    restoreFetch = () => fetchSpy.mockRestore();
    const error = await actionGet('categories', { actionHost: 'action.xapi.to' }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(status);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    { success: false, error: { code: 'FORBIDDEN' } },
    { data: { actions: [], missing_ids: [] } },
    { actions: [], missing_ids: 'missing' },
    { actions: [], missing_ids: [null] },
    { actions: null, missing_ids: [] },
    { actions: [null], missing_ids: [] },
  ])('rejects an invalid success envelope: %j', async (payload) => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(payload));
    restoreFetch = () => fetchSpy.mockRestore();
    await expect(actionGet('solana', { actionHost: 'action.xapi.to' })).rejects.toThrow('Invalid Action batch response');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
