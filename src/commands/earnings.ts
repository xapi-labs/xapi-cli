/**
 * Agent provider economy commands. These use narrowly scoped XAPI-KEY routes
 * directly instead of exchanging the key for a broad JWT session.
 */

import { request } from '../client.ts';
import {
  getConfig,
  requireApiKey,
  XAPI_API_HOST,
  scheme,
} from '../config.ts';
import { err, output } from '../format.ts';

const READ_RETRIES = 2;

export const EARNINGS_HELP = `xapi-to earnings - Inspect and reinvest provider earnings

USAGE
  xapi-to earnings [summary] [--format json|pretty|table]
  xapi-to earnings list [--status PENDING|SETTLED] [--limit 20] [--cursor <id>]
  xapi-to earnings transfer <amount> --idempotency-key <key>

SCOPES
  summary/list  earnings:read
  transfer      earnings:transfer

The transfer is one-way: settled provider earnings become spendable xapi balance.
Reuse the same idempotency key only when retrying the same amount.
`;

function baseUrl() {
  return `${scheme(XAPI_API_HOST)}://${XAPI_API_HOST}/api/agent`;
}

function keyHeaders(apiKey: string) {
  return { 'Content-Type': 'application/json', 'XAPI-KEY': apiKey };
}

export async function earnings(
  args: string[],
  flags: Record<string, string>,
) {
  if (flags.help) {
    console.log(EARNINGS_HELP);
    return;
  }
  const cfg = getConfig();
  requireApiKey(cfg);
  const apiKey = cfg.apiKey!;
  const subcommand = args[0] ?? 'summary';

  try {
    if (subcommand === 'summary') {
      const result = await request<unknown>(
        `${baseUrl()}/economy`,
        { method: 'GET', headers: keyHeaders(apiKey) },
        30_000,
        READ_RETRIES,
      );
      output(result, flags.format as any);
      return;
    }

    if (subcommand === 'list') {
      const url = new URL(`${baseUrl()}/earnings`);
      if (flags.status) {
        const status = flags.status.toUpperCase();
        if (!['PENDING', 'SETTLED'].includes(status)) {
          err('invalid earnings status', 'Expected PENDING or SETTLED.');
        }
        url.searchParams.set('status', status);
      }
      if (flags.limit) {
        const limit = Number(flags.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          err('invalid earnings limit', 'Expected an integer from 1 to 100.');
        }
        url.searchParams.set('limit', String(limit));
      }
      if (flags.cursor) url.searchParams.set('cursor', flags.cursor);

      const result = await request<unknown>(
        url.toString(),
        { method: 'GET', headers: keyHeaders(apiKey) },
        30_000,
        READ_RETRIES,
      );
      output(result, flags.format as any);
      return;
    }

    if (subcommand === 'transfer') {
      const amount = Number(args[1]);
      if (!Number.isFinite(amount) || amount <= 0) {
        err('invalid transfer amount', 'Pass a positive USD amount.');
      }
      const idempotencyKey =
        flags['idempotency-key'] || flags.idempotencyKey;
      if (!idempotencyKey) {
        err(
          'idempotency key required',
          'Pass --idempotency-key <stable-key> and reuse it only when retrying this same transfer.',
        );
      }

      const result = await request<unknown>(
        `${baseUrl()}/earnings/transfer`,
        {
          method: 'POST',
          headers: keyHeaders(apiKey),
          body: JSON.stringify({ amount, idempotencyKey }),
        },
        30_000,
        // The server binds the idempotency key to the amount, so transport retries are safe.
        READ_RETRIES,
      );
      output(result, flags.format as any);
      return;
    }

    err(
      `unknown earnings command: ${subcommand}`,
      'Valid commands: summary, list, transfer.',
    );
  } catch (e: any) {
    err('earnings request failed', e.message);
  }
}
