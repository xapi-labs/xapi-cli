/**
 * xAPI Sandbox Gateway client.
 *
 * State-changing calls are never retried blindly. A lost POST response may have
 * created, executed, or terminated a real billable instance. Read-only calls and
 * quotes opt into the shared client's conservative transient retry policy.
 */

import { assertAllowedHost, isLoopbackHost, scheme } from './config.ts';
import { request } from './client.ts';

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
    if (isLoopbackHost(url.toString())) {
      throw new Error('provider pinning is unavailable for a localhost sandbox gateway');
    }
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

  // Sandbox credentials follow the stricter public contract: only *.xapi.to
  // (plus loopback for local development), even though legacy action commands
  // also recognize xapi.xyz.
  assertAllowedHost(url.toString());
  const hostname = url.hostname.toLowerCase();
  if (!isLoopbackHost(url.toString()) && hostname !== 'xapi.to' && !hostname.endsWith('.xapi.to')) {
    throw new Error('sandbox API keys may only be sent to *.xapi.to or localhost');
  }
  return url.toString().replace(/\/$/, '');
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
  const hasBody = init.body !== undefined;
  return request<T>(
    `${sandboxBaseUrl(opts.sandboxHost, opts.provider)}${path}`,
    {
      method,
      headers: headers(opts.apiKey, hasBody),
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    },
    init.timeoutMs || (init.readOnly || method === 'GET' ? READ_TIMEOUT_MS : MUTATION_TIMEOUT_MS),
    init.readOnly || method === 'GET' ? READ_RETRIES : 0,
  );
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
    background?: boolean;
  },
  signal?: AbortSignal,
) => sandboxRequest<SandboxCommandResult>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/commands`,
  {
    method: 'POST', body, signal,
    timeoutMs: Math.max(MUTATION_TIMEOUT_MS, (body.timeoutSeconds || 60) * 1_000 + 30_000),
  },
);

export const sandboxFileWrite = (
  opts: SandboxClientOptions,
  id: string,
  body: { path: string; content: string; encoding: 'utf8' | 'base64' },
) => sandboxRequest<any>(opts, `/v1/sandboxes/${encodeURIComponent(id)}/files`, { method: 'POST', body });

export const sandboxFileRead = (
  opts: SandboxClientOptions,
  id: string,
  path: string,
  encoding: 'utf8' | 'base64' = 'utf8',
) => sandboxRequest<any>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}&encoding=${encoding}`,
);

export const sandboxFileList = (
  opts: SandboxClientOptions,
  id: string,
  path = '.',
  depth = 2,
) => sandboxRequest<any>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/files/list?path=${encodeURIComponent(path)}&depth=${depth}`,
);

export const sandboxPort = (opts: SandboxClientOptions, id: string, port: number) =>
  sandboxRequest<any>(opts, `/v1/sandboxes/${encodeURIComponent(id)}/ports/${port}`);

export const sandboxExtension = (
  opts: SandboxClientOptions,
  id: string,
  extensionId: string,
  body: { input: Record<string, unknown>; idempotencyKey?: string },
) => sandboxRequest<any>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/extensions/${encodeURIComponent(extensionId)}`,
  { method: 'POST', body },
);

export const sandboxStateAction = (
  opts: SandboxClientOptions,
  id: string,
  action: 'suspend' | 'resume' | 'terminate',
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
) => sandboxRequest<any>(
  opts,
  `/v1/sandboxes/${encodeURIComponent(id)}/audit?kind=${encodeURIComponent(kind)}&page=${page}&pageSize=${pageSize}`,
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
  let last: SandboxDetail | undefined;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error(`sandbox wait interrupted while waiting for ${wanted.join(' or ')}`);
    last = await sandboxGet(opts, id, signal);
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
  throw new Error(
    `sandbox ${id} did not enter ${wanted.join(' or ')} within ${timeoutMs}ms` +
    ` (last state: ${last?.observedState || 'unknown'})`,
  );
}
