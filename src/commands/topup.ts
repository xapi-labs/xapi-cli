/**
 * topup command
 *
 * Generates a payment URL pointing to the xapi frontend topup page.
 * All params are optional.
 *
 * Usage:
 *   xapi-to topup [--amount <usd>] [--method stripe|x402]
 */

import { getConfig } from '../config.ts';
import { output, err } from '../format.ts';

const TOPUP_BASE_URL = 'https://www.xapi.to/topup/payment';

export const TOPUP_HELP = `xapi-to topup - Generate a private payment URL

USAGE
  xapi-to topup [--amount <usd>] [--method stripe|x402]

The generated URL can contain your API key. Do not log or share it.
`;

export async function topup(args: string[], flags: Record<string, string>) {
  if (flags.help) {
    console.log(TOPUP_HELP);
    return;
  }
  const cfg = getConfig();

  const url = new URL(TOPUP_BASE_URL);

  if (cfg.apiKey) url.searchParams.set('apikey', cfg.apiKey);
  if (flags.method) {
    if (!['stripe', 'x402'].includes(flags.method)) {
      err('invalid --method value', 'Expected stripe or x402.');
    }
    url.searchParams.set('method', flags.method);
  }

  const amountStr = flags.amount || args[0];
  if (amountStr) {
    const normalizedAmount = amountStr.trim();
    const amountUsd = Number(normalizedAmount);
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalizedAmount) || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      err('invalid top-up amount', 'Expected a positive USD number, e.g. --amount 10.');
    }
    url.searchParams.set('amount', String(amountUsd));
  }

  output({ url: url.toString() }, flags.format as any);
}
