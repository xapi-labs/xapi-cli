import { BusinessResponseError, HttpError, RequestTimeoutError } from './client.ts';

function record(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any> : undefined;
}

/** Only the outer Action envelope describes execution, never a nested payload. */
export function isActionFailure(value: unknown): boolean {
  return record(value)?.success === false;
}

/** Error bodies can echo credentials; never print a configured key in diagnostics. */
export function redactActionFailure(value: unknown, apiKey?: string, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') {
    let text = value;
    if (apiKey) {
      text = text.split(apiKey).join('[redacted]');
      text = text.split(encodeURIComponent(apiKey)).join('[redacted]');
    }
    return text.replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]');
  }
  if (Array.isArray(value)) return value.map(item => redactActionFailure(item, apiKey, depth + 1));
  const obj = record(value);
  if (!obj) return value;
  return Object.fromEntries(Object.entries(obj).map(([key, item]) => [key,
    /^(?:authorization|proxy-authorization|cookie|set-cookie|password|secret|privateHeaders|api[-_]?key|xapi[-_]?key|access[-_]?token|refresh[-_]?token)$/i.test(key)
      ? '[redacted]' : redactActionFailure(item, apiKey, depth + 1),
  ]));
}

export function actionErrorDetail(error: unknown, apiKey?: string, envelope?: unknown) {
  const body = record(envelope ?? (error instanceof HttpError || error instanceof BusinessResponseError ? error.responseBody : undefined));
  const inner = record(body?.error);
  const status = error instanceof HttpError ? error.status : undefined;
  const unknown = !body && !(error instanceof HttpError);
  const message = inner?.message ?? body?.message
    ?? (error instanceof Error ? error.message : 'Action execution failed');
  const code = inner?.code ?? body?.code
    ?? (error instanceof RequestTimeoutError ? 'REQUEST_TIMEOUT'
      : status ? `HTTP_${status}` : unknown ? 'EXECUTION_OUTCOME_UNKNOWN' : 'ACTION_FAILED');
  const details = inner?.details ?? body?.details ?? (Array.isArray(message) ? message : undefined);
  return redactActionFailure({
    ...(status ? { status } : {}),
    code,
    message,
    ...(details !== undefined ? { details } : {}),
    ...(error instanceof HttpError && error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {}),
    outcome: unknown ? 'unknown' : 'failed',
    ...(unknown ? { hint: 'The upstream may have completed the action. Check its result before retrying a write.' } : {}),
  }, apiKey);
}
