/**
 * HTTP client - thin wrapper around fetch with timeout/retry
 */

import { scheme } from './config.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const EXECUTE_TIMEOUT_MS = 60_000;

export interface ClientOptions {
  capabilityHost: string;
  apiKey?: string;
}

export async function request<T>(
  url: string,
  options: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h['XAPI-Key'] = apiKey;
  return h;
}

// ── Capabilities ──────────────────────────────────────────────────────────────

export async function capList(opts: ClientOptions) {
  return request<{ capabilities: unknown[] }>(
    `${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/caps`,
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function capSearch(query: string, opts: ClientOptions) {
  const url = `${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/caps/search?q=${encodeURIComponent(query)}`;
  return request<{ results?: unknown[]; capabilities?: unknown[] }>(
    url,
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function capGet(id: string, opts: ClientOptions) {
  return request<unknown>(
    `${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/caps/${encodeURIComponent(id)}`,
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function capCall(
  capabilityId: string,
  input: Record<string, unknown>,
  opts: ClientOptions,
) {
  return request<unknown>(
    `${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/caps/execute`,
    {
      method: 'POST',
      headers: headers(opts.apiKey),
      body: JSON.stringify({ capability_id: capabilityId, input }),
    },
    EXECUTE_TIMEOUT_MS,
  );
}

// ── APIs ──────────────────────────────────────────────────────────────────────

export async function apiList(
  opts: ClientOptions,
  params: { page?: number; page_size?: number; category?: string } = {},
) {
  const url = new URL(`${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/apis`);
  if (params.page) url.searchParams.set('page', String(params.page));
  if (params.page_size) url.searchParams.set('page_size', String(params.page_size));
  if (params.category) url.searchParams.set('category', params.category);
  return request<{ apis: unknown[]; pagination: unknown }>(
    url.toString(),
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function apiSearch(
  query: string,
  opts: ClientOptions,
  params: { category?: string; limit?: number } = {},
) {
  const url = new URL(`${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/apis/search`);
  url.searchParams.set('q', query);
  if (params.category) url.searchParams.set('category', params.category);
  if (params.limit) url.searchParams.set('limit', String(params.limit));
  return request<{ results: unknown[]; total_matches: number; query: string }>(
    url.toString(),
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function apiCategories(opts: ClientOptions) {
  return request<{ categories: string[]; total: number }>(
    `${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/apis/categories`,
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function apiGet(id: string, opts: ClientOptions) {
  return request<unknown>(
    `${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/apis/${encodeURIComponent(id)}`,
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function apiBatch(ids: string[], opts: ClientOptions) {
  return request<{ apis: unknown[] }>(
    `${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/apis/batch`,
    {
      method: 'POST',
      headers: headers(opts.apiKey),
      body: JSON.stringify({ ids }),
    },
  );
}

export async function apiCall(
  apiId: string,
  input: Record<string, unknown>,
  opts: ClientOptions,
) {
  return request<unknown>(
    `${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/apis/execute`,
    {
      method: 'POST',
      headers: headers(opts.apiKey),
      body: JSON.stringify({ api_id: apiId, input }),
    },
    EXECUTE_TIMEOUT_MS,
  );
}

export async function healthCheck(opts: ClientOptions) {
  return request<unknown>(
    `${scheme(opts.capabilityHost)}://${opts.capabilityHost}/v1/caps`,
    { method: 'GET', headers: headers(opts.apiKey) },
    5_000,
  );
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export async function loginWithApiKey(apiKey: string, apiHost: string) {
  return request<{ accessToken: string; user: unknown }>(
    `${scheme(apiHost)}://${apiHost}/api/auth/login/apikey`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    },
  );
}
