import { request } from './client.ts';
import { scheme, XAPI_API_HOST } from './config.ts';

export type ProviderObject = Record<string, unknown>;

export function providerRequest<T = ProviderObject>(
  path: string,
  apiKey: string | undefined,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' = 'GET',
  body?: ProviderObject,
  timeoutMs = 30_000,
  retries = method === 'GET' ? 2 : 0,
): Promise<T> {
  return request<T>(`${scheme(XAPI_API_HOST)}://${XAPI_API_HOST}/api/api-services/agent/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'XAPI-KEY': apiKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, Math.min(timeoutMs, 30_000), retries);
}

export function object(value: unknown): ProviderObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as ProviderObject : undefined;
}

// Owner reads can contain upstream credentials, even when write responses are scrubbed.
const SECRET_FIELD = /^(authConfig|privateHeaders|authorization|proxy-authorization|api[-_]?key|xapi[-_]?key|x-api-key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret|token|cookie|set-cookie)$/i;

// These fields contain API definitions, not credential maps. A property named
// "token" in a schema must retain its type/description and must not make the
// word "string" a secret everywhere else in the response.
const CONTRACT_FIELD = new Set([
  'openApiSpec', 'bodySchema', 'schema', 'schemas', 'properties',
  'definitions', '$defs', 'params', 'pathParams', 'responses', 'securitySchemes',
]);

function isContract(key: string, value: unknown, parent?: string): boolean {
  if (CONTRACT_FIELD.has(key)) return true;
  const obj = object(value);
  if (typeof obj?.openapi === 'string') return true;
  // Endpoint headers may be parameter definitions or literal header values.
  return parent === 'headers' && !!obj && ('type' in obj || 'schema' in obj || '$ref' in obj);
}

export function collectProviderSecrets(value: unknown): string[] {
  const secrets: string[] = [];
  function visit(item: unknown, sensitive = false, contract = false, parent?: string) {
    if (typeof item === 'string' && sensitive && item) secrets.push(item);
    else if (Array.isArray(item)) item.forEach(v => visit(v, sensitive, contract, parent));
    else if (object(item)) {
      for (const [key, val] of Object.entries(item as ProviderObject)) {
        const definition = !sensitive && (contract || isContract(key, val, parent));
        visit(val, sensitive || (!definition && SECRET_FIELD.test(key)), definition, key);
      }
    }
  }
  visit(value);
  return secrets;
}

export function redactProvider(value: unknown, knownSecrets: string[] = []): unknown {
  const secrets = [...new Set([...knownSecrets, ...collectProviderSecrets(value)])]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  function visit(item: unknown, contract = false, parent?: string): unknown {
    if (typeof item === 'string') {
      return secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), item);
    }
    if (Array.isArray(item)) return item.map(val => visit(val, contract, parent));
    if (object(item)) return Object.fromEntries(Object.entries(item as ProviderObject)
      .map(([key, val]) => {
        const definition = contract || isContract(key, val, parent);
        return [key, !definition && SECRET_FIELD.test(key) ? '[REDACTED]' : visit(val, definition, key)];
      }));
    return item;
  }
  return visit(value);
}
