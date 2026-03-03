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
  if (fmt === 'table' && Array.isArray(data)) {
    printTable(data as Record<string, unknown>[]);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function printTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log('(empty)');
    return;
  }
  const keys = Object.keys(rows[0]);
  const widths = keys.map(k =>
    Math.min(40, Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length)))
  );
  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  console.log(header);
  console.log(sep);
  for (const row of rows) {
    const line = keys.map((k, i) => String(row[k] ?? '').slice(0, widths[i]).padEnd(widths[i])).join('  ');
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
