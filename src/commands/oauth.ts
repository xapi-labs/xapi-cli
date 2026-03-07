/**
 * oauth commands: bind, status, unbind
 *
 * Flow for `xapi oauth bind [--provider twitter]`:
 *  1. Login with current API key → get JWT
 *  2. List API keys → find the one matching the current key by prefix
 *  3. Enable OAuth on the key if not already (POST /keys/:id/enable-oauth)
 *  4. List OAuth providers → find the requested provider
 *  5. POST /oauth/authorize → get authorizationUrl
 *  6. Open browser (macOS/Linux/Windows) and poll for binding completion
 *
 * `xapi oauth status`: list current OAuth bindings for the API key
 * `xapi oauth unbind <binding-id>`: delete an OAuth binding
 */

import { spawnSync } from 'child_process';
import { XAPI_API_HOST, getConfig, requireApiKey } from '../config.ts';
import {
  loginWithApiKey,
  listKeys,
  enableOAuthForKey,
  listOAuthProviders,
  initiateOAuth,
  listOAuthBindings,
  deleteOAuthBinding,
} from '../client.ts';
import { output, err } from '../format.ts';

/** Try to open a URL in the default browser. Silent on failure. */
function openBrowser(url: string): void {
  const cmd = process.platform === 'win32' ? 'start'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  try {
    spawnSync(cmd, [url], { stdio: 'ignore' });
  } catch {
    // ignore — user can open manually
  }
}

/**
 * Poll bindings until one for (apiKeyId, providerId) appears.
 * Shows a live countdown in TTY mode.
 * Returns the matched binding or null on timeout.
 */
async function pollForBinding(
  apiKeyId: string,
  providerId: string,
  jwtToken: string,
  timeoutMs = 5 * 60 * 1000,
  intervalMs = 3000,
): Promise<{ providerAccountName: string | null } | null> {
  const deadline = Date.now() + timeoutMs;
  const isTTY = process.stdout.isTTY;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));

    try {
      const bindings = await listOAuthBindings(jwtToken, XAPI_API_HOST);
      const match = Array.isArray(bindings)
        ? bindings.find((b) => b.apiKeyId === apiKeyId && b.providerId === providerId)
        : null;
      if (match) return match;
    } catch {
      // transient error — keep polling
    }

    if (isTTY) {
      const remaining = Math.ceil((deadline - Date.now()) / 1000);
      process.stdout.write(`\r  Waiting for authorization... (${remaining}s remaining)  `);
    }
  }

  if (process.stdout.isTTY) process.stdout.write('\n');
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function loginAndGetJwt(apiKey: string): Promise<string> {
  const result = await loginWithApiKey(apiKey, XAPI_API_HOST) as any;
  if (!result?.accessToken) {
    throw new Error('Login failed: no access token returned');
  }
  return result.accessToken;
}

/**
 * Find the API key record that corresponds to the current plaintext API key.
 * Matches by key prefix (first 7 chars of the plaintext key = keyPrefix).
 */
async function findCurrentKeyRecord(
  plaintextKey: string,
  jwtToken: string,
): Promise<{ id: string; name: string; keyPreview: string; oauthEnabled: boolean }> {
  const keys = await listKeys(jwtToken, XAPI_API_HOST);
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('No API keys found for this account');
  }
  if (keys.length === 1) return keys[0];
  // Match by prefix: keyPreview starts with the key's prefix
  const prefix = plaintextKey.substring(0, 7);
  const match = keys.find((k) => k.keyPreview.startsWith(prefix));
  if (!match) {
    // Fallback: use the first key
    return keys[0];
  }
  return match;
}

// ── Commands ───────────────────────────────────────────────────────────────────

/**
 * xapi oauth bind [--provider twitter]
 *
 * Initiates OAuth binding for the current API key.
 * Prints the authorization URL for the user to open in a browser.
 */
export async function oauthBind(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();
  requireApiKey(cfg);
  const apiKey = cfg.apiKey!;
  const providerName = (flags.provider || 'twitter').toLowerCase();

  try {
    // 1. Login to get JWT
    const jwtToken = await loginAndGetJwt(apiKey);

    // 2. Find the API key record
    const keyRecord = await findCurrentKeyRecord(apiKey, jwtToken);

    // 3. Enable OAuth on the key if needed
    if (!keyRecord.oauthEnabled) {
      await enableOAuthForKey(keyRecord.id, apiKey, jwtToken, XAPI_API_HOST);
    }

    // 4. Find the requested OAuth provider
    const providers = await listOAuthProviders(XAPI_API_HOST);
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new Error('No OAuth providers available');
    }
    const provider = providers.find(
      (p) =>
        p.type.toLowerCase() === providerName ||
        p.name.toLowerCase().includes(providerName),
    );
    if (!provider) {
      const available = providers.map((p) => p.type).join(', ');
      throw new Error(
        `Provider "${providerName}" not found. Available: ${available}`,
      );
    }

    // 5. Initiate OAuth authorization
    const result = await initiateOAuth(keyRecord.id, provider.id, jwtToken, XAPI_API_HOST);
    const { authorizationUrl } = result;

    const isTTY = process.stdout.isTTY;

    if (isTTY) {
      // Interactive mode: open browser + poll
      console.error(`\n  Provider : ${provider.name}`);
      console.error(`  API Key  : ${keyRecord.keyPreview}`);
      console.error(`\n  Authorization URL:\n  ${authorizationUrl}\n`);
      console.error('  Opening browser...');
      openBrowser(authorizationUrl);
      console.error('  Waiting for you to complete authorization in the browser...\n');

      const binding = await pollForBinding(keyRecord.id, provider.id, jwtToken);

      if (process.stdout.isTTY) process.stdout.write('\n');

      if (binding) {
        const account = (binding as any).providerAccountName || 'unknown';
        console.error(`\n  Authorization complete! Bound to @${account}\n`);
        output({ status: 'success', provider: provider.name, account }, flags.format as any);
      } else {
        err('oauth bind timed out', 'Authorization was not completed within 5 minutes. Run "xapi oauth bind" again.');
      }
    } else {
      // Non-interactive / agent mode: just output the URL
      output({
        status: 'pending',
        provider: provider.name,
        apiKey: keyRecord.keyPreview,
        authorizationUrl,
      }, flags.format as any);
    }
  } catch (e: any) {
    err('oauth bind failed', e.message);
  }
}

/**
 * xapi oauth status
 *
 * Lists all OAuth bindings for the current account.
 */
export async function oauthStatus(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();
  requireApiKey(cfg);
  const apiKey = cfg.apiKey!;

  try {
    const jwtToken = await loginAndGetJwt(apiKey);
    const bindings = await listOAuthBindings(jwtToken, XAPI_API_HOST);

    if (!Array.isArray(bindings) || bindings.length === 0) {
      output({
        status: 'no_bindings',
        message: 'No OAuth bindings found. Run "xapi oauth bind" to connect an account.',
      }, flags.format as any);
      return;
    }

    output({
      status: 'ok',
      count: bindings.length,
      bindings: bindings.map((b) => ({
        id: b.id,
        provider: b.provider.name,
        providerType: b.provider.type,
        account: b.providerAccountName || b.providerAccountId,
        apiKeyId: b.apiKeyId,
        scopes: b.scopes,
        boundAt: b.createdAt,
      })),
    }, flags.format as any);
  } catch (e: any) {
    err('oauth status failed', e.message);
  }
}

/**
 * xapi oauth unbind <binding-id>
 *
 * Deletes an OAuth binding. Get the ID from `xapi oauth status`.
 */
export async function oauthUnbind(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();
  requireApiKey(cfg);
  const apiKey = cfg.apiKey!;

  const bindingId = args[0];
  if (!bindingId) {
    err('usage: xapi oauth unbind <binding-id>', 'Get the binding ID from "xapi oauth status"');
  }

  try {
    const jwtToken = await loginAndGetJwt(apiKey);
    const result = await deleteOAuthBinding(bindingId, jwtToken, XAPI_API_HOST);
    output({ success: result.success, message: 'OAuth binding removed' }, flags.format as any);
  } catch (e: any) {
    err('oauth unbind failed', e.message);
  }
}

/**
 * xapi oauth providers
 *
 * Lists available OAuth providers.
 */
export async function oauthProviders(args: string[], flags: Record<string, string>) {
  try {
    const providers = await listOAuthProviders(XAPI_API_HOST);
    output(providers, flags.format as any);
  } catch (e: any) {
    err('oauth providers failed', e.message);
  }
}
