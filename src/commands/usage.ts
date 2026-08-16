/** Read a finalized per-request cost receipt with the same key that made the call. */

import { request } from '../client.ts';
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

Use the request ID returned in X-XAPI-Request-Id or the final xapi.usage SSE event.
The receipt is visible only to the API key that made the request.
`;

export async function usage(args: string[], flags: Record<string, string>) {
  if (flags.help) {
    console.log(USAGE_HELP);
    return;
  }
  const requestId = args[0]?.trim();
  if (!requestId) err('request ID required', 'Run: xapi-to usage <request-id>');

  const cfg = getConfig();
  requireApiKey(cfg);

  try {
    const result = await request<unknown>(
      `${scheme(XAPI_API_HOST)}://${XAPI_API_HOST}/api/usage/requests/${encodeURIComponent(requestId!)}`,
      {
        method: 'GET',
        headers: { 'XAPI-KEY': cfg.apiKey! },
      },
      30_000,
      READ_RETRIES,
    );
    output(result, flags.format as any);
  } catch (e: any) {
    err('usage receipt fetch failed', e.message);
  }
}
