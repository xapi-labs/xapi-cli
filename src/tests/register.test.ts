/**
 * Tests for register command
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { register } from '../commands/register.ts';

const mockRegisterResponse = {
  apiKey: 'sk-newkey123',
  referralCode: 'a3b8c2',
  bindUrl: 'https://xapi.to/bind?apikey=sk-newkey123',
  claimUrl: 'https://xapi.to/bind?apikey=sk-newkey123',
  user: { id: 'user-1', accountType: 'VIRTUAL' },
};

describe('register command', () => {
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let saveConfigSpy: ReturnType<typeof spyOn>;
  let getConfigSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;
  let sourceSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
    saveConfigSpy = spyOn(config, 'saveConfig').mockImplementation(() => {});
    getConfigSpy = spyOn(config, 'getConfig').mockReturnValue({ actionHost: 'action.xapi.to', apiKey: undefined });
    sourceSpy = spyOn(config, 'getApiKeySource').mockReturnValue('none');
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockRegisterResponse), { status: 200 }),
    );
  });

  afterEach(() => {
    outputSpy.mockRestore();
    errSpy.mockRestore();
    saveConfigSpy.mockRestore();
    getConfigSpy.mockRestore();
    fetchSpy.mockRestore();
    sourceSpy.mockRestore();
  });

  it('calls register endpoint and saves apiKey', async () => {
    await register([], {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/register');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{}');
    expect(saveConfigSpy).toHaveBeenCalledWith({ apiKey: 'sk-newkey123' });
  });

  it('outputs apiKey, user, referralCode, bind URLs, and note', async () => {
    await register([], {});
    expect(outputSpy).toHaveBeenCalledWith(
      {
        apiKey: 'sk-newkey123',
        user: mockRegisterResponse.user,
        referralCode: 'a3b8c2',
        bindUrl: 'https://xapi.to/bind?apikey=sk-newkey123',
        claimUrl: 'https://xapi.to/bind?apikey=sk-newkey123',
        note: 'apiKey saved to ~/.xapi/config.json',
      },
      undefined,
    );
  });

  it('falls back to the legacy claimUrl when bindUrl is absent', async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          ...mockRegisterResponse,
          bindUrl: undefined,
        }),
        { status: 200 },
      ),
    );

    await register([], {});

    expect(outputSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        bindUrl: mockRegisterResponse.claimUrl,
        claimUrl: mockRegisterResponse.claimUrl,
      }),
      undefined,
    );
  });

  it('forwards --referral-code in request body', async () => {
    await register([], { 'referral-code': 'a3b8c2' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(opts.body).toBe(JSON.stringify({ referralCode: 'a3b8c2' }));
  });

  it('accepts --referralCode camelCase alias', async () => {
    await register([], { referralCode: 'b4d2e0' });
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(opts.body).toBe(JSON.stringify({ referralCode: 'b4d2e0' }));
  });

  it('accepts referral code as positional argument', async () => {
    await register(['c1d2e3'], {});
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(opts.body).toBe(JSON.stringify({ referralCode: 'c1d2e3' }));
  });

  it('reports only that a referral code was submitted, not that it was accepted', async () => {
    await register([], { 'referral-code': 'a3b8c2' });
    const arg = outputSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.referralCodeProvided).toBe('a3b8c2');
    expect(arg.referredBy).toBeUndefined();
  });

  it('rejects a bare --referral-code before creating an account', async () => {
    await expect(register([], { 'referral-code': 'true' })).rejects.toThrow('err called');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saveConfigSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('--referral-code requires a code');
  });

  it('refuses to overwrite an existing apiKey without --force', async () => {
    getConfigSpy.mockReturnValue({ actionHost: 'action.xapi.to', apiKey: 'sk-existing' });

    await expect(register([], {})).rejects.toThrow('err called');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saveConfigSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      'register would overwrite existing apiKey',
      expect.stringContaining('--force'),
    );
  });

  it('overwrites an existing apiKey when --force is set', async () => {
    getConfigSpy.mockReturnValue({ actionHost: 'action.xapi.to', apiKey: 'sk-existing' });

    await register([], { force: 'true' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(saveConfigSpy).toHaveBeenCalledWith({ apiKey: 'sk-newkey123' });
    expect(outputSpy).toHaveBeenCalledWith(
      expect.objectContaining({ note: 'apiKey replaced in ~/.xapi/config.json' }),
      undefined,
    );
  });

  it('prints help without creating an account or writing config', async () => {
    const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await register([], { help: 'true' });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('xapi-to register'));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(saveConfigSpy).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('refuses registration before I/O when an environment key would shadow the result', async () => {
    sourceSpy.mockReturnValue('XAPI_KEY');
    getConfigSpy.mockReturnValue({ actionHost: 'action.xapi.to', apiKey: 'sk-env' });

    await expect(register([], { force: 'true' })).rejects.toThrow('err called');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saveConfigSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      'register cannot replace an API key supplied by an environment variable',
      expect.stringContaining('Unset XAPI_KEY'),
    );
  });

  it('does not save a malformed successful response', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ user: { id: 'user-1' } }), { status: 200 }));
    await expect(register([], {})).rejects.toThrow('err called');
    expect(saveConfigSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('register failed', expect.stringContaining('missing apiKey'));
  });

  it('calls err when server returns non-ok response', async () => {
    fetchSpy.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
    await expect(register([], {})).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('register failed', expect.stringContaining('401'));
  });

  it('calls err on network failure', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    await expect(register([], {})).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('register failed', 'network down');
  });
});
