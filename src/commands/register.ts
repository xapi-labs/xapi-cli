/**
 * register command: create a new user account
 *
 * POST /auth/register — no auth required
 * Returns apiKey (shown once), claimCode, referralCode, claimUrl, tweetTemplate
 * Automatically saves apiKey to ~/.xapi/config.json
 *
 * Optional referral code (please replace xapito to the actual referral code):
 *   xapi register --referral-code xapito
 *   xapi register --referralCode xapito     # alias
 *   xapi register xapito                    # positional shorthand
 */

import { XAPI_API_HOST, saveConfig, scheme } from '../config.ts';
import { output, err } from '../format.ts';

interface RegisterResponse {
  apiKey: string;
  claimCode: string;
  referralCode?: string;
  claimSessionId: string;
  claimUrl: string;
  tweetTemplate: string;
  user: { id: string; accountType: string };
}

async function registerAccount(referralCode?: string): Promise<RegisterResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${scheme(XAPI_API_HOST)}://${XAPI_API_HOST}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(referralCode ? { referralCode } : {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json() as Promise<RegisterResponse>;
  } finally {
    clearTimeout(timer);
  }
}

export async function register(args: string[], flags: Record<string, string>) {
  try {
    // 邀请码来源优先级：--referral-code > --referralCode > 第一个位置参数
    const rawReferral =
      flags['referral-code'] ?? flags['referralCode'] ?? args[0];
    const referralCode =
      typeof rawReferral === 'string' && rawReferral !== 'true' && rawReferral.length > 0
        ? rawReferral
        : undefined;

    const res = await registerAccount(referralCode);

    saveConfig({ apiKey: res.apiKey });

    output({
      apiKey: res.apiKey,
      user: res.user,
      referralCode: res.referralCode,
      claim: {
        code: res.claimCode,
        sessionId: res.claimSessionId,
        url: res.claimUrl,
      },
      tweetTemplate: res.tweetTemplate,
      ...(referralCode ? { referredBy: referralCode } : {}),
      note: 'apiKey saved to ~/.xapi/config.json',
    }, flags.format as any);
  } catch (e: any) {
    err('register failed', e.message);
  }
}
