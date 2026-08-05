/**
 * Tests for topup command
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { topup } from '../commands/topup.ts';

describe('topup command', () => {
  let outputSpy: ReturnType<typeof spyOn>;
  let getConfigSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
    getConfigSpy = spyOn(config, 'getConfig').mockReturnValue({
      actionHost: 'action.xapi.to',
      apiKey: 'sk-test123',
    });
  });

  afterEach(() => {
    outputSpy.mockRestore();
    errSpy.mockRestore();
    getConfigSpy.mockRestore();
  });

  it('generates base URL with apiKey', async () => {
    await topup([], {});
    const call = outputSpy.mock.calls[0][0] as { url: string };
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe('https://www.xapi.to/topup/payment');
    expect(url.searchParams.get('apikey')).toBe('sk-test123');
  });

  it('includes method param when provided', async () => {
    await topup([], { method: 'stripe' });
    const call = outputSpy.mock.calls[0][0] as { url: string };
    const url = new URL(call.url);
    expect(url.searchParams.get('method')).toBe('stripe');
  });

  it('includes amount param when provided via flag', async () => {
    await topup([], { amount: '10' });
    const call = outputSpy.mock.calls[0][0] as { url: string };
    const url = new URL(call.url);
    expect(url.searchParams.get('amount')).toBe('10');
  });

  it('includes amount param when provided as positional arg', async () => {
    await topup(['20'], {});
    const call = outputSpy.mock.calls[0][0] as { url: string };
    const url = new URL(call.url);
    expect(url.searchParams.get('amount')).toBe('20');
  });

  it('rejects an invalid amount instead of silently ignoring it', async () => {
    await expect(topup([], { amount: 'abc' })).rejects.toThrow('err called');
    expect(outputSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('invalid top-up amount', expect.any(String));
  });

  it('rejects a zero or negative amount', async () => {
    await expect(topup([], { amount: '0' })).rejects.toThrow('err called');
    expect(outputSpy).not.toHaveBeenCalled();
  });

  it('rejects an unknown payment method', async () => {
    await expect(topup([], { method: 'wire' })).rejects.toThrow('err called');
    expect(outputSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('invalid --method value', expect.any(String));
  });

  it('omits apikey when no apiKey in config', async () => {
    getConfigSpy.mockReturnValue({ actionHost: 'action.xapi.to', apiKey: undefined });
    await topup([], {});
    const call = outputSpy.mock.calls[0][0] as { url: string };
    const url = new URL(call.url);
    expect(url.searchParams.has('apikey')).toBe(false);
  });

  it('combines all params', async () => {
    await topup([], { method: 'x402', amount: '50' });
    const call = outputSpy.mock.calls[0][0] as { url: string };
    const url = new URL(call.url);
    expect(url.searchParams.get('apikey')).toBe('sk-test123');
    expect(url.searchParams.get('method')).toBe('x402');
    expect(url.searchParams.get('amount')).toBe('50');
  });
});
