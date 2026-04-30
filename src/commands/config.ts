/**
 * config commands: show, set, health
 */

import { getConfig, saveConfig, showConfig } from '../config.ts';
import { healthCheck } from '../client.ts';
import { output, err } from '../format.ts';

export const CONFIG_HELP = `xapi config - Manage CLI configuration

USAGE
  xapi config <command> [flags]

COMMANDS
  show                       Show current config (host, apiKey path, etc.)
  set apiKey=<key>           Save API key to ~/.xapi/config.json
  health                     Check backend connectivity (alias: xapi health)

FLAGS
  --format json|pretty|table   Output format

EXAMPLES
  xapi config show
  xapi config set apiKey=xapi_abc123
  xapi config health
`;

export async function configShow(args: string[], flags: Record<string, string>) {
  showConfig();
}

export async function configSet(args: string[], flags: Record<string, string>) {
  // xapi config set apiKey=xapi_xxx
  if (args.length === 0) err('usage: xapi config set apiKey=<key>');
  const updates: { apiKey?: string } = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq < 1) err(`invalid key=value: ${arg}`);
    const key = arg.slice(0, eq);
    if (key === 'host') err('host is built-in and cannot be configured');
    if (key !== 'apiKey') err(`unknown config key: ${key} (only apiKey is configurable)`);
    updates.apiKey = arg.slice(eq + 1);
  }
  saveConfig(updates);
  console.log(JSON.stringify({ ok: true, updated: Object.keys(updates) }));
}

export async function configHealth(args: string[], flags: Record<string, string>) {
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
