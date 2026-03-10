/**
 * Top-level action commands: list, search, categories, services, get, call
 * Unified interface for all actions (capabilities + APIs).
 * Use --source capability|api to filter by source type.
 */

import { getConfig, requireApiKey } from '../config.ts';
import * as client from '../client.ts';
import { output, err } from '../format.ts';

const VALID_SOURCES = ['capability', 'api'];

/** Validate and return source filter from --source flag */
function getSource(flags: Record<string, string>): string | undefined {
  if (!flags.source) return undefined;
  if (!VALID_SOURCES.includes(flags.source)) {
    err(`invalid --source value: "${flags.source}". Must be "capability" or "api".`);
  }
  return flags.source;
}

export async function actionList(args: string[], flags: Record<string, string>) {
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
  const id = args[0];
  if (!id) err('usage: xapi get <id> [--method GET|POST|DELETE|...]');
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
    output(filtered.length === 1 ? filtered[0] : filtered, flags.format as any);
  } catch (e: any) {
    err('get failed', e.message);
  }
}

export async function actionCall(args: string[], flags: Record<string, string>) {
  const id = args[0];
  if (!id) err('usage: xapi call <id> --input \'{"key":"val"}\'');
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
  if (flags.method) {
    input = { ...input, method: flags.method.toUpperCase() };
  }
  try {
    const res = await client.actionCall(id, input, cfg);
    output(res, flags.format as any);
  } catch (e: any) {
    err('call failed', e.message);
  }
}
