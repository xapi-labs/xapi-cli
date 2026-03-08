#!/usr/bin/env bun
/**
 * xapi CLI - agent-friendly command-line interface for xapi
 *
 * Usage:
 *   xapi list [--source capability|api] [--page N] [--page-size N] [--category X]
 *   xapi search <query> [--source capability|api] [--category X] [--page N] [--page-size N]
 *   xapi categories [--source capability|api]
 *   xapi services [--page N] [--page-size N] [--category X]
 *   xapi get <id>
 *   xapi call <id> --input '{"k":"v"}'
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
 *   XAPI_API_KEY       API key
 *   XAPI_ACTION_HOST   Action service host (default: action.xapi.to)
 *   XAPI_OUTPUT        default output format (json|pretty|table)
 */

import * as actionCmds from './commands/action.ts';
import * as cfgCmds from './commands/config.ts';
import * as regCmds from './commands/register.ts';
import * as topupCmds from './commands/topup.ts';
import * as balanceCmds from './commands/balance.ts';
import * as oauthCmds from './commands/oauth.ts';

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
  xapi <command> [args] [flags]

COMMANDS
  list                              List all actions
    --source capability|api         Filter by source type
    --page N  --page-size N         Pagination
    --category <name>               Filter by category
    --service-id <id>               Filter by service
  search <query>                    Search actions by keyword
    --source capability|api         Filter by source type
    --category <name>               Filter by category
    --page N  --page-size N         Pagination
  categories                        List all action categories
    --source capability|api         Filter by source type
  services                          List all services
    --page N  --page-size N         Pagination
    --category <name>               Filter by category
  get <id> [--method GET|POST|...]   Get action schema (filter by HTTP method)
  call <id> --input '{"key":"val"}'  Execute an action

  oauth bind [--provider twitter]   Bind Twitter OAuth to your API key
  oauth status                      List current OAuth bindings
  oauth unbind <binding-id>         Remove an OAuth binding
  oauth providers                   List available OAuth providers

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
  XAPI_API_KEY       API key (header: XAPI-Key)
  XAPI_ACTION_HOST   Action service host (default: action.xapi.to)
  XAPI_OUTPUT        Default output format

EXAMPLES
  xapi register
  xapi list --format table
  xapi list --source capability
  xapi search twitter --source api
  xapi get twitter.tweet_detail
  xapi call twitter.tweet_detail --input '{"tweet_id":"1234567890"}'
  xapi categories
  xapi services --format table
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

  const [cmd, ...rest] = positional;

  switch (cmd) {
    // ── Action commands (top-level) ──
    case 'list':       return actionCmds.actionList(rest, flags);
    case 'search':     return actionCmds.actionSearch(rest, flags);
    case 'categories': return actionCmds.actionCategories(rest, flags);
    case 'services':   return actionCmds.actionServices(rest, flags);
    case 'get':        return actionCmds.actionGet(rest, flags);
    case 'call':       return actionCmds.actionCall(rest, flags);

    // ── OAuth commands ──
    case 'oauth': {
      const [subCmd, ...subRest] = rest;
      switch (subCmd) {
        case 'bind':      return oauthCmds.oauthBind(subRest, flags);
        case 'status':    return oauthCmds.oauthStatus(subRest, flags);
        case 'unbind':    return oauthCmds.oauthUnbind(subRest, flags);
        case 'providers': return oauthCmds.oauthProviders(subRest, flags);
        default:
          console.error(JSON.stringify({ error: `unknown oauth command: ${subCmd}`, hint: 'valid commands: bind, status, unbind, providers' }));
          process.exit(1);
      }
      break;
    }

    // ── Account commands ──
    case 'register':   return regCmds.register(rest, flags);
    case 'balance':    return balanceCmds.balance(rest, flags);
    case 'topup':      return topupCmds.topup(rest, flags);

    // ── Config commands ──
    case 'config': {
      const [subCmd, ...subRest] = rest;
      switch (subCmd) {
        case 'show':   return cfgCmds.configShow(subRest, flags);
        case 'set':    return cfgCmds.configSet(subRest, flags);
        case 'health': return cfgCmds.configHealth(subRest, flags);
        default:
          console.error(JSON.stringify({ error: `unknown config command: ${subCmd}` }));
          process.exit(1);
      }
      break;
    }

    default:
      console.error(JSON.stringify({ error: `unknown command: ${cmd}`, hint: 'run xapi --help' }));
      process.exit(1);
  }
}

main().catch(e => {
  console.error(JSON.stringify({ error: 'fatal', message: e.message }));
  process.exit(1);
});
