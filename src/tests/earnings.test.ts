import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as client from '../client.ts';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { earnings } from '../commands/earnings.ts';

describe('earnings command', () => {
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let getConfigSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => {
      throw new Error('err called');
    }) as any);
    getConfigSpy = spyOn(config, 'getConfig').mockReturnValue({
      actionHost: 'action.xapi.to',
      apiKey: 'sk-agent',
    });
  });

  afterEach(() => {
    outputSpy.mockRestore();
    errSpy.mockRestore();
    getConfigSpy.mockRestore();
  });

  it('queries economy directly with XAPI-KEY and no JWT login', async () => {
    const requestSpy = spyOn(client, 'request').mockResolvedValue({
      balances: { spendableUsd: '10.00000000' },
    });

    await earnings([], {});

    expect(requestSpy).toHaveBeenCalledWith(
      'https://api.xapi.to/api/agent/economy',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'XAPI-KEY': 'sk-agent' }),
      }),
      30_000,
      2,
    );
    requestSpy.mockRestore();
  });

  it('lists earnings with filters', async () => {
    const requestSpy = spyOn(client, 'request').mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    await earnings(['list'], {
      status: 'pending',
      limit: '5',
      cursor: 'earning-1',
    });

    const url = new URL(String(requestSpy.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/agent/earnings');
    expect(url.searchParams.get('status')).toBe('PENDING');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('cursor')).toBe('earning-1');
    requestSpy.mockRestore();
  });

  it('transfers with a stable idempotency key and retries safely', async () => {
    const requestSpy = spyOn(client, 'request').mockResolvedValue({
      transfer: { amountUsd: '1.00000000' },
    });

    await earnings(['transfer', '1'], {
      'idempotency-key': 'reinvest-1',
    });

    expect(requestSpy).toHaveBeenCalledWith(
      'https://api.xapi.to/api/agent/earnings/transfer',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ amount: 1, idempotencyKey: 'reinvest-1' }),
      }),
      30_000,
      2,
    );
    requestSpy.mockRestore();
  });

  it('refuses a transfer without an idempotency key', async () => {
    await expect(earnings(['transfer', '1'], {})).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith(
      'idempotency key required',
      expect.stringContaining('--idempotency-key'),
    );
  });
});
