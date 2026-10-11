import { decodeCommandFrames, type SandboxCommandEvent } from './sandbox-command-stream-codec.ts';
import { requestDeadline } from './request-deadline.ts';
import { Agent, type Dispatcher } from 'undici/index.js';
import { HttpError } from './client.ts';
/**
 * xAPI Sandbox Gateway client.
 *
 * State-changing calls are never retried blindly. A lost POST response may have
 * created, executed, or terminated a real billable instance. Read-only calls and
 * quotes opt into the shared client's conservative transient retry policy.
 */

import { assertAllowedHost, isLoopbackHost, scheme } from './config.ts';
import { request } from './client.ts';
import { sandboxExtensionTimeoutMs } from './sandbox-extension-budget.ts';

const READ_RETRIES = 2;
const READ_TIMEOUT_MS = 30_000;
const MUTATION_TIMEOUT_MS = 180_000;

export interface SandboxClientOptions {
  sandboxHost: string;
  apiKey: string;
  provider?: string;
}

export interface SandboxRequirements {
  cpu?: { min?: number; max?: number };
  memoryGiB?: { min?: number; max?: number };
  volumeGiB?: { min?: number; max?: number };
  gpu?: { count?: number; model?: string };
  regions?: string[];
  capabilities?: string[];
  minContinuousRuntimeSeconds?: number;
  [key: string]: unknown;
}

export interface SandboxDetail {
  id: string;
  observedState?: string;
  desiredState?: string | null;
  totalCost?: string | number;
  offeringId?: string;
  providerInstanceId?: string;
  [key: string]: unknown;
}

export interface SandboxCommandResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  background?: {
    sessionId: string;
    commandId: string;
  };
  [key: string]: unknown;
}

const PRODUCTION_PROVIDER_HOSTS: Readonly<Record<string, string>> = {
  daytona: 'daytona-sandbox',
  e2b: 'e2b-sandbox',
};

function parsedHost(raw: string): URL {
  const value = raw.trim();
  if (!value) throw new Error('sandbox host is empty');
  const url = new URL(value.includes('://') ? value : `${scheme(value)}://${value}`);
  if (url.username || url.password) throw new Error('sandbox host must not contain credentials');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('sandbox host must not contain a path, query, or fragment');
  }
  const loopback = isLoopbackHost(url.toString());
  if (loopback && url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('localhost sandbox hosts must use HTTP or HTTPS');
  }
  if (!loopback && url.protocol !== 'https:') {
    throw new Error('public sandbox hosts must use HTTPS');
  }
  return url;
}

/** Resolve auto-routing or a provider-pinned Sandbox Gateway URL. */
export function sandboxBaseUrl(host: string, provider?: string): string {
  const url = parsedHost(host);
  const pin = provider && provider !== 'auto' ? provider : undefined;
  if (pin) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(pin)) {
      throw new Error(`invalid sandbox provider: ${pin}`);
    }
    if (!isLoopbackHost(url.toString())) {
      const labels = url.hostname.split('.');
      const sandboxIndex = labels.indexOf('sandbox');
      const isProduction =
        sandboxIndex >= 0 &&
        labels.slice(sandboxIndex).join('.') === 'sandbox.xapi.to';
      const gatewayLabel = isProduction
        ? PRODUCTION_PROVIDER_HOSTS[pin] || pin
        : pin;
      if (sandboxIndex === 0) labels.unshift(gatewayLabel);
      else if (sandboxIndex === 1) labels[0] = gatewayLabel;
      else throw new Error('provider pinning requires a sandbox.<xapi-domain> host');
      url.hostname = labels.join('.');
    }
  }

  // Sandbox credentials follow the stricter public contract: only *.xapi.to
  // (plus loopback for local development), even though legacy action commands
  // also recognize xapi.xyz.
  assertAllowedHost(url.toString());
  const hostname = url.hostname.toLowerCase();
  if (!isLoopbackHost(url.toString()) && hostname !== 'xapi.to' && !hostname.endsWith('.xapi.to')) {
    throw new Error('sandbox API keys may only be sent to *.xapi.to or localhost');
  }
  const base = url.toString().replace(/\/$/, '');
  return pin && isLoopbackHost(base) ? `${base}/providers/${pin}` : base;
}

function headers(apiKey: string, body: boolean): Record<string, string> {
  return {
    Accept: 'application/json',
    'XAPI-Key': apiKey,
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function sandboxRequest<T>(
  opts: SandboxClientOptions,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number; readOnly?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method || 'GET';
  const readOnly = init.readOnly ?? method === 'GET';
  const hasBody = init.body !== undefined;
  try {
    return await request<T>(
    `${sandboxBaseUrl(opts.sandboxHost, opts.provider)}${path}`,
    {
      method,
      headers: headers(opts.apiKey, hasBody),
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    },
    init.timeoutMs || (readOnly ? READ_TIMEOUT_MS : MUTATION_TIMEOUT_MS),
    readOnly ? READ_RETRIES : 0,
    'total',
  );
  } catch (error) {
    if (error instanceof HttpError && error.responseBody !== undefined) {
      throw new HttpError(error.status, sandboxErrorDetail(JSON.stringify(error.responseBody)), error.retryAfterMs);
    }
    throw error;
  }
}

/** Keep financial trace fields outside the native message preview. */
export function sandboxErrorDetail(text: string): string {
  try {
    const body = JSON.parse(text);
    if (typeof body?.code !== 'string' || !/^SANDBOX_[A-Z0-9_]{1,100}$/.test(body.code)) return text.slice(0,300);
    const fields: Record<string, unknown> = {code:body.code};
    for (const key of ['operationId','executionStatus','billingStatus']) {
      if (typeof body[key] === 'string' && body[key].length <= 200) fields[key] = body[key];
    }
    if (typeof body.message === 'string') fields.message = body.message.slice(0,2000);
    return JSON.stringify(fields);
  } catch { return text.slice(0,300); }
}

export const sandboxOfferings = (opts: SandboxClientOptions) =>
  sandboxRequest<unknown[]>(opts, '/v1/offerings');

export const sandboxQuote = (
  opts: SandboxClientOptions,
  body: Record<string, unknown>,
  signal?: AbortSignal,
) => sandboxRequest<any>(opts, '/v1/quotes', { method: 'POST', body, readOnly: true, signal });

export const sandboxList = (opts: SandboxClientOptions) =>
  sandboxRequest<SandboxDetail[] | { items?: SandboxDetail[]; data?: SandboxDetail[] }>(opts, '/v1/sandboxes');

export const sandboxHistory = (
  opts: SandboxClientOptions,
  filters: {
    state?: string;
    search?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  } = {},
) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  return sandboxRequest<any>(opts, `/v1/sandbox-history${query.size ? `?${query}` : ''}`);
};

export const sandboxGet = (opts: SandboxClientOptions, id: string, signal?: AbortSignal) =>
  sandboxRequest<SandboxDetail>(opts, `/v1/sandboxes/${encodeURIComponent(id)}`, { signal });

export const sandboxCreate = (opts: SandboxClientOptions, body: Record<string, unknown>) =>
  sandboxRequest<SandboxDetail>(opts, '/v1/sandboxes', { method: 'POST', body });

export const sandboxExec = (
  opts: SandboxClientOptions,
  id: string,
  body: {
    command: string;
    timeoutSeconds?: number;
    cwd?: string;
    env?: Record<string, string>;
    background?: boolean;
  },
  signal?: AbortSignal,
) => sandboxRequest<SandboxCommandResult>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/commands`,
  {
    method: 'POST', body, signal,
    timeoutMs: sandboxCommandTransportMs(body.timeoutSeconds ?? 60, body.background),
  },
);

export function sandboxCommandTransportMs(seconds: number, background = false) {
  const milliseconds = (background ? 0 : seconds * 1000) + 300_000;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || !Number.isSafeInteger(milliseconds))
    throw new Error('Command duration exceeds representable milliseconds');
  return milliseconds;
}

export const sandboxFileWrite = (
  opts: SandboxClientOptions,
  id: string,
  body: { path: string; content: string; encoding: 'utf8' | 'base64' },
) => sandboxRequest<any>(opts, `/v1/sandboxes/${encodeURIComponent(id)}/files`, { method: 'POST', body, timeoutMs: 180_000 });

export const sandboxFileRead = (
  opts: SandboxClientOptions,
  id: string,
  path: string,
  encoding: 'utf8' | 'base64' = 'utf8',
) => sandboxRequest<any>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}&encoding=${encoding}`,
  { timeoutMs: 180_000 },
);

export async function sandboxFileUpload(opts: SandboxClientOptions, id: string, path: string,
  source: AsyncIterable<Uint8Array>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const url = `${sandboxBaseUrl(opts.sandboxHost, opts.provider)}/v1/sandboxes/${encodeURIComponent(id)}/files/upload?path=${encodeURIComponent(path)}`;
  assertAllowedHost(url);
  const transport = new SandboxCommandAgent();
  try {
    const response = await fetch(url, { method: 'POST', headers: { ...headers(opts.apiKey, false),
      'Content-Type': 'application/octet-stream' }, body: source as any, duplex: 'half',
      signal, redirect: 'manual', dispatcher: transport } as RequestInit);
    const reader = response.body?.getReader();
    const parts: Uint8Array[] = []; let size = 0;
    try {
      if (reader) while (size < 8192) {
        const next = await reader.read(); if (next.done) break;
        const part = next.value.subarray(0, 8192 - size); parts.push(part); size += part.length;
      }
    } finally { await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    const text = new TextDecoder().decode(bytes); let result: any;
    try { result = JSON.parse(text); } catch { throw new HttpError(response.status, 'Sandbox upload returned an invalid acknowledgement; upload was not replayed'); }
    if (!response.ok) throw new HttpError(response.status, result?.message || `Sandbox upload returned HTTP ${response.status}`);
    return result;
  } finally { await transport.destroy(); }
}

export async function sandboxFileDownload(opts: SandboxClientOptions, id: string, path: string, signal?: AbortSignal) {
  const url = `${sandboxBaseUrl(opts.sandboxHost, opts.provider)}/v1/sandboxes/${encodeURIComponent(id)}/files/download?path=${encodeURIComponent(path)}`;
  assertAllowedHost(url);
  const response = await fetch(url, { headers: headers(opts.apiKey, false), signal, redirect: 'manual' });
  if (!response.ok) {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      if (reader) for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.length; if (bytes > 8192) break;
        chunks.push(chunk.value);
      }
    } catch {} finally { await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
    const data = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
    let offset = 0; for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    const text = new TextDecoder().decode(data);
    let body: any = text; try { body = JSON.parse(text); } catch {}
    const detail = typeof body?.message === 'string' ? body.message : text;
    throw new Error(`Sandbox download returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  if (!response.body) throw new Error('Sandbox download returned no body');
  return response.body;
}

export const sandboxFileList = (
  opts: SandboxClientOptions,
  id: string,
  path = '.',
  depth = 2,
) => sandboxRequest<any>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/files/list?path=${encodeURIComponent(path)}&depth=${depth}`,
  { timeoutMs: 180_000 },
);

export const sandboxPort = (opts: SandboxClientOptions, id: string, port: number) =>
  // This legacy GET can allocate a tunnel/preview. It is not a read-only query.
  sandboxRequest<any>(opts, `/v1/sandboxes/${encodeURIComponent(id)}/ports/${port}`, { timeoutMs: 300_000, readOnly: false });

export const sandboxExtension = (
  opts: SandboxClientOptions,
  id: string,
  extensionId: string,
  body: { input: Record<string, unknown>; idempotencyKey?: string },
) => sandboxRequest<any>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/extensions/${encodeURIComponent(extensionId)}`,
  { method: 'POST', body, timeoutMs: sandboxExtensionTimeoutMs(extensionId, body.input) },
);

export const sandboxStateAction = (
  opts: SandboxClientOptions,
  id: string,
  action: 'suspend' | 'resume' | 'terminate' | 'snapshot',
  body: Record<string, unknown> = {},
) => sandboxRequest<any>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/${action}`,
  { method: 'POST', body },
);

export const sandboxAudit = (
  opts: SandboxClientOptions,
  id: string,
  kind: string,
  page = 1,
  pageSize = 100,
  billingStatus?: string,
) => sandboxRequest<any>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/audit?kind=${encodeURIComponent(kind)}&page=${page}&pageSize=${pageSize}${billingStatus ? `&billingStatus=${encodeURIComponent(billingStatus)}` : ''}`,
);

export async function sandboxWait(
  opts: SandboxClientOptions,
  id: string,
  wanted: string[],
  timeoutMs = 300_000,
  intervalMs = 2_000,
  signal?: AbortSignal,
): Promise<SandboxDetail> {
  const deadline = Date.now() + timeoutMs;
  const deadlineController = new AbortController();
  const abortFromCaller = () => deadlineController.abort();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), Math.max(0, timeoutMs));
  if (signal?.aborted) deadlineController.abort();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  let last: SandboxDetail | undefined;
  try {
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error(`sandbox wait interrupted while waiting for ${wanted.join(' or ')}`);
      try {
        last = await sandboxGet(opts, id, deadlineController.signal);
      } catch (error) {
        if (signal?.aborted) {
          throw new Error(`sandbox wait interrupted while waiting for ${wanted.join(' or ')}`);
        }
        if (Date.now() >= deadline) break;
        throw error;
      }
      if (Date.now() >= deadline) break;
      const state = String(last.observedState || '');
      if (wanted.includes(state)) return last;
      if (['FAILED', 'TERMINATED'].includes(state) && !wanted.includes(state)) {
        throw new Error(`sandbox ${id} entered ${state} while waiting for ${wanted.join(' or ')}`);
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(intervalMs, Math.max(0, deadline - Date.now())));
        signal?.addEventListener('abort', done, { once: true });
      });
    }
  } finally {
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
  throw new Error(
    `sandbox ${id} did not enter ${wanted.join(' or ')} within ${timeoutMs}ms` +
    ` (last state: ${last?.observedState || 'unknown'})`,
  );
}

class SandboxCommandAgent extends Agent {
  constructor() { super({ headersTimeout: 0, bodyTimeout: 0 }); }
  override dispatch(options: Agent.DispatchOptions, handler: Dispatcher.DispatchHandlers) {
    return super.dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler);
  }
}

export async function* sandboxExecStream(opts: SandboxClientOptions, id: string, input: {
    command: string; cwd?: string; env?: Record<string, string>; timeoutSeconds?: number;
  }, signal?: AbortSignal): AsyncGenerator<SandboxCommandEvent> {
    signal?.throwIfAborted();
    const cancel = new AbortController();
    const deadline = requestDeadline(() => cancel.abort(new DOMException('Command transport deadline exceeded', 'TimeoutError')), sandboxCommandTransportMs(input.timeoutSeconds ?? 60));
    const cancelled = () => cancel.abort(signal?.reason);
    signal?.addEventListener('abort', cancelled, { once: true });
    const transport = new SandboxCommandAgent();
    const joined = cancel.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(`${sandboxBaseUrl(opts.sandboxHost, opts.provider)}/v1/sandboxes/${encodeURIComponent(id)}/commands/stream`, {
        method: 'POST', headers: { authorization: `Bearer ${opts.apiKey}`, accept: 'application/x-ndjson',
          'content-type': 'application/json' }, body: JSON.stringify(input), signal: joined, redirect: 'manual',
        dispatcher: transport,
      } as RequestInit);
      reader = response.body?.getReader();
      if (!response.ok) {
        const parts: Uint8Array[] = []; let size = 0;
        if (reader) while (size < 8192) {
          const next = await reader.read(); if (next.done) break;
          const part = next.value.subarray(0, 8192 - size); parts.push(part); size += part.length;
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        const text = new TextDecoder().decode(bytes); let body: any = text;
        try { body = JSON.parse(text); } catch {}
        throw new HttpError(response.status, body?.message || `Sandbox command returned HTTP ${response.status}`);
      }
      if (!reader) throw new Error('Sandbox command stream returned no body');
      if (response.headers.get('X-Xapi-Command-Stream') !== 'v1') throw new Error('Unsupported Sandbox command stream version');
      const source = reader;
      const chunks = (async function* () { for (;;) { const next = await source.read(); if (next.done) break; yield next.value; } })();
      for await (const event of decodeCommandFrames(chunks)) {
        if (event.type === 'error') throw new HttpError(event.status, event.message);
        yield event;
      }
    } finally {
      cancel.abort(); deadline.dispose(); await reader?.cancel().catch(() => undefined); reader?.releaseLock();
      signal?.removeEventListener('abort', cancelled); await transport.destroy();
    }
  }
