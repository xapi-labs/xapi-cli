/**
 * balance command
 * Fetches balance from GET /auth/me
 */

import { getConfig, requireApiKey, XAPI_API_HOST, scheme } from '../config.ts';
import { HttpError, request } from '../client.ts';
import { dropSession, sessionToken } from '../session.ts';
import { output, err } from '../format.ts';

export const BALANCE_HELP = `xapi-to balance - Show the current account balance

USAGE
  xapi-to balance [--format json|pretty|table]
`;

export async function balance(args: string[], flags: Record<string, string>) {
  if (flags.help) {
    console.log(BALANCE_HELP);
    return;
  }
  const cfg = getConfig();
  requireApiKey(cfg);

  const apiKey = cfg.apiKey!;
  const readMe = async (token: string) => request<{ balance: string; accountType: string; tier: string }>(
    `${scheme(XAPI_API_HOST)}://${XAPI_API_HOST}/api/auth/me`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
  );

  let token: string;
  try {
    token = await sessionToken(apiKey, XAPI_API_HOST);
  } catch (e: any) {
    err('login failed', e.message);
  }

  let me: { balance: string; accountType: string; tier: string };
  try {
    try {
      me = await readMe(token!);
    } catch (e) {
      // A reused session can be revoked or expire early; log in once more.
      if (!(e instanceof HttpError) || e.status !== 401) throw e;
      dropSession(apiKey, XAPI_API_HOST);
      me = await readMe(await sessionToken(apiKey, XAPI_API_HOST));
    }
  } catch (e: any) {
    err('balance fetch failed', e.message);
  }
  output({
    balance: me!.balance,
    accountType: me!.accountType,
    tier: me!.tier,
  }, flags.format as any);
}
