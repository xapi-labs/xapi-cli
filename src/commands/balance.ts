/**
 * balance command
 * Fetches balance from GET /auth/me
 */

import { getConfig, requireApiKey, XAPI_API_HOST, scheme } from '../config.ts';
import { loginWithApiKey, request } from '../client.ts';
import { output, err } from '../format.ts';

export async function balance(args: string[], flags: Record<string, string>) {
  const cfg = getConfig();
  requireApiKey(cfg);

  let token: string;
  try {
    const res = await loginWithApiKey(cfg.apiKey!, XAPI_API_HOST);
    token = res.accessToken;
  } catch (e: any) {
    err('login failed', e.message);
  }

  try {
    const me = await request<{ balance: string; accountType: string; tier: string }>(
      `${scheme(XAPI_API_HOST)}://${XAPI_API_HOST}/api/auth/me`,
      { method: 'GET', headers: { Authorization: `Bearer ${token!}` } },
    );
    output({
      balance: me.balance,
      accountType: me.accountType,
      tier: me.tier,
    }, flags.format as any);
  } catch (e: any) {
    err('balance fetch failed', e.message);
  }
}
