/**
 * Code snippet generation for API actions.
 *
 * Generates executable code in curl, Python, JavaScript, TypeScript, and Go
 * that calls the xapi action execute endpoint.
 */

import { scheme } from './config.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface CodegenParams {
  actionId: string;
  input: Record<string, unknown>;
  actionHost: string;
}

interface ResolvedTarget {
  lang: string;
  lib: string;
}

// ── Target resolution ────────────────────────────────────────────────────────

const TARGET_MAP: Record<string, ResolvedTarget> = {
  'curl':                { lang: 'curl',       lib: 'curl' },
  'python':              { lang: 'python',     lib: 'requests' },
  'py':                  { lang: 'python',     lib: 'requests' },
  'python.requests':     { lang: 'python',     lib: 'requests' },
  'python.httpx':        { lang: 'python',     lib: 'httpx' },
  'py.requests':         { lang: 'python',     lib: 'requests' },
  'py.httpx':            { lang: 'python',     lib: 'httpx' },
  'javascript':          { lang: 'javascript', lib: 'fetch' },
  'js':                  { lang: 'javascript', lib: 'fetch' },
  'javascript.fetch':    { lang: 'javascript', lib: 'fetch' },
  'javascript.axios':    { lang: 'javascript', lib: 'axios' },
  'js.fetch':            { lang: 'javascript', lib: 'fetch' },
  'js.axios':            { lang: 'javascript', lib: 'axios' },
  'typescript':          { lang: 'typescript', lib: 'fetch' },
  'ts':                  { lang: 'typescript', lib: 'fetch' },
  'typescript.fetch':    { lang: 'typescript', lib: 'fetch' },
  'ts.fetch':            { lang: 'typescript', lib: 'fetch' },
  'go':                  { lang: 'go',         lib: 'net/http' },
};

const SUPPORTED_TARGETS = [
  'curl',
  'python (py) [.requests, .httpx]',
  'javascript (js) [.fetch, .axios]',
  'typescript (ts) [.fetch]',
  'go [net/http]',
];

export function resolveTarget(raw: string): ResolvedTarget {
  const target = TARGET_MAP[raw.toLowerCase()];
  if (!target) {
    throw new Error(
      `unknown --code target: "${raw}". Supported: ${SUPPORTED_TARGETS.join(', ')}`,
    );
  }
  return target;
}

// ── Default input builder ────────────────────────────────────────────────────

interface InputSchema {
  properties?: Record<string, { type?: string; default?: unknown }>;
  required?: string[];
}

function typeDefault(type: string): unknown {
  switch (type) {
    case 'string': return '';
    case 'number': case 'integer': return 0;
    case 'boolean': return false;
    case 'object': return {};
    case 'array': return [];
    default: return '';
  }
}

export function buildDefaultInput(schema: InputSchema): Record<string, unknown> {
  if (!schema.properties) return {};
  const result: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (prop.default !== undefined) {
      // Clone reference types to avoid shared mutation
      const val = prop.default;
      result[key] = (typeof val === 'object' && val !== null) ? JSON.parse(JSON.stringify(val)) : val;
    } else {
      result[key] = typeDefault(prop.type ?? 'string');
    }
  }
  return result;
}

// ── Code generators ──────────────────────────────────────────────────────────

const SAFE_HOST_PATTERN = /^[a-zA-Z0-9._\-]+(:\d{1,5})?$/;

function validateHost(host: string): void {
  if (!SAFE_HOST_PATTERN.test(host)) {
    throw new Error(`invalid actionHost: "${host}" — must be a valid hostname with optional port`);
  }
}

function baseUrl(actionHost: string): string {
  validateHost(actionHost);
  return `${scheme(actionHost)}://${actionHost}/v1/actions/execute`;
}

function jsonBody(actionId: string, input: Record<string, unknown>): string {
  return JSON.stringify({ action_id: actionId, input }, null, 2);
}

/** Re-indent a multi-line string so continuation lines are aligned */
function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  const lines = text.split('\n');
  return lines.map((line, i) => (i === 0 ? line : pad + line)).join('\n');
}

/** Escape single quotes for POSIX shell single-quoted strings */
function shellEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

function genCurl(params: CodegenParams): string {
  const url = baseUrl(params.actionHost);
  const body = jsonBody(params.actionId, params.input);
  return [
    '# Set XAPI_KEY env var or replace with your key',
    `curl -X POST '${shellEscape(url)}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H "XAPI-Key: \${XAPI_KEY}" \\`,
    `  -d '${shellEscape(body)}'`,
  ].join('\n');
}

function genPython(lib: 'requests' | 'httpx', params: CodegenParams): string {
  const url = baseUrl(params.actionHost);
  const payload = { action_id: params.actionId, input: params.input };
  return [
    `# pip install ${lib}`,
    '# Set XAPI_KEY env var or replace with your key',
    'import os',
    `import ${lib}`,
    '',
    `resp = ${lib}.post(`,
    `    "${url}",`,
    `    headers={`,
    `        "Content-Type": "application/json",`,
    `        "XAPI-Key": os.environ["XAPI_KEY"],`,
    `    },`,
    `    json=${indent(pythonDict(payload), 4)},`,
    `)`,
    'print(resp.json())',
  ].join('\n');
}

function genJavaScriptFetch(params: CodegenParams): string {
  const url = baseUrl(params.actionHost);
  const body = jsonBody(params.actionId, params.input);
  return [
    '// Set XAPI_KEY env var or replace with your key',
    `const resp = await fetch("${url}", {`,
    `  method: "POST",`,
    `  headers: {`,
    `    "Content-Type": "application/json",`,
    `    "XAPI-Key": process.env.XAPI_KEY,`,
    `  },`,
    `  body: JSON.stringify(${indent(body, 2)}),`,
    `});`,
    'console.log(await resp.json());',
  ].join('\n');
}

function genJavaScriptAxios(params: CodegenParams): string {
  const url = baseUrl(params.actionHost);
  const body = jsonBody(params.actionId, params.input);
  return [
    '// npm install axios',
    '// Set XAPI_KEY env var or replace with your key',
    'import axios from "axios";',
    '',
    `const resp = await axios.post(`,
    `  "${url}",`,
    `  ${indent(body, 2)},`,
    `  {`,
    `    headers: {`,
    `      "Content-Type": "application/json",`,
    `      "XAPI-Key": process.env.XAPI_KEY,`,
    `    },`,
    `  },`,
    `);`,
    'console.log(resp.data);',
  ].join('\n');
}

function genTypescriptFetch(params: CodegenParams): string {
  const url = baseUrl(params.actionHost);
  const body = jsonBody(params.actionId, params.input);
  return [
    '// Set XAPI_KEY env var or replace with your key',
    `const resp: Response = await fetch("${url}", {`,
    `  method: "POST",`,
    `  headers: {`,
    `    "Content-Type": "application/json",`,
    `    "XAPI-Key": process.env.XAPI_KEY!,`,
    `  },`,
    `  body: JSON.stringify(${indent(body, 2)}),`,
    `});`,
    'const data: unknown = await resp.json();',
    'console.log(data);',
  ].join('\n');
}

function genGo(params: CodegenParams): string {
  const url = baseUrl(params.actionHost);
  const body = jsonBody(params.actionId, params.input);
  const escaped = body.replace(/`/g, '` + "`" + `');
  return [
    '// Set XAPI_KEY env var or replace with your key',
    'package main',
    '',
    'import (',
    '\t"fmt"',
    '\t"io"',
    '\t"net/http"',
    '\t"os"',
    '\t"strings"',
    ')',
    '',
    'func main() {',
    `\tbody := \`${escaped}\``,
    `\treq, err := http.NewRequest("POST", "${url}", strings.NewReader(body))`,
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\treq.Header.Set("Content-Type", "application/json")',
    '\treq.Header.Set("XAPI-Key", os.Getenv("XAPI_KEY"))',
    '',
    '\tresp, err := http.DefaultClient.Do(req)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tdefer resp.Body.Close()',
    '',
    '\tresult, err := io.ReadAll(resp.Body)',
    '\tif err != nil {',
    '\t\tpanic(err)',
    '\t}',
    '\tfmt.Println(string(result))',
    '}',
  ].join('\n');
}

// ── Python dict formatter ────────────────────────────────────────────────────

function pythonDict(obj: unknown, depth = 0): string {
  const pad = '    '.repeat(depth);
  const inner = '    '.repeat(depth + 1);

  if (obj === null || obj === undefined) return 'None';
  if (typeof obj === 'boolean') return obj ? 'True' : 'False';
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);

  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const items = obj.map(v => `${inner}${pythonDict(v, depth + 1)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const items = entries.map(
      ([k, v]) => `${inner}${JSON.stringify(k)}: ${pythonDict(v, depth + 1)}`,
    );
    return `{\n${items.join(',\n')}\n${pad}}`;
  }

  return String(obj);
}

// ── Main entry point ─────────────────────────────────────────────────────────

type Generator = (params: CodegenParams) => string;

const GENERATORS: Record<string, Record<string, Generator>> = {
  curl:       { curl: genCurl },
  python:     { requests: p => genPython('requests', p), httpx: p => genPython('httpx', p) },
  javascript: { fetch: genJavaScriptFetch, axios: genJavaScriptAxios },
  typescript: { fetch: genTypescriptFetch },
  go:         { 'net/http': genGo },
};

export function generateCode(target: string, params: CodegenParams): { lang: string; lib: string; code: string } {
  const { lang, lib } = resolveTarget(target);
  const generator = GENERATORS[lang]?.[lib];
  if (!generator) {
    throw new Error(`no generator for ${lang}.${lib}`);
  }
  return { lang, lib, code: generator(params) };
}
