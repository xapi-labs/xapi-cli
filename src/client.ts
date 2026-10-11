/**
 * HTTP client - thin wrapper around fetch with timeout/retry
 */

import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici/index.js';
import { scheme, assertAllowedHost } from './config.ts';
import { open, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { requestDeadline } from './request-deadline.ts';

// Node's bundled fetch may speak a newer dispatcher protocol (notably Node 26).
// Only substitute its built-in lazy undici loader; an import-time snapshot can
// already be a preload interceptor. Resolve other globals at call time, and use
// the intrinsic toString so an override's own toString cannot hide that override.
const matchedFetch = undiciFetch as unknown as typeof fetch;
// Snapshot only the proxy option from Node's already validated startup config.
// Config is lower priority than environment/CLI flags and is not in execArgv.
const configEnvironmentProxyEnabled = (() => {
  if (process.versions.bun) return false;
  let path: string | undefined;
  for (const [index, option] of process.execArgv.entries()) {
    if (option.startsWith('--experimental-config-file=')) path = option.slice(option.indexOf('=') + 1);
    else if (option === '--experimental-config-file') path = process.execArgv[index + 1] || 'node.config.json';
    else if (option === '--experimental-default-config-file' && !path) path = 'node.config.json';
  }
  if (!path) return false;
  try {
    const config = JSON.parse(readFileSync(resolve(path), 'utf8'));
    const selected = Array.isArray(config.configs)
      ? config.configs.find((entry: { nodeVersion: number }) => entry.nodeVersion === Number(process.versions.node.split('.')[0]))?.config
      : config;
    return selected?.nodeOptions?.['use-env-proxy'] === true;
  } catch {
    // If the validated file is no longer readable, keep native routing rather
    // than risk bypassing a proxy configured before this module was imported.
    return true;
  }
})();

function nativeEnvironmentProxyEnabled(): boolean {
  if (process.versions.bun || !process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) return false;
  let enabled = configEnvironmentProxyEnabled || process.env.NODE_USE_ENV_PROXY === '1';
  // Node normalizes the existing environment setting and startup flags. CLI
  // flags override NODE_OPTIONS; later positive/negative flags win. Keep quoted
  // NODE_OPTIONS arguments together so a filename cannot look like a flag.
  const envOptions = (process.env.NODE_OPTIONS || '').match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const option of [...envOptions.map(value => value.replace(/"/g, '')), ...process.execArgv]) {
    if (/^--use-env-proxy(?:=|$)/.test(option)) enabled = true;
    else if (/^--no-use-env-proxy(?:=|$)/.test(option)) enabled = false;
  }
  return enabled;
}

function defaultFetch(): typeof fetch {
  const fetcher = globalThis.fetch;
  const source = Function.prototype.toString.call(fetcher);
  const node18Loader = source.replace(/\s+/g, '') ===
    'asyncfunctionfetch(input,init=undefined){returnlazyUndici().fetch(input,init);}';
  // A paired direct Agent would bypass Node's opted-in proxy routing. Preserve
  // native fetch in that mode, with no external dispatcher; Node owns its proxy
  // and NO_PROXY behavior just as it does for a transparent native delegate.
  // Like foreign fetch, its internal parser deadlines remain Node's own; our
  // AbortSignal deadlines do not override those internal deadlines.
  return !nativeEnvironmentProxyEnabled() &&
    (node18Loader || /\brequire\(['"]internal\/deps\/undici\/undici['"]\)/.test(source))
    ? matchedFetch : fetcher;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const EXECUTE_TIMEOUT_MS = 60_000;
const TRANSFER_IDLE_TIMEOUT_MS = 60_000;

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

export interface ApiKeyApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    detail: string,
    public readonly retryAfterMs?: number,
    public readonly responseBody?: unknown,
    options?: ErrorOptions,
  ) {
    super(`HTTP ${status}: ${detail}`, options);
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

function transferIdleTimeoutMs(): number {
  const override = Number(process.env.XAPI_TRANSFER_IDLE_TIMEOUT_MS);
  return Number.isFinite(override) && override > 0
    ? override
    : TRANSFER_IDLE_TIMEOUT_MS;
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

function abortError(signal?: AbortSignal | null): Error {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// A scoped dispatcher prevents fetch from reintroducing
// its own 300-second parser deadlines. The request AbortSignal owns the deadline.
class RequestDeadlineAgent extends Agent {
  progress?: () => void;
  constructor() { super({ headersTimeout: 0, bodyTimeout: 0 }); }
  override dispatch(options: Agent.DispatchOptions, handler: Dispatcher.DispatchHandlers): boolean {
    const progress = this.progress;
    const originalBody = options.body;
    // fetch can serialize JSON as one large chunk. Split only the transport
    // iterator so socket backpressure can report progress on slow uploads too.
    const body = progress && originalBody && (
      typeof originalBody === 'string' || originalBody instanceof Uint8Array ||
      Symbol.asyncIterator in Object(originalBody)
    ) ? Readable.from((async function* () {
      const chunks = typeof originalBody === 'string' || originalBody instanceof Uint8Array
        ? [originalBody] : originalBody as AsyncIterable<Uint8Array>;
      for await (const chunk of chunks) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        for (let offset = 0; offset < bytes.length; offset += 65_536)
          yield bytes.subarray(offset, offset + 65_536);
      }
    })(), { objectMode: false, highWaterMark: 65_536 }) : originalBody;
    // Observe bytes actually sent/received by Node's transport, not FormData
    // construction. Bind original methods: some handlers use private fields.
    const monitored = progress ? new Proxy(handler, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (['onBodySent', 'onResponseStarted', 'onHeaders', 'onData'].includes(String(key))) {
          return (...args: any[]) => {
            progress();
            return typeof value === 'function' ? value.apply(target, args) : undefined;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) : handler;
    return super.dispatch({ ...options, body, headersTimeout: 0, bodyTimeout: 0 }, monitored);
  }
}

// Private dispatcher hooks are valid only for this exact undici implementation.
// A preserved wrapper/proxy may delegate to a different bundled undici version.
function requestTransport(fetcher: typeof fetch, sessionTransport?: RequestDeadlineAgent) {
  return fetcher === matchedFetch ? sessionTransport || new RequestDeadlineAgent() : undefined;
}

// Foreign fetch exposes body demand, not socket callbacks. Keep the stream
// backpressured and split large encoder chunks so progress follows consumption.
// Do not tee/buffer the upload or count empty pulls as activity.
function progressBody(source: ReadableStream<Uint8Array>, progress: () => void, signal: AbortSignal) {
  const reader = source.getReader();
  let pending: Uint8Array | undefined;
  let offset = 0;
  let stopped = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const cancel = (reason?: unknown) => {
    if (stopped) return;
    stopped = true;
    pending = undefined;
    signal.removeEventListener('abort', onAbort);
    // A custom producer's cancel hook may never settle; do not let it hold up
    // deadline/cancellation reporting or replace the original fetch error.
    void reader.cancel(reason).catch(() => undefined);
  };
  const dispose = () => { cancel(); output.error(abortError(signal)); };
  const onAbort = () => { cancel(signal.reason); output.error(abortError(signal)); };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller;
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      try {
        let emptyChunks = 0;
        while (!stopped && (!pending || offset === pending.byteLength)) {
          const chunk = await reader.read();
          if (stopped) return;
          if (chunk.done) {
            stopped = true;
            signal.removeEventListener('abort', onAbort);
            reader.releaseLock();
            controller.close();
            return;
          }
          pending = chunk.value;
          offset = 0;
          // Synchronously produced empty chunks otherwise keep this loop in
          // microtasks forever, starving the abort/deadline timers. Yield
          // periodically without treating empty chunks as progress or limiting them.
          if (pending.byteLength === 0 && ++emptyChunks % 64 === 0) await yieldToEventLoop();
        }
        if (stopped || !pending) return;
        const chunk = pending.subarray(offset, offset + 65_536);
        offset += chunk.byteLength;
        controller.enqueue(chunk);
        progress();
      } catch (error) { cancel(error); controller.error(error); }
    },
    cancel,
  }, { highWaterMark: 0 });
  return { body, dispose };
}

export async function request<T>(
  url: string,
  options: RequestInit,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retries = 0,
  deadlineMode: 'total' | 'idle' = 'total',
  fetcher: typeof fetch = defaultFetch(),
  sessionTransport?: RequestDeadlineAgent,
): Promise<T> {
  // Enforce the host allowlist before the API key ever leaves the machine.
  assertAllowedHost(url);

  const transport = requestTransport(fetcher, sessionTransport);
  try {
    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const callerSignal = options.signal;
      const abortFromCaller = () => controller.abort();
      if (callerSignal?.aborted) controller.abort();
      else callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
      let timedOut = false;
      let finished = false;
      let timer = requestDeadline(() => { timedOut = true; controller.abort(); }, timeoutMs);
      const progress = deadlineMode === 'idle' ? () => {
        if (finished || controller.signal.aborted) return;
        timer.dispose();
        timer = requestDeadline(() => { timedOut = true; controller.abort(); }, timeoutMs);
      } : undefined;
      if (transport) transport.progress = progress;
      let uploadBody: ReturnType<typeof progressBody> | undefined;
      try {
        // redirect: 'manual' — never auto-follow. fetch forwards custom headers
        // (including XAPI-Key) across redirects, which would carry the API key to a
        // host outside the allowlist. The xapi API never legitimately redirects.
        const fetchOptions = { ...options, redirect: 'manual', signal: controller.signal, ...(transport ? { dispatcher: transport } : {}) } as RequestInit;
        if (!transport && progress && options.body != null) {
          // Encode once: these headers carry the boundary matching this exact
          // FormData stream. Never serialize it again after wrapping its body.
          const encoded = new Request(url, { ...fetchOptions, duplex: 'half' } as RequestInit);
          if (encoded.body) {
            uploadBody = progressBody(encoded.body, progress, controller.signal);
            Object.assign(fetchOptions, { body: uploadBody.body, headers: encoded.headers, duplex: 'half' });
          }
        }
        const res = await fetcher(url, fetchOptions);
        const readText = async () => {
          if (transport || !progress || !res.body) return res.text();
          const responseBody = progressBody(res.body, progress, controller.signal);
          try { return await new Response(responseBody.body).text(); }
          finally { responseBody.dispose(); }
        };
        if (!transport) progress?.();
        if (res.status >= 300 && res.status < 400) {
          throw new Error(
            `refusing to follow redirect to "${res.headers.get('location') ?? '?'}" `
            + '(would forward the API key past the host allowlist)',
          );
        }
        if (!res.ok) {
          const retryAfterMs = isRetryableStatus(res.status) ? parseRetryAfterMs(res) : undefined;
          if (isRetryableStatus(res.status) && attempt < retries) {
            await readText().catch(() => ''); // drain body so the socket can be reused
            timer.dispose();
            await sleep(backoffDelayMs(attempt, retryAfterMs), callerSignal);
            attempt++;
            continue;
          }
          const text = await readText().catch((cause: unknown) => {
            // Headers already establish a definite HTTP failure, even if its
            // body is interrupted. Do not relabel it as an unknown write.
            throw new HttpError(res.status, 'could not read error response', retryAfterMs, undefined, { cause });
          });
          let responseBody: unknown;
          try { responseBody = JSON.parse(text); } catch { /* Plain upstream errors stay plain. */ }
          throw new HttpError(res.status, text.slice(0, 300), retryAfterMs, responseBody);
        }
        if (res.status === 204) {
          return undefined as T;
        }
        const text = await readText();
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
        if (timedOut && !(e instanceof HttpError)) {
          const timeoutError = new RequestTimeoutError(timeoutMs);
          if (attempt < retries) {
            await sleep(backoffDelayMs(attempt), callerSignal);
            attempt++;
            continue;
          }
          throw timeoutError;
        }
        if (isRetryableNetworkError(e) && attempt < retries) {
          timer.dispose();
          await sleep(backoffDelayMs(attempt), callerSignal);
          attempt++;
          continue;
        }
        throw e;
      } finally {
        finished = true;
        timer.dispose();
        uploadBody?.dispose();
        callerSignal?.removeEventListener('abort', abortFromCaller);
      }
    }
  } finally {
    if (!sessionTransport) await transport?.destroy().catch(() => undefined);
  }
}

/** No total upload cutoff and no write replay. Matched transport observes socket
 * progress; foreign fetch observes backpressured body consumption and response
 * chunks via standard streams. Its internal parser deadlines remain its own. */
export function uploadRequest<T>(url: string, options: RequestInit): Promise<T> {
  return request<T>(url, options, transferIdleTimeoutMs(), 0, 'idle');
}

/** Control-plane calls in one upload share their connection while retaining
 * host/redirect checks and an independent total deadline for every request.
 * Native proxy mode reuses Node's pool without an external dispatcher. Like
 * foreign fetch, Node owns its internal parser deadlines in that mode. */
export function createArtifactControlSession() {
  const fetcher = nativeEnvironmentProxyEnabled() ? defaultFetch() : matchedFetch;
  const transport = requestTransport(fetcher);
  return {
    request: <T>(url: string, options: RequestInit, budget: number, retries: number) =>
      request<T>(url, options, budget, retries, 'total', fetcher, transport),
    close: async () => { await transport?.destroy().catch(() => undefined); },
  };
}

/** A temporary object channel carries bytes and checksum only, never API keys.
 * Its URL is validated by the Worker upload caller; errors never print it. */
export class WorkerObjectUploadError extends Error {
  constructor(public readonly diagnostic: {
    failureType: 'idle_timeout' | 'transport_error' | 'http_error' | 'authorization_expired' | 'deadline_exceeded';
    code?: string;
    httpStatus?: number;
    phase: 'queued_or_connecting' | 'sending_body' | 'awaiting_response' | 'receiving_response';
    objectSizeBytes: number;
    bodySentBytes: number;
    elapsedMs: number;
    idleMs: number;
    retryAfterMs?: number;
    attemptCount?: number;
    firstFailure?: { failureType: string; code?: string; httpStatus?: number };
  }) {
    super('Worker object upload failed' +
      (diagnostic.httpStatus !== undefined ? ` (HTTP ${diagnostic.httpStatus})` : '') +
      ` (${diagnostic.failureType}, ${diagnostic.phase}, ${diagnostic.objectSizeBytes} bytes)` +
      '; no deployment was started');
    this.name = 'WorkerObjectUploadError';
  }
}

export function createArtifactUploadTransport() {
  // One pool per upload session; per-request deadlines stay independent.
  // A stalled object cannot have its deadline extended by another active PUT.
  const transport = new Agent({
    connections: 8,
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  return {
    async upload(
      url: string,
      bytes: Uint8Array,
      headers: Record<string, string>,
      signal: AbortSignal,
    ) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
      let finished = false;
      let timedOut = false;
      let phase: WorkerObjectUploadError['diagnostic']['phase'] = 'queued_or_connecting';
      let bodySentBytes = 0;
      const startedAt = performance.now();
      let lastProgressAt = startedAt;
      const expire = () => { timedOut = true; controller.abort(); };
      let timer = requestDeadline(
        expire,
        transferIdleTimeoutMs(),
      );
      const progress = () => {
        if (finished || controller.signal.aborted) return;
        lastProgressAt = performance.now();
        timer.dispose();
        timer = requestDeadline(
          expire,
          transferIdleTimeoutMs(),
        );
      };
      const dispatcher: Dispatcher = Object.create(transport);
      dispatcher.dispatch = (options, handler) => {
        const body = Readable.from(
          (async function* () {
            for (let offset = 0; offset < bytes.length; offset += 65_536)
              yield bytes.subarray(offset, offset + 65_536);
          })(),
          { objectMode: false, highWaterMark: 65_536 },
        );
        const monitored = new Proxy(handler, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (key === 'onConnect' || key === 'onRequestSent')
              return (...args: any[]) => {
                phase = key === 'onConnect' ? 'sending_body' : 'awaiting_response';
                return typeof value === 'function' ? value.apply(target, args) : undefined;
              };
            if (
              [
                'onBodySent',
                'onResponseStarted',
                'onHeaders',
                'onData',
              ].includes(String(key))
            )
              return (...args: any[]) => {
                if (key === 'onBodySent') {
                  phase = 'sending_body';
                  bodySentBytes += args[0]?.byteLength || 0;
                } else phase = 'receiving_response';
                progress();
                return typeof value === 'function'
                  ? value.apply(target, args)
                  : undefined;
              };
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return transport.dispatch(
          { ...options, body, headersTimeout: 0, bodyTimeout: 0 },
          monitored,
        );
      };
      try {
        const response = await undiciFetch(url, {
          method: 'PUT',
          body: bytes as BodyInit,
          headers,
          redirect: 'manual',
          signal: controller.signal,
          dispatcher,
        } as any);
        if (!response.ok) {
          // Object retries must honor a valid hint in full, independently of the
          // generic API client's capped backoff. Never retain raw header text.
          const hint = response.headers.get('retry-after');
          let retryAfterMs: number | undefined;
          if (hint !== null && [429, 503].includes(response.status)) {
            const value = hint.trim();
            const delay = /^\d+(?:\.\d+)?$/.test(value)
              // Even an overflowing numeric hint cannot fit an authorization
              // deadline; retain that fact instead of falling back to an early retry.
              ? Math.min(Number.MAX_SAFE_INTEGER, Number(value) * 1000) : Date.parse(value) - Date.now();
            if (Number.isFinite(delay) && delay >= 0) retryAfterMs = delay;
          }
          await response.body?.cancel();
          throw new WorkerObjectUploadError({failureType: 'http_error', httpStatus: response.status,
            ...(retryAfterMs !== undefined ? {retryAfterMs} : {}),
            phase, objectSizeBytes: bytes.length, bodySentBytes,
            elapsedMs: Math.round(performance.now() - startedAt), idleMs: Math.round(performance.now() - lastProgressAt)});
        }
        await response.arrayBuffer();
      } catch (error) {
        if (signal.aborted) {
          if (signal.reason instanceof WorkerObjectUploadError)
            throw new WorkerObjectUploadError({...signal.reason.diagnostic, phase, bodySentBytes,
              elapsedMs: Math.round(performance.now() - startedAt), idleMs: Math.round(performance.now() - lastProgressAt)});
          throw signal.reason instanceof Error
            ? signal.reason
            : new Error('Worker upload cancelled');
        }
        if (error instanceof WorkerObjectUploadError)
          throw error;
        // Never include a signed URL or raw transport message in the public error.
        const code = (error as any)?.cause?.code;
        const safeCode =
          typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
            ? code : undefined;
        throw new WorkerObjectUploadError({failureType: timedOut ? 'idle_timeout' : 'transport_error',
          ...(safeCode ? {code: safeCode} : {}), phase, objectSizeBytes: bytes.length, bodySentBytes,
          elapsedMs: Math.round(performance.now() - startedAt), idleMs: Math.round(performance.now() - lastProgressAt)});
      } finally {
        finished = true;
        timer.dispose();
        signal.removeEventListener('abort', abort);
      }
    },
    close: () => transport.destroy().catch(() => undefined),
  };
}

export async function uploadArtifactObject(
  url: string,
  bytes: Uint8Array,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const transport = createArtifactUploadTransport();
  try {
    await transport.upload(url, bytes, headers, signal);
  } finally {
    await transport.close();
  }
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h['XAPI-Key'] = apiKey;
  return h;
}

/** Call a scoped API-Key control-plane endpoint without exchanging for a JWT. */
export function apiKeyApiRequest<T>(
  apiHost: string,
  apiKey: string,
  path: string,
  options: ApiKeyApiRequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const requestHeaders: Record<string, string> = { 'XAPI-KEY': apiKey };
  if (options.body !== undefined) requestHeaders['Content-Type'] = 'application/json';
  return request<T>(
    `${scheme(apiHost)}://${apiHost}${path}`,
    {
      method,
      headers: requestHeaders,
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    options.retries ?? 0,
  );
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
  params: {
    category?: string;
    source?: string;
    page?: number;
    page_size?: number;
    include_all_versions?: boolean;
    sort?: 'default' | 'relevance' | 'price';
  } = {},
) {
  const url = new URL(`${baseUrl(opts)}/v1/actions/search`);
  url.searchParams.set('q', query);
  if (params.category) url.searchParams.set('category', params.category);
  if (params.source) url.searchParams.set('source', params.source);
  if (params.page) url.searchParams.set('page', String(params.page));
  if (params.page_size) url.searchParams.set('page_size', String(params.page_size));
  if (params.include_all_versions) url.searchParams.set('include_all_versions', 'true');
  if (params.sort) url.searchParams.set('sort', params.sort);
  return request<{
    results: unknown[];
    query: string;
    sort?: 'default' | 'relevance' | 'price';
    ranking_version?: number;
    pagination: unknown;
  }>(
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

/** Execute an action through the SSE interface and forward frames unchanged. */
export async function actionStream(
  actionId: string,
  input: Record<string, unknown>,
  opts: ClientOptions,
  httpMethod?: string,
): Promise<void> {
  const fetcher = defaultFetch();
  const transport = requestTransport(fetcher);
  const controller = new AbortController();
  let timedOut = false;
  let activeTimeoutMs = EXECUTE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetTimeout = (timeoutMs: number) => {
    if (timer) clearTimeout(timer);
    activeTimeoutMs = timeoutMs;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  resetTimeout(EXECUTE_TIMEOUT_MS);
  const url = `${baseUrl(opts)}/v1/actions/execute`;

  try {
    assertAllowedHost(url);
    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        ...headers(opts.apiKey),
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        action_id: actionId,
        ...(httpMethod ? { method: httpMethod } : {}),
        input,
        stream: true,
      }),
      redirect: 'manual',
      signal: controller.signal,
      ...(transport ? { dispatcher: transport } : {}),
    } as RequestInit);
    if (res.status >= 300 && res.status < 400) {
      throw new Error(
        `refusing to follow redirect to "${res.headers.get('location') ?? '?'}" `
          + '(would forward the API key past the host allowlist)',
      );
    }
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(
        res.status,
        text.slice(0, 300),
        isRetryableStatus(res.status) ? parseRetryAfterMs(res) : undefined,
      );
    }

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const text = await res.text();
      throw new Error(
        `expected an SSE response but received "${contentType || 'unknown'}": ${text.slice(0, 300)}`,
      );
    }

    if (!res.body) return;
    const idleTimeoutMs = transferIdleTimeoutMs();
    resetTimeout(idleTimeoutMs);
    const source = Readable.fromWeb(res.body as any);
    for await (const chunk of source) {
      resetTimeout(idleTimeoutMs);
      if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
    }
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError(activeTimeoutMs);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await transport?.destroy().catch(() => undefined);
  }
}

export interface ActionDownloadResult {
  output: string;
  bytes: number;
  contentType?: string;
  contentDisposition?: string;
  status: number;
}

/** Execute an action in raw mode and write the response without decoding it. */
export async function actionDownload(
  actionId: string,
  input: Record<string, unknown>,
  opts: ClientOptions,
  outputPath: string,
  httpMethod?: string,
): Promise<ActionDownloadResult> {
  const fetcher = defaultFetch();
  const transport = requestTransport(fetcher);
  const controller = new AbortController();
  let timedOut = false;
  let activeTimeoutMs = EXECUTE_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetTimeout = (timeoutMs: number) => {
    if (timer) clearTimeout(timer);
    activeTimeoutMs = timeoutMs;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  };
  resetTimeout(EXECUTE_TIMEOUT_MS);
  const target = resolve(outputPath);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let complete = false;

  try {
    try {
      // Fail before executing a potentially billable/non-idempotent action.
      // This also lets cleanup safely remove only files created by this call.
      file = await open(target, 'wx');
    } catch (error: any) {
      if (error?.code === 'EEXIST') {
        throw new Error(`Output file already exists: ${target}`);
      }
      throw error;
    }

    const url = `${baseUrl(opts)}/v1/actions/execute`;
    assertAllowedHost(url);
    const res = await fetcher(url, {
      method: 'POST',
      headers: headers(opts.apiKey),
      body: JSON.stringify({
        action_id: actionId,
        ...(httpMethod ? { method: httpMethod } : {}),
        input,
        response_mode: 'raw',
      }),
      redirect: 'manual',
      signal: controller.signal,
      ...(transport ? { dispatcher: transport } : {}),
    } as RequestInit);
    if (res.status >= 300 && res.status < 400) {
      throw new Error(
        `refusing to follow redirect to "${res.headers.get('location') ?? '?'}" `
          + '(would forward the API key past the host allowlist)',
      );
    }
    if (!res.ok) {
      const text = await res.text();
      throw new HttpError(
        res.status,
        text.slice(0, 300),
        isRetryableStatus(res.status) ? parseRetryAfterMs(res) : undefined,
      );
    }

    let bytes = 0;
    if (res.body) {
      const idleTimeoutMs = transferIdleTimeoutMs();
      resetTimeout(idleTimeoutMs);
      const source = Readable.fromWeb(res.body as any);
      const counter = new Transform({
        transform(chunk, _encoding, callback) {
          resetTimeout(idleTimeoutMs);
          bytes += Buffer.isBuffer(chunk)
            ? chunk.length
            : Buffer.byteLength(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(source, counter, file.createWriteStream());
    } else {
      await file.close();
    }
    complete = true;

    return {
      output: target,
      bytes,
      contentType: res.headers.get('content-type') || undefined,
      contentDisposition:
        res.headers.get('content-disposition') || undefined,
      status: res.status,
    };
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError(activeTimeoutMs);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await transport?.destroy().catch(() => undefined);
    if (!complete && file) {
      await file.close().catch(() => undefined);
      await rm(target, { force: true }).catch(() => undefined);
    }
  }
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

export async function listOAuthBindings(
  jwtToken: string,
  apiHost: string,
  signal?: AbortSignal,
) {
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
    { method: 'GET', headers: jwtHeaders(jwtToken), signal },
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
