/**
 * Config management
 * Only apiKey is user-configurable. Host is built-in.
 * Reads from env var XAPI_KEY or ~/.xapi/config.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { err } from './format.ts';
import { homedir } from 'os';
import { join } from 'path';

export const XAPI_ACTION_HOST = process.env.XAPI_ACTION_HOST || 'action.xapi.to'; // action service (capabilities + APIs)
export const XAPI_API_HOST = process.env.XAPI_API_HOST || 'api.xapi.to';          // auth + agent API
export const XAPI_SANDBOX_HOST = process.env.XAPI_SANDBOX_HOST || 'sandbox.xapi.to'; // sandbox control plane

/** Returns https:// for remote hosts, http:// for localhost/loopback */
export function scheme(host: string): string {
  return isLoopbackHost(host) ? 'http' : 'https';
}

// ── Host allowlist ─────────────────────────────────────────────────────────────
// The API key is attached (as the XAPI-Key header) to every request the client
// makes. To honor the documented guarantee that the key is only ever sent to
// xapi-controlled hosts, every outbound host is checked against this allowlist
// before the key leaves the machine.
const ALLOWED_HOST_EXACT = ['xapi.to', 'xapi.xyz'];
const ALLOWED_HOST_SUFFIXES = ['.xapi.to', '.xapi.xyz'];

/**
 * Extract the hostname exactly as fetch/WHATWG URL resolves it. Hand-rolled string
 * parsing is unsafe here: WHATWG treats "\" as "/", so `evil.example\@action.xapi.to`
 * has hostname `evil.example` even though a naive suffix check sees `.xapi.to`. Using
 * the same parser fetch uses keeps the allowlist check consistent with the host the
 * request actually contacts. Returns '' for anything unparseable (→ not allowed).
 */
function hostnameOf(hostOrUrl: string): string {
  const raw = hostOrUrl.includes('://') ? hostOrUrl : `http://${hostOrUrl}`;
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True only for a syntactically valid IPv4 address inside 127.0.0.0/8.
 * A prefix test like /^127\./ is unsafe — it also matches domain names such as
 * `127.attacker.com` or `127.0.0.1.nip.io`, which resolve to attacker-controlled
 * IPs and would let the API key escape the allowlist.
 */
function isLoopbackIPv4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) && octets[0] === 127;
}

/** True for a localhost / loopback hostname (already normalized via hostnameOf). */
function isLoopbackHostname(h: string): boolean {
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '[::1]' ||
    isLoopbackIPv4(h)
  );
}

/** True for localhost / loopback hosts, which are always permitted (local dev). */
export function isLoopbackHost(hostOrUrl: string): boolean {
  return isLoopbackHostname(hostnameOf(hostOrUrl));
}

/** True if the API key is allowed to be sent to this host. */
export function isAllowedHost(hostOrUrl: string): boolean {
  const h = hostnameOf(hostOrUrl);
  if (!h) return false;
  if (isLoopbackHostname(h)) return true;
  if (ALLOWED_HOST_EXACT.includes(h)) return true;
  return ALLOWED_HOST_SUFFIXES.some((suffix) => h.endsWith(suffix));
}

/** Throw if the API key must not be sent to this host. */
export function assertAllowedHost(hostOrUrl: string): void {
  if (!isAllowedHost(hostOrUrl)) {
    throw new Error(
      `refusing to contact untrusted host "${hostnameOf(hostOrUrl) || hostOrUrl}": ` +
      `the xapi API key may only be sent to *.xapi.to, *.xapi.xyz, or localhost`,
    );
  }
}

export interface XapiConfig {
  actionHost: string;
  sandboxHost?: string;
  apiKey?: string;
}

export type ApiKeySource = 'XAPI_KEY' | 'XAPI_API_KEY' | 'file' | 'none';

const CONFIG_DIR = join(homedir(), '.xapi');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function loadFileConfig(): { apiKey?: string } {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return typeof parsed.apiKey === 'string' && parsed.apiKey.trim()
      ? { apiKey: parsed.apiKey }
      : {};
  } catch {
    return {};
  }
}

export function getApiKeySource(): ApiKeySource {
  if (process.env.XAPI_KEY) return 'XAPI_KEY';
  if (process.env.XAPI_API_KEY) return 'XAPI_API_KEY';
  return loadFileConfig().apiKey ? 'file' : 'none';
}

export function getConfig(): XapiConfig {
  const file = loadFileConfig();
  return {
    actionHost: XAPI_ACTION_HOST,
    sandboxHost: XAPI_SANDBOX_HOST,
    apiKey: process.env.XAPI_KEY || process.env.XAPI_API_KEY || file.apiKey,
  };
}

export function requireApiKey(cfg: XapiConfig): void {
  if (!cfg.apiKey) {
    err('API key not configured', 'Run "npx xapi-to register" to create an account, or "npx xapi-to config set apiKey=<key>" to set an existing key.');
  }
}

export function saveConfig(updates: { apiKey?: string }): void {
  const current = loadFileConfig();
  const merged = { ...current, ...updates };
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(CONFIG_DIR, 0o700);
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), { mode: 0o600 });
  // `mode` only applies when a file is created. Repair permissions as well when
  // overwriting a config file created by an older CLI version.
  if (process.platform !== 'win32') chmodSync(CONFIG_FILE, 0o600);
}

export function showConfig(): Record<string, unknown> {
  const cfg = getConfig();
  return {
    actionHost: cfg.actionHost,
    sandboxHost: cfg.sandboxHost,
    apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}...` : undefined,
    source: {
      apiKey: getApiKeySource(),
    },
    configFile: CONFIG_FILE,
  };
}
