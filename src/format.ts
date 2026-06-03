/**
 * Output formatting
 * Supports: json (default, machine-readable), pretty (human-readable), table
 */

export type OutputFormat = 'json' | 'pretty' | 'table';

export function getFormat(): OutputFormat {
  const f = process.env.XAPI_OUTPUT || 'json';
  if (f === 'pretty' || f === 'table') return f;
  return 'json';
}

export function output(data: unknown, format?: OutputFormat): void {
  const fmt = format || getFormat();
  if (fmt === 'json') {
    console.log(JSON.stringify(data));
    return;
  }
  if (fmt === 'pretty') {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  // table: try to render arrays of objects as a table
  if (fmt === 'table') {
    const rows = tableRows(data);
    if (rows) {
      printTable(rows);
      return;
    }
  }
  console.log(JSON.stringify(data, null, 2));
}

function tableRows(data: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return normalizeRows(data, 'value');
  if (!data || typeof data !== 'object') return null;

  const obj = data as Record<string, unknown>;
  const preferredKeys = ['items', 'actions', 'results', 'services', 'categories', 'bindings', 'providers'];
  for (const key of preferredKeys) {
    const value = obj[key];
    if (Array.isArray(value)) return normalizeRows(value, singularKey(key));
  }

  const firstArray = Object.entries(obj).find(([, value]) => Array.isArray(value));
  return firstArray ? normalizeRows(firstArray[1] as unknown[], singularKey(firstArray[0])) : null;
}

function normalizeRows(rows: unknown[], primitiveKey: string): Record<string, unknown>[] {
  return rows.map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      return row as Record<string, unknown>;
    }
    return { [primitiveKey]: row };
  });
}

function singularKey(key: string): string {
  if (key === 'categories') return 'category';
  if (key.endsWith('ies')) return `${key.slice(0, -3)}y`;
  if (key.endsWith('s')) return key.slice(0, -1);
  return 'value';
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('(empty)');
    return;
  }
  const keys = Object.keys(rows[0]);
  const widths = keys.map(k =>
    Math.min(40, Math.max(k.length, ...rows.map(r => formatCell(r[k]).length)))
  );
  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    const line = keys.map((k, i) => formatCell(row[k]).slice(0, widths[i]).padEnd(widths[i])).join('  ');
    console.log(line);
  }
}

export function err(msg: string, detail?: unknown): never {
  if (process.stderr.isTTY) {
    console.error(`Error: ${msg}`);
    if (detail !== undefined) console.error(`  ${detail}`);
  } else {
    const out: Record<string, unknown> = { error: msg };
    if (detail !== undefined) out.detail = detail;
    console.error(JSON.stringify(out));
  }
  process.exit(1);
}
