/**
 * api commands: list, search, categories, get, batch, call
 */

import { getConfig, requireApiKey } from '../config.ts';
import * as client from '../client.ts';
import { output, err } from '../format.ts';

/** Parse a CLI value: JSON objects/arrays/booleans are parsed, everything else stays as string */
function parseValue(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null') return null;
  if (v.startsWith('{') || v.startsWith('[')) {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

export async function apiList(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();
  try {
    const res = await client.apiList(cfg, {
      page: flags.page ? parseInt(flags.page) : undefined,
      page_size: flags['page-size'] ? parseInt(flags['page-size']) : undefined,
      category: flags.category,
    });
    const apis = (res.apis || []) as any[];
    if (flags.format === 'table') {
      output(apis.map((a: any) => ({
        id: a.uuid || a.id,
        title: a.meta?.title ?? '',
        category: a.meta?.category ?? '',
        status: a.status ?? '',
        cost: a.meta?.cost ?? '',
      })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('api list failed', e.message);
  }
}

export async function apiSearch(args: string[], flags: Record<string, string>) {
  const query = args[0];
  if (!query) err('usage: xapi api search <query>');
  const cfg = getConfig();
  try {
    const res = await client.apiSearch(query, cfg, {
      category: flags.category,
      limit: flags.limit ? parseInt(flags.limit) : undefined,
    });
    const results = (res.results || []) as any[];
    if (flags.format === 'table') {
      output(results.map((a: any) => ({
        id: a.uuid || a.id,
        title: a.meta?.title ?? '',
        category: a.meta?.category ?? '',
        status: a.status ?? '',
      })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('api search failed', e.message);
  }
}

export async function apiCategories(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();
  try {
    const res = await client.apiCategories(cfg);
    if (flags.format === 'table') {
      output(res.categories.map(c => ({ category: c })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('api categories failed', e.message);
  }
}

export async function apiGet(args: string[], flags: Record<string, string>) {
  const ids = args;
  if (ids.length === 0) err('usage: xapi api get <id> [id2 ...]');
  const cfg = getConfig();
  try {
    if (ids.length === 1) {
      const res = await client.apiGet(ids[0], cfg);
      output(res, flags.format as any);
    } else {
      const res = await client.apiBatch(ids, cfg);
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('api get failed', e.message);
  }
}

export async function apiCall(args: string[], flags: Record<string, string>) {
  const id = args[0];
  if (!id) err('usage: xapi api call <id> [--input \'{"key":"val"}\'] [key=val ...]');
  const cfg = getConfig();
  requireApiKey(cfg);
  let input: Record<string, unknown> = {};
  if (flags.input) {
    try {
      input = JSON.parse(flags.input);
    } catch {
      err('--input must be valid JSON');
    }
  }
  for (const arg of args.slice(1)) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      const k = arg.slice(0, eq);
      const v = arg.slice(eq + 1);
      input[k] = parseValue(v);
    }
  }
  try {
    const res = await client.apiCall(id, input, cfg);
    output(res, flags.format as any);
  } catch (e: any) {
    err('api call failed', e.message);
  }
}
