/**
 * Tests for balance command
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as client from '../client.ts';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { balance } from '../commands/balance.ts';

describe('balance command', () => {
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let getConfigSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
    getConfigSpy = spyOn(config, 'getConfig').mockReturnValue({
      capabilityHost: 'c.xapi.to',
      apiKey: 'sk-test123',
    });
  });

  afterEach(() => {
    outputSpy.mockRestore();
    errSpy.mockRestore();
    getConfigSpy.mockRestore();
  });

  it('fetches balance and outputs result', async () => {
    const loginSpy = spyOn(client, 'loginWithApiKey').mockResolvedValue({
      accessToken: 'jwt-token',
      user: {},
    });
    const requestSpy = spyOn(client, 'request').mockResolvedValue({
      xTokenBalance: '999.5',
      accountType: 'ENTITY',
      tier: 'BASIC',
    });

    await balance([], {});

    expect(loginSpy).toHaveBeenCalledWith('sk-test123', 'api.xapi.to');
    expect(outputSpy).toHaveBeenCalledWith(
      { balance: '999.5', accountType: 'ENTITY', tier: 'BASIC' },
      undefined,
    );

    loginSpy.mockRestore();
    requestSpy.mockRestore();
  });

  it('calls err when apiKey is missing', async () => {
    getConfigSpy.mockReturnValue({ capabilityHost: 'c.xapi.to', apiKey: undefined });
    await expect(balance([], {})).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith(
      'API key not configured',
      'Run "xapi register" to create an account, or "xapi config set apiKey=<key>" to set an existing key.',
    );
  });

  it('calls err when login fails', async () => {
    const loginSpy = spyOn(client, 'loginWithApiKey').mockRejectedValue(new Error('unauthorized'));
    await expect(balance([], {})).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('login failed', 'unauthorized');
    loginSpy.mockRestore();
  });

  it('calls err when /auth/me request fails', async () => {
    const loginSpy = spyOn(client, 'loginWithApiKey').mockResolvedValue({ accessToken: 'jwt', user: {} });
    const requestSpy = spyOn(client, 'request').mockRejectedValue(new Error('server error'));
    await expect(balance([], {})).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('balance fetch failed', 'server error');
    loginSpy.mockRestore();
    requestSpy.mockRestore();
  });
});
