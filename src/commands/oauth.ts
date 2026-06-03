/**
 * oauth commands: bind, status, unbind
 *
 * Flow for `xapi-to oauth bind [--provider twitter]`:
 *  1. Login with current API key → get JWT
 *  2. List API keys → find the one matching the current key by prefix
 *  3. Enable OAuth on the key if not already (POST /keys/:id/enable-oauth)
 *  4. List OAuth providers → find the requested provider
 *  5. Interactive scope selection (TTY) or --scopes flag
 *  6. POST /oauth/authorize → get authorizationUrl
 *  7. Open browser (macOS/Linux/Windows) and poll for binding completion
 *
 * `xapi-to oauth status`: list current OAuth bindings for the API key
 * `xapi-to oauth unbind <binding-id>`: delete an OAuth binding
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
import type { OAuthProvider, ScopeDefinition } from '../client.ts';
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

/**
 * Build the scope definitions list. If the provider has scopeDefinitions, use
 * them directly. Otherwise, synthesize from defaultScopes (each scope becomes
 * an optional toggle, matching the frontend fallback).
 */
function resolveScopeDefs(provider: OAuthProvider): ScopeDefinition[] {
  if (Array.isArray(provider.scopeDefinitions) && provider.scopeDefinitions.length > 0) {
    return provider.scopeDefinitions;
  }
  const raw = (provider.defaultScopes || '').split(/[\s,]+/).filter(Boolean);
  return raw.map((s) => ({
    scope: s,
    label: s,
    description: '',
    required: false,
    category: '',
  }));
}

/**
 * Interactive scope selection using arrow keys + space.
 *
 *   ↑/↓  navigate    space  toggle    a  select all    n  deselect all    enter  confirm
 *
 * Required scopes are shown but locked. Optional scopes default to selected.
 * Uses save/restore cursor position for clean in-place re-rendering.
 */
async function selectScopesInteractive(provider: OAuthProvider): Promise<string> {
  const defs = resolveScopeDefs(provider);
  if (defs.length === 0) return '';

  const required = defs.filter((d) => d.required);
  const optional = defs.filter((d) => !d.required);
  const selected = new Set(defs.map((d) => d.scope));

  if (optional.length === 0) {
    return required.map((d) => d.scope).join(' ');
  }

  const out = process.stderr;
  let cursor = 0;
  const hint = '  ↑↓ navigate · space toggle · a all · n none · enter confirm';

  const buildFrame = (): string => {
    const lines: string[] = [];
    for (const d of required) {
      const desc = d.description ? ` — ${d.description}` : '';
      lines.push(`    \x1b[2m[*] ${d.label}${desc} (required)\x1b[0m`);
    }
    for (let i = 0; i < optional.length; i++) {
      const d = optional[i];
      const ptr = cursor === i ? ' \x1b[36m❯\x1b[0m' : '  ';
      const chk = selected.has(d.scope) ? '\x1b[32m✔\x1b[0m' : ' ';
      const desc = d.description ? ` \x1b[2m— ${d.description}\x1b[0m` : '';
      lines.push(`  ${ptr} [${chk}] ${d.label}${desc}`);
    }
    lines.push(`\x1b[2m${hint}\x1b[0m`);
    return lines.join('\n');
  };

  // Initial render: print header, save cursor, draw frame
  out.write('\n  Scopes:\n');
  out.write('\x1b[s');       // save cursor position
  out.write('\x1b[?25l');    // hide cursor
  out.write(buildFrame());

  const redraw = () => {
    out.write('\x1b[u');     // restore to saved position
    out.write('\x1b[J');     // clear from cursor to end of screen
    out.write(buildFrame());
  };

  return new Promise((resolve) => {
    const { stdin } = process;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();

    const finish = (result: string) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      out.write('\x1b[?25h'); // show cursor
      out.write('\n');
      resolve(result);
    };

    const onData = (buf: Buffer) => {
      const key = buf.toString();

      if (key === '\r' || key === '\n') {
        finish(Array.from(selected).join(' '));
        return;
      }
      if (key === '\x03') {
        finish('');
        process.exit(130);
      }

      if (key === '\x1b[A' || key === 'k') {
        cursor = (cursor - 1 + optional.length) % optional.length;
      } else if (key === '\x1b[B' || key === 'j') {
        cursor = (cursor + 1) % optional.length;
      } else if (key === ' ') {
        const scope = optional[cursor].scope;
        if (selected.has(scope)) selected.delete(scope);
        else selected.add(scope);
      } else if (key === 'a') {
        for (const d of optional) selected.add(d.scope);
      } else if (key === 'n') {
        for (const d of optional) selected.delete(d.scope);
      } else {
        return;
      }

      redraw();
    };

    stdin.on('data', onData);
  });
}

// ── Help text ──────────────────────────────────────────────────────────────────

export const OAUTH_HELP = `xapi-to oauth - Manage OAuth bindings

USAGE
  xapi-to oauth <command> [flags]

COMMANDS
  bind [--provider <name>]   Bind an OAuth account to your API key
  status                     List current OAuth bindings
  unbind <binding-id>        Remove an OAuth binding
  providers                  List available OAuth providers

FLAGS
  --provider <name>          OAuth provider (default: twitter)
  --scopes <scopes>          Space-separated scopes (skips interactive selection)
  --format json|pretty|table   Output format

EXAMPLES
  xapi-to oauth bind
  xapi-to oauth bind --provider twitter
  xapi-to oauth bind --scopes "tweet.read users.read"
  xapi-to oauth status
  xapi-to oauth status --format pretty
  xapi-to oauth unbind abc123
  xapi-to oauth providers
`;

// ── Commands ───────────────────────────────────────────────────────────────────

/**
 * xapi-to oauth bind [--provider twitter] [--scopes "..."]
 *
 * Initiates OAuth binding for the current API key.
 * In TTY mode, shows interactive scope selection then opens the browser.
 * In non-TTY mode, outputs the authorization URL as JSON.
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

    // 5. Resolve scopes
    let scopes: string | undefined;
    let headerPrinted = false;
    const isTTY = process.stdout.isTTY;

    if (flags.scopes) {
      scopes = flags.scopes;
    } else if (isTTY) {
      const defs = resolveScopeDefs(provider);
      if (defs.length > 0) {
        console.error(`\n  Provider : ${provider.name}`);
        console.error(`  API Key  : ${keyRecord.keyPreview}`);
        headerPrinted = true;
        scopes = await selectScopesInteractive(provider) || undefined;
      }
    }

    // 6. Initiate OAuth authorization
    const result = await initiateOAuth(keyRecord.id, provider.id, jwtToken, XAPI_API_HOST, scopes);
    const { authorizationUrl } = result;

    if (isTTY) {
      // Interactive mode: open browser + poll
      if (!headerPrinted) {
        console.error(`\n  Provider : ${provider.name}`);
        console.error(`  API Key  : ${keyRecord.keyPreview}`);
      }
      if (scopes) {
        console.error(`  Scopes   : ${scopes}`);
      }
      console.error(`\n  Authorization URL:\n  ${authorizationUrl}\n`);
      console.error('  Opening browser...');
      openBrowser(authorizationUrl);
      console.error('  Waiting for you to complete authorization in the browser...\n');

      const binding = await pollForBinding(keyRecord.id, provider.id, jwtToken);

      if (process.stdout.isTTY) process.stdout.write('\n');

      if (binding) {
        const account = (binding as any).providerAccountName || 'unknown';
        console.error(`\n  Authorization complete! Bound to @${account}\n`);
        output({ status: 'success', provider: provider.name, account, scopes }, flags.format as any);
      } else {
        err('oauth bind timed out', 'Authorization was not completed within 5 minutes. Run "xapi-to oauth bind" again.');
      }
    } else {
      // Non-interactive / agent mode: just output the URL
      output({
        status: 'pending',
        provider: provider.name,
        apiKey: keyRecord.keyPreview,
        authorizationUrl,
        scopes,
      }, flags.format as any);
    }
  } catch (e: any) {
    err('oauth bind failed', e.message);
  }
}

/**
 * xapi-to oauth status
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
        message: 'No OAuth bindings found. Run "xapi-to oauth bind" to connect an account.',
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
 * xapi-to oauth unbind <binding-id>
 *
 * Deletes an OAuth binding. Get the ID from `xapi-to oauth status`.
 */
export async function oauthUnbind(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();
  requireApiKey(cfg);
  const apiKey = cfg.apiKey!;

  const bindingId = args[0];
  if (!bindingId) {
    err('usage: xapi-to oauth unbind <binding-id>', 'Get the binding ID from "xapi-to oauth status"');
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
 * xapi-to oauth providers
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
