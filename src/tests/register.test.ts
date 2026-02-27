/**
 * Tests for register command
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { register } from '../commands/register.ts';

const mockRegisterResponse = {
  apiKey: 'sk-newkey123',
  claimCode: 'CODE123',
  claimSessionId: 'sess-abc',
  claimUrl: 'https://xapi.to/claim?code=CODE123',
  tweetTemplate: 'I just registered @xapi!',
  user: { id: 'user-1', accountType: 'ENTITY' },
};

describe('register command', () => {
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let saveConfigSpy: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
    saveConfigSpy = spyOn(config, 'saveConfig').mockImplementation(() => {});
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockRegisterResponse), { status: 200 }),
    );
  });

  afterEach(() => {
    outputSpy.mockRestore();
    errSpy.mockRestore();
    saveConfigSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('calls register endpoint and saves apiKey', async () => {
    await register([], {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/auth/register');
    expect(opts.method).toBe('POST');
    expect(saveConfigSpy).toHaveBeenCalledWith({ apiKey: 'sk-newkey123' });
  });

  it('outputs apiKey, user, claim, and note', async () => {
    await register([], {});
    expect(outputSpy).toHaveBeenCalledWith(
      {
        apiKey: 'sk-newkey123',
        user: mockRegisterResponse.user,
        claim: {
          code: 'CODE123',
          sessionId: 'sess-abc',
          url: 'https://xapi.to/claim?code=CODE123',
        },
        tweetTemplate: 'I just registered @xapi!',
        note: 'apiKey saved to ~/.xapi/config.json',
      },
      undefined,
    );
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
