/**
 * Login session reuse for the JWT-only account routes (balance, oauth).
 *
 * Exchanging the API key on every command trips the auth throttle: a few quick
 * `balance` checks in a row fail with HTTP 429. A key stored in
 * ~/.xapi/config.json may keep its short-lived session beside it (same 0700
 * directory, 0600 file) until shortly before the JWT expires. A key supplied
 * through XAPI_KEY / XAPI_API_KEY was deliberately kept off disk, so nothing
 * derived from it is written either; those processes log in as before.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loginWithApiKey } from './client.ts';
import { isStoredApiKey, sessionFile } from './config.ts';

const RENEW_BEFORE_MS = 60_000;
const FALLBACK_TTL_MS = 5 * 60_000;

interface StoredSession { id: string; token: string; expiresAt: number }

function sessionId(apiKey: string, apiHost: string): string {
  return createHash('sha256').update(`${apiHost}\0${apiKey}`).digest('hex').slice(0, 32);
}

function tokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
    if (typeof payload?.exp === 'number') return payload.exp * 1000;
  } catch { /* not a JWT we can read: fall back to a short lifetime */ }
  return Date.now() + FALLBACK_TTL_MS;
}

function readSession(id: string): StoredSession | undefined {
  try {
    const value = JSON.parse(readFileSync(sessionFile(), 'utf8'));
    if (value?.id === id && typeof value.token === 'string' && typeof value.expiresAt === 'number') return value;
  } catch { /* missing or unreadable cache: log in */ }
  return undefined;
}

function writeSession(session: StoredSession): void {
  const file = sessionFile();
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch { /* a cache that cannot be written only costs one more login */ }
}

/** A JWT for the account behind apiKey, reusing a still-valid stored session. */
export async function sessionToken(apiKey: string, apiHost: string): Promise<string> {
  const id = sessionId(apiKey, apiHost);
  const persist = isStoredApiKey(apiKey);
  const cached = persist ? readSession(id) : undefined;
  if (cached && cached.expiresAt - RENEW_BEFORE_MS > Date.now()) return cached.token;

  const result = await loginWithApiKey(apiKey, apiHost) as { accessToken?: unknown };
  if (typeof result?.accessToken !== 'string' || !result.accessToken) {
    throw new Error('Login failed: no access token returned');
  }
  if (persist) writeSession({ id, token: result.accessToken, expiresAt: tokenExpiry(result.accessToken) });
  return result.accessToken;
}

/** Forget a session the server rejected (401) so the next call logs in again. */
export function dropSession(apiKey: string, apiHost: string): void {
  if (readSession(sessionId(apiKey, apiHost))) {
    try { rmSync(sessionFile(), { force: true }); } catch { /* best effort */ }
  }
}
