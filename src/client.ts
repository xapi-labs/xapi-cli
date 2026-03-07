/**
 * HTTP client - thin wrapper around fetch with timeout/retry
 */

import { scheme } from './config.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const EXECUTE_TIMEOUT_MS = 60_000;

export interface ClientOptions {
  actionHost: string;
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
    const body = await res.json() as T;
    // Detect business-level auth errors (HTTP 200 but unauthorized)
    if (body && typeof body === 'object' && 'success' in body && (body as any).success === false) {
      const data = (body as any).data;
      if (data?.statusCode === 401 || data?.error === 'Unauthorized') {
        throw new Error(
          'Authentication failed: ' + (data.message || 'Invalid or missing API key')
          + '. Run "npx @xapi-to/xapi config set apiKey=<key>" to update your key.',
        );
      }
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h['XAPI-Key'] = apiKey;
  return h;
}

function baseUrl(opts: ClientOptions): string {
  return `${scheme(opts.actionHost)}://${opts.actionHost}`;
}

// ── Actions (unified: capabilities + APIs) ───────────────────────────────────

export async function actionList(
  opts: ClientOptions,
  params: { page?: number; page_size?: number; category?: string; source?: string; service_id?: string } = {},
) {
  const url = new URL(`${baseUrl(opts)}/v1/actions`);
  if (params.page) url.searchParams.set('page', String(params.page));
  if (params.page_size) url.searchParams.set('page_size', String(params.page_size));
  if (params.category) url.searchParams.set('category', params.category);
  if (params.source) url.searchParams.set('source', params.source);
  if (params.service_id) url.searchParams.set('service_id', params.service_id);
  return request<{ actions: unknown[]; pagination: unknown }>(
    url.toString(),
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function actionSearch(
  query: string,
  opts: ClientOptions,
  params: { category?: string; source?: string; page?: number; page_size?: number } = {},
) {
  const url = new URL(`${baseUrl(opts)}/v1/actions/search`);
  url.searchParams.set('q', query);
  if (params.category) url.searchParams.set('category', params.category);
  if (params.source) url.searchParams.set('source', params.source);
  if (params.page) url.searchParams.set('page', String(params.page));
  if (params.page_size) url.searchParams.set('page_size', String(params.page_size));
  return request<{ results: unknown[]; query: string; pagination: unknown }>(
    url.toString(),
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function actionCategories(opts: ClientOptions, params: { source?: string } = {}) {
  const url = new URL(`${baseUrl(opts)}/v1/actions/categories`);
  if (params.source) url.searchParams.set('source', params.source);
  return request<{ categories: string[]; total: number }>(
    url.toString(),
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function actionGet(id: string, opts: ClientOptions) {
  return request<unknown>(
    `${baseUrl(opts)}/v1/actions/${encodeURIComponent(id)}`,
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function actionBatch(ids: string[], opts: ClientOptions) {
  return request<{ actions: unknown[]; missing_ids: string[] }>(
    `${baseUrl(opts)}/v1/actions/batch`,
    {
      method: 'POST',
      headers: headers(opts.apiKey),
      body: JSON.stringify({ ids }),
    },
  );
}

export async function actionCall(
  actionId: string,
  input: Record<string, unknown>,
  opts: ClientOptions,
) {
  return request<unknown>(
    `${baseUrl(opts)}/v1/actions/execute`,
    {
      method: 'POST',
      headers: headers(opts.apiKey),
      body: JSON.stringify({ action_id: actionId, input }),
    },
    EXECUTE_TIMEOUT_MS,
  );
}

export async function actionServices(
  opts: ClientOptions,
  params: { page?: number; page_size?: number; category?: string } = {},
) {
  const url = new URL(`${baseUrl(opts)}/v1/actions/services`);
  if (params.page) url.searchParams.set('page', String(params.page));
  if (params.page_size) url.searchParams.set('page_size', String(params.page_size));
  if (params.category) url.searchParams.set('category', params.category);
  return request<{ services: unknown[]; pagination: unknown }>(
    url.toString(),
    { method: 'GET', headers: headers(opts.apiKey) },
  );
}

export async function healthCheck(opts: ClientOptions) {
  return request<unknown>(
    `${baseUrl(opts)}/v1/actions`,
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

// ── OAuth ──────────────────────────────────────────────────────────────────────

function jwtHeaders(jwtToken: string): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${jwtToken}` };
}

export async function listKeys(jwtToken: string, apiHost: string) {
  return request<Array<{
    id: string;
    name: string;
    keyPreview: string;
    oauthEnabled: boolean;
    createdAt: string;
  }>>(
    `${scheme(apiHost)}://${apiHost}/api/keys`,
    { method: 'GET', headers: jwtHeaders(jwtToken) },
  );
}

export async function enableOAuthForKey(
  keyId: string,
  plaintextKey: string,
  jwtToken: string,
  apiHost: string,
) {
  return request<{ success: boolean; message: string }>(
    `${scheme(apiHost)}://${apiHost}/api/keys/${keyId}/enable-oauth`,
    {
      method: 'POST',
      headers: jwtHeaders(jwtToken),
      body: JSON.stringify({ plaintextKey }),
    },
  );
}

export async function listOAuthProviders(apiHost: string) {
  return request<Array<{
    id: string;
    name: string;
    type: string;
    grantType: string;
    defaultScopes: string;
  }>>(
    `${scheme(apiHost)}://${apiHost}/api/oauth/providers`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
  );
}

export async function initiateOAuth(
  apiKeyId: string,
  providerId: string,
  jwtToken: string,
  apiHost: string,
) {
  return request<{ authorizationUrl: string; state: string }>(
    `${scheme(apiHost)}://${apiHost}/api/oauth/authorize`,
    {
      method: 'POST',
      headers: jwtHeaders(jwtToken),
      body: JSON.stringify({ apiKeyId, providerId }),
    },
  );
}

export async function listOAuthBindings(jwtToken: string, apiHost: string) {
  return request<Array<{
    id: string;
    apiKeyId: string;
    providerId: string;
    providerAccountId: string;
    providerAccountName: string | null;
    scopes: string;
    createdAt: string;
    updatedAt: string;
    provider: { id: string; name: string; type: string };
  }>>(
    `${scheme(apiHost)}://${apiHost}/api/oauth/bindings`,
    { method: 'GET', headers: jwtHeaders(jwtToken) },
  );
}

export async function deleteOAuthBinding(
  bindingId: string,
  jwtToken: string,
  apiHost: string,
) {
  return request<{ success: boolean }>(
    `${scheme(apiHost)}://${apiHost}/api/oauth/bindings/${bindingId}`,
    { method: 'DELETE', headers: jwtHeaders(jwtToken) },
  );
}
