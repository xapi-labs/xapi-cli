/**
 * HTTP client - thin wrapper around fetch with timeout/retry
 */

import { scheme, assertAllowedHost } from './config.ts';

const DEFAULT_TIMEOUT_MS = 30_000;
const EXECUTE_TIMEOUT_MS = 60_000;

// Retry policy for transient failures (exponential backoff with jitter).
// request() defaults to 0 retries (fail-safe): retrying a non-idempotent write
// after a lost response can duplicate a tweet/payment or turn a successful DELETE
// into a spurious 404. Only call sites known to be idempotent (GET reads) opt in.
const IDEMPOTENT_RETRIES = 2;       // up to 3 attempts total
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

export interface ClientOptions {
  actionHost: string;
  apiKey?: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    detail: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status}: ${detail}`);
    this.name = 'HttpError';
  }
}

export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

/**
 * Retryable HTTP statuses. Deliberately conservative: 429 (rate limited — the
 * request was rejected, not processed) and 502/503/504 (gateway/availability
 * errors — the request almost certainly never reached the upstream). 500/501 are
 * excluded because a non-idempotent action (e.g. posting a tweet) may already
 * have taken effect, so a blind retry could duplicate it.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

/** Connection-level failures worth retrying (DNS/reset/refused). Excludes our own timeouts. */
function isRetryableNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e instanceof HttpError || e instanceof RequestTimeoutError) return false;
  if (e.name === 'AbortError') return false;
  return e instanceof TypeError || /network|fetch failed|econn|etimedout|eai_again|socket|dns/i.test(e.message);
}

/** Whether an idempotent caller may safely try the request again. */
export function isRetryableRequestError(e: unknown): boolean {
  if (e instanceof HttpError) return isRetryableStatus(e.status);
  if (e instanceof RequestTimeoutError) return true;
  return isRetryableNetworkError(e);
}

function retryBaseDelayMs(): number {
  const override = Number(process.env.XAPI_RETRY_BASE_MS);
  return Number.isFinite(override) && override > 0 ? override : RETRY_BASE_DELAY_MS;
}

/** Exponential backoff with half-jitter, honoring a server Retry-After when present. */
function backoffDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, RETRY_MAX_DELAY_MS);
  }
  const capped = Math.min(retryBaseDelayMs() * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return capped / 2 + Math.random() * (capped / 2);
}

function parseRetryAfterMs(res: Response): number | undefined {
  const header = res.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function request<T>(
  url: string,
  options: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = 0,
): Promise<T> {
  // Enforce the host allowlist before the API key ever leaves the machine.
  assertAllowedHost(url);

  let attempt = 0;
  while (true) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      // redirect: 'manual' — never auto-follow. fetch forwards custom headers
      // (including XAPI-Key) across redirects, which would carry the API key to a
      // host outside the allowlist. The xapi API never legitimately redirects.
      const res = await fetch(url, { ...options, redirect: 'manual', signal: controller.signal });
      if (res.status >= 300 && res.status < 400) {
        throw new Error(
          `refusing to follow redirect to "${res.headers.get('location') ?? '?'}" `
          + '(would forward the API key past the host allowlist)',
        );
      }
      if (!res.ok) {
        const retryAfterMs = isRetryableStatus(res.status) ? parseRetryAfterMs(res) : undefined;
        if (isRetryableStatus(res.status) && attempt < retries) {
          await res.text().catch(() => ''); // drain body so the socket can be reused
          clearTimeout(timer);
          await sleep(backoffDelayMs(attempt, retryAfterMs));
          attempt++;
          continue;
        }
        const text = await res.text();
        throw new HttpError(res.status, text.slice(0, 300), retryAfterMs);
      }
      if (res.status === 204) {
        return undefined as T;
      }
      const text = await res.text();
      if (!text.trim()) {
        return undefined as T;
      }
      const body = JSON.parse(text) as T;
      // Detect business-level auth errors (HTTP 200 but unauthorized)
      if (body && typeof body === 'object' && 'success' in body && (body as any).success === false) {
        const data = (body as any).data;
        if (data?.statusCode === 401 || data?.error === 'Unauthorized') {
          throw new Error(
            'Authentication failed: ' + (data.message || 'Invalid or missing API key')
            + '. Run "npx xapi-to config set apiKey=<key>" to update your key.',
          );
        }
        if (data?.error === 'OAuth Required' || (data?.statusCode === 403 && data?.message?.includes('OAuth'))) {
          throw new Error(
            (data.message || 'OAuth authorization required')
            + '. Run "xapi-to oauth bind" to connect your account.',
          );
        }
      }
      return body;
    } catch (e) {
      if (timedOut) {
        throw new RequestTimeoutError(timeoutMs);
      }
      if (isRetryableNetworkError(e) && attempt < retries) {
        clearTimeout(timer);
        await sleep(backoffDelayMs(attempt));
        attempt++;
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
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
    DEFAULT_TIMEOUT_MS,
    IDEMPOTENT_RETRIES,
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
    DEFAULT_TIMEOUT_MS,
    IDEMPOTENT_RETRIES,
  );
}

export async function actionCategories(opts: ClientOptions, params: { source?: string } = {}) {
  const url = new URL(`${baseUrl(opts)}/v1/actions/categories`);
  if (params.source) url.searchParams.set('source', params.source);
  return request<{ categories: string[]; total: number }>(
    url.toString(),
    { method: 'GET', headers: headers(opts.apiKey) },
    DEFAULT_TIMEOUT_MS,
    IDEMPOTENT_RETRIES,
  );
}

export async function actionGet(id: string, opts: ClientOptions) {
  return request<unknown[]>(
    `${baseUrl(opts)}/v1/actions/${encodeURIComponent(id)}`,
    { method: 'GET', headers: headers(opts.apiKey) },
    DEFAULT_TIMEOUT_MS,
    IDEMPOTENT_RETRIES,
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
    DEFAULT_TIMEOUT_MS,
    IDEMPOTENT_RETRIES, // read-only metadata fetch — safe to retry
  );
}

export async function actionCall(
  actionId: string,
  input: Record<string, unknown>,
  opts: ClientOptions,
  httpMethod?: string,
  // Default 0: the execute endpoint dispatches arbitrary actions, some of which
  // are non-idempotent writes (posting a tweet, a payment). A gateway 5xx or a
  // dropped connection does NOT prove the upstream didn't run, so a blind retry
  // could duplicate the effect. Callers invoking a known-idempotent action
  // (e.g. task.poll) may opt into retries explicitly.
  retries = 0,
  // Per-request timeout. Capped at EXECUTE_TIMEOUT_MS so a caller (e.g. `task wait`)
  // can shrink it to a remaining deadline but never extend it past the hard ceiling.
  timeoutMs = EXECUTE_TIMEOUT_MS,
) {
  return request<unknown>(
    `${baseUrl(opts)}/v1/actions/execute`,
    {
      method: 'POST',
      headers: headers(opts.apiKey),
      body: JSON.stringify({ action_id: actionId, ...(httpMethod ? { method: httpMethod } : {}), input }),
    },
    Math.min(timeoutMs, EXECUTE_TIMEOUT_MS),
    retries,
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
    DEFAULT_TIMEOUT_MS,
    IDEMPOTENT_RETRIES,
  );
}

export async function healthCheck(opts: ClientOptions) {
  return request<unknown>(
    `${baseUrl(opts)}/health`,
    { method: 'GET', headers: headers(opts.apiKey) },
    5_000,
    0, // health is a quick connectivity probe — fail fast, don't retry
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
    DEFAULT_TIMEOUT_MS,
    IDEMPOTENT_RETRIES, // auth exchange has no side effect — safe to retry
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
    DEFAULT_TIMEOUT_MS,
    IDEMPOTENT_RETRIES,
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

export interface ScopeDefinition {
  scope: string;
  label: string;
  description: string;
  required: boolean;
  category: string;
}

export interface OAuthProvider {
  id: string;
  name: string;
  type: string;
  grantType: string;
  defaultScopes: string;
  scopeDefinitions: ScopeDefinition[] | null;
}

export async function listOAuthProviders(apiHost: string) {
  return request<OAuthProvider[]>(
    `${scheme(apiHost)}://${apiHost}/api/oauth/providers`,
    { method: 'GET', headers: { 'Content-Type': 'application/json' } },
    DEFAULT_TIMEOUT_MS,
    IDEMPOTENT_RETRIES,
  );
}

export async function initiateOAuth(
  apiKeyId: string,
  providerId: string,
  jwtToken: string,
  apiHost: string,
  scopes?: string,
) {
  const body: Record<string, string> = { apiKeyId, providerId };
  if (scopes) body.scopes = scopes;
  return request<{ authorizationUrl: string; state: string }>(
    `${scheme(apiHost)}://${apiHost}/api/oauth/authorize`,
    {
      method: 'POST',
      headers: jwtHeaders(jwtToken),
      body: JSON.stringify(body),
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
    DEFAULT_TIMEOUT_MS,
    IDEMPOTENT_RETRIES,
  );
}

export async function deleteOAuthBinding(
  bindingId: string,
  jwtToken: string,
  apiHost: string,
) {
  const result = await request<{ success: boolean } | undefined>(
    `${scheme(apiHost)}://${apiHost}/api/oauth/bindings/${bindingId}`,
    { method: 'DELETE', headers: jwtHeaders(jwtToken) },
  );
  return result ?? { success: true };
}
