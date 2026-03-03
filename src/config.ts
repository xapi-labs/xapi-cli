/**
 * Config management
 * Only apiKey is user-configurable. Host is built-in.
 * Reads from env var XAPI_API_KEY or ~/.xapi/config.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { err } from './format.ts';
import { homedir } from 'os';
import { join } from 'path';

export const XAPI_CAPABILITY_HOST = 'c.xapi.to'; // capability + API service
export const XAPI_API_HOST = 'api.xapi.to';      // auth + agent API

/** Returns https:// for remote hosts, http:// for localhost */
export function scheme(host: string): string {
  return host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https';
}

export interface XapiConfig {
  capabilityHost: string;
  apiKey?: string;
}

const CONFIG_DIR = join(homedir(), '.xapi');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function loadFileConfig(): { apiKey?: string } {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

export function getConfig(): XapiConfig {
  const file = loadFileConfig();
  return {
    capabilityHost: XAPI_CAPABILITY_HOST,
    apiKey: process.env.XAPI_API_KEY || file.apiKey,
  };
}

export function requireApiKey(cfg: XapiConfig): void {
  if (!cfg.apiKey) {
    err('API key not configured', 'Run "xapi register" to create an account, or "xapi config set apiKey=<key>" to set an existing key.');
  }
}

export function saveConfig(updates: { apiKey?: string }): void {
  const current = loadFileConfig();
  const merged = { ...current, ...updates };
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
}

export function showConfig(): void {
  const cfg = getConfig();
  const file = loadFileConfig();
  console.log(JSON.stringify({
    capabilityHost: cfg.capabilityHost,
    apiKey: cfg.apiKey ? `${cfg.apiKey.slice(0, 8)}...` : undefined,
    source: {
      apiKey: process.env.XAPI_API_KEY ? 'env' : file.apiKey ? 'file' : 'none',
    },
    configFile: CONFIG_FILE,
  }, null, 2));
}
