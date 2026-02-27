/**
 * cap commands: list, search, get, call
 */

import { getConfig } from '../config.ts';
import * as client from '../client.ts';
import { output, err } from '../format.ts';

export async function capList(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();
  try {
    const res = await client.capList(cfg);
    const caps = res.capabilities || [];
    if (flags.format === 'table') {
      output(caps.map((c: any) => ({
        id: c.id,
        title: c.meta?.title ?? '',
        status: c.status ?? '',
        cost: c.meta?.cost ?? '',
      })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('cap list failed', e.message);
  }
}

export async function capSearch(args: string[], flags: Record<string, string>) {
  const query = args[0];
  if (!query) err('usage: xapi cap search <query>');
  const cfg = getConfig();
  try {
    const res = await client.capSearch(query, cfg);
    const items = res.results || res.capabilities || [];
    if (flags.format === 'table') {
      output(items.map((c: any) => ({
        id: c.id,
        title: c.meta?.title ?? '',
        status: c.status ?? '',
      })), 'table');
    } else {
      output(res, flags.format as any);
    }
  } catch (e: any) {
    err('cap search failed', e.message);
  }
}

export async function capGet(args: string[], flags: Record<string, string>) {
  const id = args[0];
  if (!id) err('usage: xapi cap get <id>');
  const cfg = getConfig();
  try {
    const res = await client.capGet(id, cfg);
    output(res, flags.format as any);
  } catch (e: any) {
    err('cap get failed', e.message);
  }
}

export async function capCall(args: string[], flags: Record<string, string>) {
  const id = args[0];
  if (!id) err('usage: xapi cap call <id> [--input \'{"key":"val"}\']');
  const cfg = getConfig();
  let input: Record<string, unknown> = {};
  if (flags.input) {
    try {
      input = JSON.parse(flags.input);
    } catch {
      err('--input must be valid JSON');
    }
  }
  // also support positional key=value pairs after the id
  for (const arg of args.slice(1)) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      const k = arg.slice(0, eq);
      const v = arg.slice(eq + 1);
      try { input[k] = JSON.parse(v); } catch { input[k] = v; }
    }
  }
  try {
    const res = await client.capCall(id, input, cfg);
    output(res, flags.format as any);
  } catch (e: any) {
    err('cap call failed', e.message);
  }
}
