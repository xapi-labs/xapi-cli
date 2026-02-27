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

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    getConfigSpy = spyOn(config, 'getConfig').mockReturnValue({
      capabilityHost: 'c.xapi.to',
      proxyHost: 'p.xapi.to',
      apiKey: 'sk-test123',
    });
  });

  afterEach(() => {
    outputSpy.mockRestore();
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

  it('omits amount when value is invalid', async () => {
    await topup([], { amount: 'abc' });
    const call = outputSpy.mock.calls[0][0] as { url: string };
    const url = new URL(call.url);
    expect(url.searchParams.has('amount')).toBe(false);
  });

  it('omits amount when value is zero or negative', async () => {
    await topup([], { amount: '0' });
    const call = outputSpy.mock.calls[0][0] as { url: string };
    const url = new URL(call.url);
    expect(url.searchParams.has('amount')).toBe(false);
  });

  it('omits apikey when no apiKey in config', async () => {
    getConfigSpy.mockReturnValue({ capabilityHost: 'c.xapi.to', proxyHost: 'p.xapi.to', apiKey: undefined });
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
