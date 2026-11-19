/**
 * Session reuse for JWT-only account routes (balance, oauth).
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as client from '../client.ts';
import * as config from '../config.ts';
import * as format from '../format.ts';
import { dropSession, sessionToken } from '../session.ts';
import { balance } from '../commands/balance.ts';

const jwt = (expSeconds: number) =>
  `h.${Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')}.s`;
const inOneHour = () => Math.floor(Date.now() / 1000) + 3600;

describe('session reuse', () => {
  let dir: string;
  let fileSpy: ReturnType<typeof spyOn>;
  let storedSpy: ReturnType<typeof spyOn>;
  let loginSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'xapi-session-'));
    fileSpy = spyOn(config, 'sessionFile').mockReturnValue(join(dir, 'session.json'));
    storedSpy = spyOn(config, 'isStoredApiKey').mockReturnValue(true);
    loginSpy = spyOn(client, 'loginWithApiKey').mockResolvedValue({ accessToken: jwt(inOneHour()), user: {} });
  });

  afterEach(() => {
    fileSpy.mockRestore();
    storedSpy.mockRestore();
    loginSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('logs in once and reuses the stored session until it nears expiry', async () => {
    const first = await sessionToken('sk-a', 'api.xapi.to');
    const second = await sessionToken('sk-a', 'api.xapi.to');
    expect(second).toBe(first);
    expect(loginSpy).toHaveBeenCalledTimes(1);
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'session.json')).mode & 0o777).toBe(0o600);
    }
    // The file never contains the API key itself.
    expect(readFileSync(join(dir, 'session.json'), 'utf8')).not.toContain('sk-a');
  });

  it('logs in again within a minute of expiry, for another key, or after a drop', async () => {
    loginSpy.mockResolvedValueOnce({ accessToken: jwt(Math.floor(Date.now() / 1000) + 30), user: {} });
    await sessionToken('sk-a', 'api.xapi.to');
    await sessionToken('sk-a', 'api.xapi.to');
    expect(loginSpy).toHaveBeenCalledTimes(2);

    await sessionToken('sk-b', 'api.xapi.to');
    expect(loginSpy).toHaveBeenCalledTimes(3);

    dropSession('sk-b', 'api.xapi.to');
    expect(existsSync(join(dir, 'session.json'))).toBe(false);
    await sessionToken('sk-b', 'api.xapi.to');
    expect(loginSpy).toHaveBeenCalledTimes(4);
  });

  it('never writes a session for a key from the environment', async () => {
    storedSpy.mockReturnValue(false);
    await sessionToken('sk-env', 'api.xapi.to');
    await sessionToken('sk-env', 'api.xapi.to');
    expect(loginSpy).toHaveBeenCalledTimes(2);
    expect(existsSync(join(dir, 'session.json'))).toBe(false);
  });

  it('balance retries once with a fresh login when the reused session is rejected', async () => {
    const configSpy = spyOn(config, 'getConfig').mockReturnValue({ actionHost: 'action.xapi.to', apiKey: 'sk-a' });
    const outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    await sessionToken('sk-a', 'api.xapi.to');
    const requestSpy = spyOn(client, 'request')
      .mockRejectedValueOnce(new client.HttpError(401, 'Unauthorized'))
      .mockResolvedValueOnce({ balance: '1.5', accountType: 'ENTITY', tier: 'BASIC' });
    try {
      await balance([], {});
      expect(loginSpy).toHaveBeenCalledTimes(2);
      expect(requestSpy).toHaveBeenCalledTimes(2);
      expect(outputSpy).toHaveBeenCalledWith({ balance: '1.5', accountType: 'ENTITY', tier: 'BASIC' }, undefined);
    } finally {
      configSpy.mockRestore();
      outputSpy.mockRestore();
      requestSpy.mockRestore();
    }
  });
});
