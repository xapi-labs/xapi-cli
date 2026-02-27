#!/usr/bin/env bun
/**
 * xapi CLI - agent-friendly command-line interface for xapi
 *
 * Usage:
 *   xapi cap list
 *   xapi cap search <query>
 *   xapi cap get <id>
 *   xapi cap call <id> [key=val ...] [--input '{"k":"v"}']
 *
 *   xapi api list [--page N] [--page-size N] [--category X]
 *   xapi api search <query> [--category X] [--limit N]
 *   xapi api categories
 *   xapi api get <id> [id2 ...]
 *   xapi api call <id> [key=val ...] [--input '{"k":"v"}']
 *
 *   xapi config show
 *   xapi config set apiKey=<key>
 *   xapi config health
 *
 * Global flags:
 *   --format json|pretty|table   output format (default: json)
 *   --help                       show help
 *
 * Env vars:
 *   XAPI_API_KEY     API key
 *   XAPI_OUTPUT      default output format (json|pretty|table)
 */

import * as capCmds from './commands/cap.ts';
import * as apiCmds from './commands/api.ts';
import * as cfgCmds from './commands/config.ts';
import * as regCmds from './commands/register.ts';
import * as topupCmds from './commands/topup.ts';
import * as balanceCmds from './commands/balance.ts';

// ── Argument parser ───────────────────────────────────────────────────────────

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = 'true';
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }
  return { positional, flags };
}

// ── Help ──────────────────────────────────────────────────────────────────────

const HELP = `xapi - agent-friendly CLI for xapi

USAGE
  xapi <group> <command> [args] [flags]

GROUPS & COMMANDS
  cap list                          List all capabilities
  cap search <query>                Search capabilities by keyword
  cap get <id>                      Get capability schema
  cap call <id> [key=val ...]       Execute a capability
    --input '{"key":"val"}'         Pass input as JSON

  api list                          List APIs (paginated)
    --page N  --page-size N         Pagination
    --category <name>               Filter by category
  api search <query>                Search APIs by keyword
    --category <name>  --limit N    Filters
  api categories                    List all API categories
  api get <id> [id2 ...]            Get API schema (batch if multiple IDs)
  api call <id> [key=val ...]       Execute an API
    --input '{"key":"val"}'         Pass input as JSON

  register                          Create a new user account (apiKey saved automatically)

  balance                           Show current account balance

  topup [--amount <usd>] [--method stripe|x402]   Generate payment URL

  config show                       Show current config
  config set apiKey=<key>           Save API key to ~/.xapi/config.json
  config health                     Check backend connectivity

GLOBAL FLAGS
  --format json|pretty|table        Output format (default: json)
  --help                            Show this help

ENV VARS
  XAPI_API_KEY    API key (header: XAPI-Key)
  XAPI_OUTPUT     Default output format

EXAMPLES
  xapi register
  xapi cap list --format table
  xapi cap get twitter.tweet_detail
  xapi cap call twitter.tweet_detail tweet_id=1234567890
  xapi api search "token price" --limit 5
  xapi api get <uuid>
  xapi api call <uuid> --input '{"query":"BTC"}'
  xapi config set apiKey=xapi_abc123
  xapi config health
`;

// ── Router ────────────────────────────────────────────────────────────────────

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.help || positional.length === 0) {
    console.log(HELP);
    process.exit(0);
  }

  // inject format from flag into env so format.ts picks it up
  if (flags.format) process.env.XAPI_OUTPUT = flags.format;

  const [group, cmd, ...rest] = positional;

  if (group === 'cap') {
    switch (cmd) {
      case 'list':     return capCmds.capList(rest, flags);
      case 'search':   return capCmds.capSearch(rest, flags);
      case 'get':      return capCmds.capGet(rest, flags);
      case 'call':     return capCmds.capCall(rest, flags);
      default:
        console.error(JSON.stringify({ error: `unknown cap command: ${cmd}` }));
        process.exit(1);
    }
  }

  if (group === 'api') {
    switch (cmd) {
      case 'list':       return apiCmds.apiList(rest, flags);
      case 'search':     return apiCmds.apiSearch(rest, flags);
      case 'categories': return apiCmds.apiCategories(rest, flags);
      case 'get':        return apiCmds.apiGet(rest, flags);
      case 'call':       return apiCmds.apiCall(rest, flags);
      default:
        console.error(JSON.stringify({ error: `unknown api command: ${cmd}` }));
        process.exit(1);
    }
  }

  if (group === 'balance') return balanceCmds.balance(rest, flags);

  if (group === 'topup') {
    const allArgs = cmd ? [cmd, ...rest] : rest;
    return topupCmds.topup(allArgs, flags);
  }

  if (group === 'register') {
    return regCmds.register(rest, flags);
  }

  if (group === 'config') {
    switch (cmd) {
      case 'show':   return cfgCmds.configShow(rest, flags);
      case 'set':    return cfgCmds.configSet(rest, flags);
      case 'health': return cfgCmds.configHealth(rest, flags);
      default:
        console.error(JSON.stringify({ error: `unknown config command: ${cmd}` }));
        process.exit(1);
    }
  }

  console.error(JSON.stringify({ error: `unknown group: ${group}`, hint: 'run xapi --help' }));
  process.exit(1);
}

main().catch(e => {
  console.error(JSON.stringify({ error: 'fatal', message: e.message }));
  process.exit(1);
});
