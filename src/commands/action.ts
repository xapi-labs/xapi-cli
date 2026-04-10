/**
 * Top-level action commands: list, search, categories, services, get, call
 * Unified interface for all actions (capabilities + APIs).
 * Use --source capability|api to filter by source type.
 */

import { getConfig, requireApiKey } from '../config.ts';
import * as client from '../client.ts';
import { output, err, getFormat } from '../format.ts';
import { generateCode, buildDefaultInput, resolveTarget } from '../codegen.ts';

const VALID_SOURCES = ['capability', 'api'];

// ── Subcommand help texts ────────────────────────────────────────────────────

const LIST_HELP = `xapi list - List all actions

USAGE
  xapi list [flags]

FLAGS
  --source capability|api   Filter by source type
  --category <name>         Filter by category
  --service-id <id>         Filter by service
  --page N                  Page number (default: 1)
  --page-size N             Results per page
  --format json|pretty|table  Output format

EXAMPLES
  xapi list
  xapi list --source api --format table
  xapi list --category social --page 2
`;

const SEARCH_HELP = `xapi search - Search actions by keyword

USAGE
  xapi search <query> [flags]

FLAGS
  --source capability|api   Filter by source type
  --category <name>         Filter by category
  --page N                  Page number (default: 1)
  --page-size N             Results per page
  --format json|pretty|table  Output format

EXAMPLES
  xapi search twitter
  xapi search "tweet detail" --source api
  xapi search weather --category utility --format table
`;

const GET_HELP = `xapi get - Get action schema

USAGE
  xapi get <id> [flags]

FLAGS
  --method GET|POST|...     Filter by HTTP method
  --code <target>           Generate code snippet instead of showing schema
  --format json|pretty|table  Output format

CODE TARGETS
  curl                      cURL command
  py, python                Python (requests)
  python.requests           Python with requests
  py.requests               alias for python.requests
  python.httpx              Python with httpx
  py.httpx                  alias for python.httpx
  js, javascript            JavaScript (fetch)
  javascript.fetch          JavaScript with fetch
  js.fetch                  alias for javascript.fetch
  javascript.axios          JavaScript with axios
  js.axios                  alias for javascript.axios
  ts, typescript            TypeScript (fetch)
  typescript.fetch          TypeScript with fetch
  ts.fetch                  alias for typescript.fetch
  go                        Go (net/http)

EXAMPLES
  xapi get twitter.tweet_detail
  xapi get twitter.tweet_detail --method POST
  xapi get twitter.tweet_detail --code curl
  xapi get twitter.tweet_detail --code python.httpx --format pretty
`;

const CALL_HELP = `xapi call - Execute an action

USAGE
  xapi call <id> --input '{"key":"val"}' [flags]

FLAGS
  --input <json>            Input payload as JSON (required for execution)
  --method GET|POST|...     Override HTTP method
  --code <target>           Generate code snippet instead of executing
  --format json|pretty|table  Output format

CODE TARGETS
  curl                      cURL command
  py, python                Python (requests)
  python.requests           Python with requests
  py.requests               alias for python.requests
  python.httpx              Python with httpx
  py.httpx                  alias for python.httpx
  js, javascript            JavaScript (fetch)
  javascript.fetch          JavaScript with fetch
  js.fetch                  alias for javascript.fetch
  javascript.axios          JavaScript with axios
  js.axios                  alias for javascript.axios
  ts, typescript            TypeScript (fetch)
  typescript.fetch          TypeScript with fetch
  ts.fetch                  alias for typescript.fetch
  go                        Go (net/http)

EXAMPLES
  xapi call twitter.tweet_detail --input '{"tweet_id":"1234567890"}'
  xapi call twitter.tweet_detail --input '{"tweet_id":"123"}' --code py
  xapi call twitter.tweet_detail --input '{"tweet_id":"123"}' --code curl --format pretty
`;

/** Print subcommand help and exit if --help flag is set */
function showHelpIfRequested(flags: Record<string, string>, helpText: string): void {
  if (flags.help) {
    console.log(helpText);
    process.exit(0);
  }
}

/** Validate --code flag: check for bare flag and unknown target (fail fast before I/O) */
function validateCodeFlag(flags: Record<string, string>): void {
  if (flags.code === 'true') {
    err('--code requires a target language, e.g. --code curl, --code py, --code js');
  }
  resolveTarget(flags.code);
}

/** Output code snippet respecting --format */
function outputCode(result: { lang: string; lib: string; code: string }, flags: Record<string, string>) {
  const fmt = flags.format || getFormat();
  if (fmt === 'json') {
    output({ language: result.lang, library: result.lib, code: result.code }, 'json');
  } else {
    console.log(result.code);
  }
}

/** Validate and return source filter from --source flag */
function getSource(flags: Record<string, string>): string | undefined {
  if (!flags.source) return undefined;
  if (!VALID_SOURCES.includes(flags.source)) {
    err(`invalid --source value: "${flags.source}". Must be "capability" or "api".`);
  }
  return flags.source;
}

export async function actionList(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, LIST_HELP);
  const cfg = getConfig();
  try {
    const res = await client.actionList(cfg, {
      source: getSource(flags),
      page: flags.page ? parseInt(flags.page) : undefined,
      page_size: flags['page-size'] ? parseInt(flags['page-size']) : undefined,
      category: flags.category,
      service_id: flags['service-id'],
    });
    const actions = (res.actions || []) as any[];
    if (flags.format === 'table') {
      output(actions.map((a: any) => ({
        id: a.id,
        method: a.method ?? '',
        displayName: a.displayName ?? '',
        source: a.source ?? '',
        category: a.meta?.category ?? '',
        status: a.status ?? '',
        cost: a.meta?.cost ?? '',
      })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('list failed', e.message);
  }
}

export async function actionSearch(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, SEARCH_HELP);
  const query = args[0];
  if (!query) err('usage: xapi search <query>');
  const cfg = getConfig();
  try {
    const res = await client.actionSearch(query, cfg, {
      source: getSource(flags),
      category: flags.category,
      page: flags.page ? parseInt(flags.page) : undefined,
      page_size: flags['page-size'] ? parseInt(flags['page-size']) : undefined,
    });
    const results = (res.results || []) as any[];
    if (flags.format === 'table') {
      output(results.map((a: any) => ({
        id: a.id,
        method: a.method ?? '',
        displayName: a.displayName ?? '',
        source: a.source ?? '',
        category: a.meta?.category ?? '',
        status: a.status ?? '',
        cost: a.meta?.cost ?? '',
      })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('search failed', e.message);
  }
}

export async function actionCategories(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();
  try {
    const res = await client.actionCategories(cfg, { source: getSource(flags) });
    if (flags.format === 'table') {
      output(res.categories.map(c => ({ category: c })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('categories failed', e.message);
  }
}

export async function actionServices(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();
  try {
    const res = await client.actionServices(cfg, {
      page: flags.page ? parseInt(flags.page) : undefined,
      page_size: flags['page-size'] ? parseInt(flags['page-size']) : undefined,
      category: flags.category,
    });
    const services = (res.services || []) as any[];
    if (flags.format === 'table') {
      output(services.map((s: any) => ({
        id: s.id,
        name: s.name ?? '',
        category: s.category ?? '',
        source: s.source ?? '',
        endpoints: s.endpointCount ?? '',
        status: s.status ?? '',
      })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('services failed', e.message);
  }
}

export async function actionGet(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, GET_HELP);
  const id = args[0];
  if (!id) err('usage: xapi get <id> [--method GET|POST|DELETE|...]');
  if (flags.code) validateCodeFlag(flags);
  const cfg = getConfig();
  try {
    const res = await client.actionGet(id, cfg);
    const actions = Array.isArray(res) ? res : [res];
    const methodFilter = flags.method?.toUpperCase();
    const filtered = methodFilter
      ? actions.filter((a: any) => a.method?.toUpperCase() === methodFilter)
      : actions;
    if (filtered.length === 0) {
      err(`no endpoint found for method "${methodFilter}" in action "${id}"`);
    }

    if (flags.code) {
      if (filtered.length > 1) {
        process.stderr.write(
          `Warning: action "${id}" has ${filtered.length} endpoints; using method "${(filtered[0] as any).method}". Use --method to select a specific one.\n`,
        );
      }
      const action = filtered[0] as any;
      const { method: _schemaMethod, ...cleanCodeInput } = buildDefaultInput(action.input ?? {});
      const result = generateCode(flags.code, { actionId: id, input: cleanCodeInput, actionHost: cfg.actionHost, method: action.method });
      outputCode(result, flags);
      return;
    }

    output(filtered.length === 1 ? filtered[0] : filtered, flags.format as any);
  } catch (e: any) {
    err('get failed', e.message);
  }
}

export async function actionCall(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, CALL_HELP);
  const id = args[0];
  if (!id) err('usage: xapi call <id> --input \'{"key":"val"}\'');
  if (flags.code) validateCodeFlag(flags);
  const cfg = getConfig();
  let input: Record<string, unknown> = {};
  if (flags.input) {
    try {
      input = JSON.parse(flags.input);
    } catch {
      err('--input must be valid JSON');
    }
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      err('--input must be a JSON object');
    }
  }
  // method 作为独立参数传递，兼容 input 内的 method
  const { method: inputMethod, ...cleanInput } = input;
  const method = flags.method?.toUpperCase()
    || (typeof inputMethod === 'string' ? inputMethod.toUpperCase() : undefined);

  if (flags.code) {
    const result = generateCode(flags.code, { actionId: id, input: cleanInput, actionHost: cfg.actionHost, method });
    outputCode(result, flags);
    return;
  }

  requireApiKey(cfg);
  try {
    const res = await client.actionCall(id, cleanInput, cfg, method);
    output(res, flags.format as any);
  } catch (e: any) {
    err('call failed', e.message);
  }
}
