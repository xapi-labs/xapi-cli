/**
 * Tests for oauth commands
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as format from '../format.ts';
import * as config from '../config.ts';
import * as client from '../client.ts';
import { oauthBind, oauthStatus, oauthUnbind, oauthProviders } from '../commands/oauth.ts';

const MOCK_API_KEY = 'sk-abc123xyz456';
const MOCK_JWT = 'eyJhbGciOiJIUzI1NiJ9.mock.token';
const MOCK_KEY_ID = 'key-uuid-1234';

const mockKeys = [
  { id: MOCK_KEY_ID, name: 'default', keyPreview: 'sk-abc****456', oauthEnabled: false, createdAt: '2026-01-01' },
];

const mockProviders = [
  { id: 'prov-1', name: 'Twitter', type: 'twitter', grantType: 'authorization_code', defaultScopes: 'tweet.read users.read' },
];

const mockBindings = [
  {
    id: 'bind-uuid-1',
    apiKeyId: MOCK_KEY_ID,
    providerId: 'prov-1',
    providerAccountId: '12345',
    providerAccountName: 'testuser',
    scopes: 'tweet.read users.read',
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    provider: { id: 'prov-1', name: 'Twitter', type: 'twitter' },
  },
];

describe('oauth commands', () => {
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let getConfigSpy: ReturnType<typeof spyOn>;
  let loginSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
    getConfigSpy = spyOn(config, 'getConfig').mockReturnValue({
      capabilityHost: 'c.xapi.to',
      apiKey: MOCK_API_KEY,
    });
    loginSpy = spyOn(client, 'loginWithApiKey').mockResolvedValue({
      accessToken: MOCK_JWT,
      user: { id: 'user-1' },
    } as any);
  });

  afterEach(() => {
    outputSpy.mockRestore();
    errSpy.mockRestore();
    getConfigSpy.mockRestore();
    loginSpy.mockRestore();
  });

  // ── oauth bind ──────────────────────────────────────────────────────────────

  describe('oauthBind', () => {
    let listKeysSpy: ReturnType<typeof spyOn>;
    let enableOAuthSpy: ReturnType<typeof spyOn>;
    let listProvidersSpy: ReturnType<typeof spyOn>;
    let initiateOAuthSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      listKeysSpy = spyOn(client, 'listKeys').mockResolvedValue(mockKeys as any);
      enableOAuthSpy = spyOn(client, 'enableOAuthForKey').mockResolvedValue({ success: true, message: 'ok' });
      listProvidersSpy = spyOn(client, 'listOAuthProviders').mockResolvedValue(mockProviders as any);
      initiateOAuthSpy = spyOn(client, 'initiateOAuth').mockResolvedValue({
        authorizationUrl: 'https://twitter.com/oauth/authorize?state=abc',
        state: 'abc',
      });
    });

    afterEach(() => {
      listKeysSpy.mockRestore();
      enableOAuthSpy.mockRestore();
      listProvidersSpy.mockRestore();
      initiateOAuthSpy.mockRestore();
    });

    it('full bind flow: login → listKeys → enableOAuth → listProviders → initiate', async () => {
      await oauthBind([], {});

      expect(loginSpy).toHaveBeenCalledWith(MOCK_API_KEY, expect.any(String));
      expect(listKeysSpy).toHaveBeenCalledWith(MOCK_JWT, expect.any(String));
      expect(enableOAuthSpy).toHaveBeenCalledWith(MOCK_KEY_ID, MOCK_API_KEY, MOCK_JWT, expect.any(String));
      expect(listProvidersSpy).toHaveBeenCalled();
      expect(initiateOAuthSpy).toHaveBeenCalledWith(MOCK_KEY_ID, 'prov-1', MOCK_JWT, expect.any(String));
    });

    it('skips enableOAuth if already enabled', async () => {
      listKeysSpy.mockResolvedValue([
        { ...mockKeys[0], oauthEnabled: true },
      ] as any);

      await oauthBind([], {});

      expect(enableOAuthSpy).not.toHaveBeenCalled();
    });

    it('uses --provider flag to select provider', async () => {
      await oauthBind([], { provider: 'twitter' });
      expect(initiateOAuthSpy).toHaveBeenCalledWith(MOCK_KEY_ID, 'prov-1', MOCK_JWT, expect.any(String));
    });

    it('calls err when provider not found', async () => {
      await expect(oauthBind([], { provider: 'github' })).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('oauth bind failed', expect.stringContaining('github'));
    });

    it('outputs authorizationUrl and instructions', async () => {
      await oauthBind([], {});
      expect(outputSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          authorizationUrl: 'https://twitter.com/oauth/authorize?state=abc',
        }),
        undefined,
      );
    });

    it('calls err when no API key configured', async () => {
      getConfigSpy.mockReturnValue({ capabilityHost: 'c.xapi.to', apiKey: undefined });
      await expect(oauthBind([], {})).rejects.toThrow();
    });

    it('calls err when login fails', async () => {
      loginSpy.mockRejectedValue(new Error('Invalid API key'));
      await expect(oauthBind([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('oauth bind failed', 'Invalid API key');
    });
  });

  // ── oauth status ────────────────────────────────────────────────────────────

  describe('oauthStatus', () => {
    let listBindingsSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      listBindingsSpy = spyOn(client, 'listOAuthBindings').mockResolvedValue(mockBindings as any);
    });

    afterEach(() => {
      listBindingsSpy.mockRestore();
    });

    it('lists bindings with provider and account info', async () => {
      await oauthStatus([], {});

      expect(loginSpy).toHaveBeenCalledWith(MOCK_API_KEY, expect.any(String));
      expect(listBindingsSpy).toHaveBeenCalledWith(MOCK_JWT, expect.any(String));
      expect(outputSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ok',
          count: 1,
          bindings: expect.arrayContaining([
            expect.objectContaining({
              id: 'bind-uuid-1',
              provider: 'Twitter',
              account: 'testuser',
            }),
          ]),
        }),
        undefined,
      );
    });

    it('shows no_bindings message when empty', async () => {
      listBindingsSpy.mockResolvedValue([] as any);
      await oauthStatus([], {});
      expect(outputSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'no_bindings' }),
        undefined,
      );
    });

    it('calls err on network failure', async () => {
      listBindingsSpy.mockRejectedValue(new Error('network error'));
      await expect(oauthStatus([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('oauth status failed', 'network error');
    });
  });

  // ── oauth unbind ────────────────────────────────────────────────────────────

  describe('oauthUnbind', () => {
    let deleteBindingSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      deleteBindingSpy = spyOn(client, 'deleteOAuthBinding').mockResolvedValue({ success: true });
    });

    afterEach(() => {
      deleteBindingSpy.mockRestore();
    });

    it('deletes a binding by ID', async () => {
      await oauthUnbind(['bind-uuid-1'], {});

      expect(loginSpy).toHaveBeenCalledWith(MOCK_API_KEY, expect.any(String));
      expect(deleteBindingSpy).toHaveBeenCalledWith('bind-uuid-1', MOCK_JWT, expect.any(String));
      expect(outputSpy).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
        undefined,
      );
    });

    it('calls err when no binding ID given', async () => {
      await expect(oauthUnbind([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith(
        'usage: xapi oauth unbind <binding-id>',
        expect.any(String),
      );
    });

    it('calls err on delete failure', async () => {
      deleteBindingSpy.mockRejectedValue(new Error('binding not found'));
      await expect(oauthUnbind(['bind-uuid-1'], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('oauth unbind failed', 'binding not found');
    });
  });

  // ── oauth providers ─────────────────────────────────────────────────────────

  describe('oauthProviders', () => {
    let listProvidersSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      listProvidersSpy = spyOn(client, 'listOAuthProviders').mockResolvedValue(mockProviders as any);
    });

    afterEach(() => {
      listProvidersSpy.mockRestore();
    });

    it('lists available providers', async () => {
      await oauthProviders([], {});
      expect(listProvidersSpy).toHaveBeenCalled();
      expect(outputSpy).toHaveBeenCalledWith(mockProviders, undefined);
    });

    it('calls err on failure', async () => {
      listProvidersSpy.mockRejectedValue(new Error('service unavailable'));
      await expect(oauthProviders([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('oauth providers failed', 'service unavailable');
    });
  });

  // ── client.ts OAuth error detection ─────────────────────────────────────────

  describe('client request() OAuth error detection', () => {
    it('throws with oauth hint when API returns OAuth Required 403', async () => {
      const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            data: {
              statusCode: 403,
              error: 'OAuth Required',
              message: 'This endpoint requires Twitter OAuth authorization.',
            },
            error: { code: 'HTTP_403', message: 'This endpoint requires Twitter OAuth authorization.' },
          }),
          { status: 200 },
        ),
      );

      const { apiCall } = await import('../client.ts');
      await expect(
        apiCall('some-api-id', {}, { capabilityHost: 'c.xapi.to', apiKey: 'sk-test' }),
      ).rejects.toThrow('Run "xapi oauth bind"');

      fetchSpy.mockRestore();
    });
  });
});
