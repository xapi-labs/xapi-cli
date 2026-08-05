/**
 * Top-level action commands: list, search, categories, services, get, get-batch, call
 * Unified interface for all actions (capabilities + APIs).
 * Use --source capability|api to filter by source type.
 */

import { getConfig, requireApiKey } from '../config.ts';
import * as client from '../client.ts';
import { output, err, getFormat } from '../format.ts';
import { generateCode, buildDefaultInput, resolveTarget } from '../codegen.ts';

const VALID_SOURCES = ['capability', 'api'];
const VALID_SEARCH_SORTS = ['default', 'relevance', 'price'] as const;
type SearchSort = (typeof VALID_SEARCH_SORTS)[number];

// ── Subcommand help texts ────────────────────────────────────────────────────

const LIST_HELP = `xapi-to list - List all actions

USAGE
  xapi-to list [flags]

FLAGS
  --source capability|api   Filter by source type
  --category <name>         Filter by category
  --service-id <id>         Filter by service
  --page N                  Page number (default: 1)
  --page-size N             Results per page
  --format json|pretty|table  Output format

EXAMPLES
  xapi-to list
  xapi-to list --source api --format table
  xapi-to list --category social --page 2
`;

const SEARCH_HELP = `xapi-to search - Search actions by keyword

USAGE
  xapi-to search <query> [flags]

FLAGS
  --source capability|api   Filter by source type
  --category <name>         Filter by category
  --page N                  Page number (default: 1)
  --page-size N             Results per page
  --sort default|relevance|price
                            Recommended (default), strongest match, or lowest
                            comparable price after exact-id/local-match guards
  --include-all-versions    Include active non-default major versions
  --format json|pretty|table  Output format

EXAMPLES
  xapi-to search twitter
  xapi-to search "tweet detail" --source api
  xapi-to search "tweet detail" --sort relevance
  xapi-to search weather --sort price
  xapi-to search weather --category utility --format table
  xapi-to search twitter --include-all-versions
`;

const CATEGORIES_HELP = `xapi-to categories - List action categories

USAGE
  xapi-to categories [flags]

FLAGS
  --source capability|api   Filter by source type
  --format json|pretty|table  Output format
`;

const SERVICES_HELP = `xapi-to services - List services

USAGE
  xapi-to services [flags]

FLAGS
  --category <name>         Filter by category
  --page N                  Page number
  --page-size N             Results per page
  --format json|pretty|table  Output format
`;

const GET_BATCH_HELP = `xapi-to get-batch - Get multiple action schemas

USAGE
  xapi-to get-batch <id> [id ...] [flags]

FLAGS
  --format json|pretty|table  Output format

EXAMPLES
  xapi-to get-batch twitter.tweet_detail crypto.token.price
`;

const GET_HELP = `xapi-to get - Get action schema

USAGE
  xapi-to get <id> [flags]

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
  xapi-to get twitter.tweet_detail
  xapi-to get twitter.tweet_detail --method POST
  xapi-to get twitter.tweet_detail --code curl
  xapi-to get twitter.tweet_detail --code python.httpx --format pretty
`;

const CALL_HELP = `xapi-to call - Execute an action

USAGE
  xapi-to call <id> --input '{"key":"val"}' [flags]

FLAGS
  --input <json>            Input payload as JSON (required for execution)
  --method GET|POST|...     Override HTTP method
  --output <path>           Save a raw binary response to a new file
  --stream                  Forward the action's HTTP SSE response unchanged
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
  xapi-to call twitter.tweet_detail --input '{"tweet_id":"1234567890"}'
  xapi-to call openrouter.audio_speech --input '{"body":{"input":"Hello"}}' --output speech.mp3
  xapi-to call ai.text.chat.fast --input '{"messages":[{"role":"user","content":"Hello"}]}' --stream
  xapi-to call twitter.tweet_detail --input '{"tweet_id":"123"}' --code py
  xapi-to call twitter.tweet_detail --input '{"tweet_id":"123"}' --code curl --format pretty
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

function getSearchSort(flags: Record<string, string>): SearchSort | undefined {
  const value = flags.sort;
  if (value === undefined) return undefined;
  if (value === 'true') {
    err('--sort requires a value: default, relevance, or price');
  }
  if (!VALID_SEARCH_SORTS.includes(value as SearchSort)) {
    err(`invalid --sort value: "${value}". Must be default, relevance, or price.`);
  }
  return value as SearchSort;
}

function positiveIntegerFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    err(`${name} must be a positive integer`);
  }
  return Number(value);
}

function httpMethodFlag(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || !/^[A-Za-z]+$/.test(value)) {
    err('--method requires an HTTP method, e.g. --method POST');
  }
  return value.toUpperCase();
}

export async function actionList(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, LIST_HELP);
  const cfg = getConfig();
  const fmt = flags.format || getFormat();
  try {
    const res = await client.actionList(cfg, {
      source: getSource(flags),
      page: positiveIntegerFlag(flags.page, '--page'),
      page_size: positiveIntegerFlag(flags['page-size'], '--page-size'),
      category: flags.category,
      service_id: flags['service-id'],
    });
    const actions = (res.actions || []) as any[];
    if (fmt === 'table') {
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
  if (!query) err('usage: xapi-to search <query>');
  const requestedSort = getSearchSort(flags);
  const cfg = getConfig();
  const fmt = flags.format || getFormat();
  try {
    const res = await client.actionSearch(query, cfg, {
      source: getSource(flags),
      category: flags.category,
      page: positiveIntegerFlag(flags.page, '--page'),
      page_size: positiveIntegerFlag(flags['page-size'], '--page-size'),
      include_all_versions: flags['include-all-versions'] === 'true',
      sort: requestedSort,
    });
    if (requestedSort && res.sort !== requestedSort) {
      throw new Error(
        res.sort
          ? `backend applied sort "${res.sort}" instead of requested "${requestedSort}"`
          : 'backend does not support search sorting yet; deploy the updated backend before using --sort',
      );
    }
    const results = (res.results || []) as any[];
    if (fmt === 'table') {
      output(results.map((a: any) => ({
        id: a.id,
        method: a.method ?? '',
        displayName: a.displayName ?? '',
        source: a.source ?? '',
        category: a.meta?.category ?? '',
        status: a.status ?? '',
        price: a.meta?.pricing?.comparable
          ? a.meta.pricing.listed_price
          : '',
        pricing: a.meta?.pricing?.billing_type ?? '',
      })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('search failed', e.message);
  }
}

export async function actionCategories(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, CATEGORIES_HELP);
  const cfg = getConfig();
  const fmt = flags.format || getFormat();
  try {
    const res = await client.actionCategories(cfg, { source: getSource(flags) });
    if (fmt === 'table') {
      output(res.categories.map(c => ({ category: c })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('categories failed', e.message);
  }
}

export async function actionServices(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, SERVICES_HELP);
  const cfg = getConfig();
  const fmt = flags.format || getFormat();
  try {
    const res = await client.actionServices(cfg, {
      page: positiveIntegerFlag(flags.page, '--page'),
      page_size: positiveIntegerFlag(flags['page-size'], '--page-size'),
      category: flags.category,
    });
    const services = (res.services || []) as any[];
    if (fmt === 'table') {
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
  if (!id) err('usage: xapi-to get <id> [--method GET|POST|DELETE|...]');
  if (flags.code) validateCodeFlag(flags);
  const methodFilter = httpMethodFlag(flags.method);
  const cfg = getConfig();
  try {
    const res = await client.actionGet(id, cfg);
    const actions = Array.isArray(res) ? res : [res];
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

export async function actionBatchGet(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, GET_BATCH_HELP);
  if (args.length === 0) err('usage: xapi-to get-batch <id> [id ...]');
  if (args.length > 100) err('get-batch accepts at most 100 action IDs');
  const cfg = getConfig();
  try {
    const res = await client.actionBatch(args, cfg);
    output(res, flags.format as any);
  } catch (e: any) {
    err('get-batch failed', e.message);
  }
}

export async function actionCall(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, CALL_HELP);
  const id = args[0];
  if (!id) err('usage: xapi-to call <id> --input \'{"key":"val"}\'');
  if (flags.code) validateCodeFlag(flags);
  if (flags.output === 'true') err('--output requires a file path');
  const stream = flags.stream === 'true' || flags.stream === '1' || flags.stream === 'yes';
  if (flags.code && flags.output) {
    err('--output cannot be combined with --code');
  }
  if (stream && flags.output) err('--stream cannot be combined with --output');
  if (stream && flags.code) err('--stream cannot be combined with --code');
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
  const method = httpMethodFlag(flags.method)
    || (typeof inputMethod === 'string' ? inputMethod.toUpperCase() : undefined);

  if (flags.code) {
    const result = generateCode(flags.code, { actionId: id, input: cleanInput, actionHost: cfg.actionHost, method });
    outputCode(result, flags);
    return;
  }

  requireApiKey(cfg);
  try {
    if (stream) {
      await client.actionStream(id, cleanInput, cfg, method);
      return;
    }
    if (flags.output) {
      const result = await client.actionDownload(
        id,
        cleanInput,
        cfg,
        flags.output,
        method,
      );
      output(
        {
          success: true,
          output: result.output,
          bytes: result.bytes,
          status: result.status,
          content_type: result.contentType,
          content_disposition: result.contentDisposition,
        },
        flags.format as any,
      );
      return;
    }
    const res = await client.actionCall(id, cleanInput, cfg, method);
    output(res, flags.format as any);
  } catch (e: any) {
    err('call failed', e.message);
  }
}
