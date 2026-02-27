/**
 * topup command
 *
 * Generates a payment URL pointing to the xapi frontend topup page.
 * All params are optional.
 *
 * Usage:
 *   xapi topup [--amount <usd>] [--method stripe|x402]
 */

import { getConfig } from '../config.ts';
import { output } from '../format.ts';

const TOPUP_BASE_URL = 'https://www.xapi.to/topup/payment';

export async function topup(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();

  const url = new URL(TOPUP_BASE_URL);

  if (cfg.apiKey) url.searchParams.set('apikey', cfg.apiKey);
  if (flags.method) url.searchParams.set('method', flags.method);

  const amountStr = flags.amount || args[0];
  if (amountStr) {
    const amountUsd = parseFloat(amountStr);
    if (!isNaN(amountUsd) && amountUsd > 0) {
      url.searchParams.set('amount', String(amountUsd));
    }
  }

  output({ url: url.toString() }, flags.format as any);
}
