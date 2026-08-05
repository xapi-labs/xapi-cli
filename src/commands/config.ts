/**
 * config commands: show, set, health
 */

import { readFileSync } from 'fs';
import { getApiKeySource, getConfig, saveConfig, showConfig } from '../config.ts';
import { healthCheck } from '../client.ts';
import { output, err } from '../format.ts';

export const CONFIG_HELP = `xapi-to config - Manage CLI configuration

USAGE
  xapi-to config <command> [flags]

COMMANDS
  show                       Show current config (host, apiKey path, etc.)
  set apiKey=<key>           Save API key to ~/.xapi/config.json (apiKey=- reads from stdin)
  health                     Check backend connectivity (alias: xapi-to health)

FLAGS
  --format json|pretty|table   Output format

ENVIRONMENT OVERRIDES
  XAPI_KEY takes precedence over XAPI_API_KEY, which takes precedence over the file.
  Saving a file key does not replace an active environment-variable key.

EXAMPLES
  xapi-to config show
  xapi-to config set apiKey=xapi_abc123
  echo "$XAPI_KEY" | xapi-to config set apiKey=-   # keeps the key out of shell history
  xapi-to config health
`;

export const HEALTH_HELP = `xapi-to health - Check backend connectivity

USAGE
  xapi-to health [--format json|pretty|table]
`;

export async function configShow(args: string[], flags: Record<string, string>) {
  output(showConfig(), flags.format as any);
}

export async function configSet(args: string[], flags: Record<string, string>) {
  // xapi-to config set apiKey=xapi_xxx   (or apiKey=- to read the key from stdin)
  if (args.length === 0) err('usage: xapi-to config set apiKey=<key>');
  const updates: { apiKey?: string } = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq < 1) err(`invalid key=value: ${arg}`);
    const key = arg.slice(0, eq);
    if (key === 'host') err('host is built-in and cannot be configured');
    if (key !== 'apiKey') err(`unknown config key: ${key} (only apiKey is configurable)`);
    let value = arg.slice(eq + 1);
    if (value === '-') {
      // Read the key from stdin so it never lands in shell history.
      value = readFileSync(0, 'utf-8').trim();
    }
    if (!value) err('apiKey is empty');
    updates.apiKey = value;
  }
  const sourceBeforeSave = getApiKeySource();
  saveConfig(updates);
  const source = sourceBeforeSave === 'XAPI_KEY' || sourceBeforeSave === 'XAPI_API_KEY'
    ? sourceBeforeSave
    : 'file';
  output({
    ok: true,
    updated: Object.keys(updates),
    effective: source === 'file',
    source,
    ...(source === 'XAPI_KEY' || source === 'XAPI_API_KEY'
      ? { warning: `${source} still overrides the saved file key` }
      : {}),
  }, flags.format as any);
}

export async function configHealth(args: string[], flags: Record<string, string>) {
  if (flags.help) {
    console.log(HEALTH_HELP);
    return;
  }
  const cfg = getConfig();
  const start = Date.now();
  try {
    await healthCheck(cfg);
    output({ status: 'ok', host: cfg.actionHost, latency_ms: Date.now() - start }, flags.format as any);
  } catch (e: any) {
    output({ status: 'error', host: cfg.actionHost, error: e.message }, flags.format as any);
    process.exit(1);
  }
}
