/** Read or wait for a finalized per-request cost receipt. */

import {
  HttpError,
  isRetryableRequestError,
  request,
} from '../client.ts';
import {
  getConfig,
  requireApiKey,
  XAPI_API_HOST,
  scheme,
} from '../config.ts';
import { err, output } from '../format.ts';

const READ_RETRIES = 2;

export const USAGE_HELP = `xapi-to usage - Read a finalized request cost receipt

USAGE
  xapi-to usage <request-id> [--format json|pretty|table]
  xapi-to usage wait <request-id> [--interval 1s] [--timeout 30s]

Use the request ID returned in X-XAPI-Request-Id or the final xapi.usage SSE event.
The receipt is visible only to the API key that made the request.

"usage wait" polls through the normal finalization window. A 404 means the
receipt is not finalized yet; invalid credentials and other permanent errors
still fail immediately.
`;

function parsePositiveDurationMs(raw: string, flagName: string): number {
  const match = raw.trim().toLowerCase().match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) {
    err(`${flagName} must be a duration such as 500ms, 2s, 5m, or 1h`);
  }
  const value = Number(match![1]);
  const unit = match![2] || 'ms';
  const multiplier =
    unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const result = value * multiplier;
  if (!Number.isSafeInteger(result) || result <= 0) {
    err(`${flagName} must be greater than 0`);
  }
  return result;
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function receiptUrl(requestId: string) {
  return `${scheme(XAPI_API_HOST)}://${XAPI_API_HOST}/api/usage/requests/${encodeURIComponent(requestId)}`;
}

async function fetchReceipt(
  requestId: string,
  apiKey: string,
  timeoutMs: number,
  retries: number,
) {
  return request<unknown>(
    receiptUrl(requestId),
    {
      method: 'GET',
      headers: { 'XAPI-KEY': apiKey },
    },
    timeoutMs,
    retries,
  );
}

async function waitForReceipt(
  requestId: string,
  apiKey: string,
  flags: Record<string, string>,
) {
  const intervalMs = parsePositiveDurationMs(flags.interval || '1s', '--interval');
  const timeoutMs = parsePositiveDurationMs(flags.timeout || '30s', '--timeout');
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      err(
        'usage receipt wait timeout',
        `request_id=${requestId}, elapsed_ms=${Date.now() - startedAt}, timeout_ms=${timeoutMs}`,
      );
    }

    try {
      return await fetchReceipt(requestId, apiKey, remainingMs, 0);
    } catch (e) {
      const pending = e instanceof HttpError && e.status === 404;
      if (!pending && !isRetryableRequestError(e)) throw e;
    }

    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

export async function usage(args: string[], flags: Record<string, string>) {
  if (flags.help) {
    console.log(USAGE_HELP);
    return;
  }
  const shouldWait = args[0] === 'wait';
  const requestId = args[shouldWait ? 1 : 0]?.trim();
  if (!requestId) {
    err(
      'request ID required',
      shouldWait
        ? 'Run: xapi-to usage wait <request-id>'
        : 'Run: xapi-to usage <request-id>',
    );
  }

  const cfg = getConfig();
  requireApiKey(cfg);

  try {
    const result = shouldWait
      ? await waitForReceipt(requestId!, cfg.apiKey!, flags)
      : await fetchReceipt(requestId!, cfg.apiKey!, 30_000, READ_RETRIES);
    output(result, flags.format as any);
  } catch (e: any) {
    err(
      shouldWait ? 'usage receipt wait failed' : 'usage receipt fetch failed',
      e.message,
    );
  }
}
