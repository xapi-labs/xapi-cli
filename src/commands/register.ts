/**
 * register command: create a new user account
 *
 * POST /auth/register — no auth required
 * Returns apiKey (shown once), referralCode, and the Twitter OAuth account-bind URL
 * Automatically saves apiKey to ~/.xapi/config.json
 *
 * Optional referral code (please replace xapito to the actual referral code):
 *   xapi-to register --referral-code xapito
 *   xapi-to register --referralCode xapito     # alias
 *   xapi-to register xapito                    # positional shorthand
 */

import { XAPI_API_HOST, getConfig, saveConfig, scheme, assertAllowedHost } from '../config.ts';
import { output, err } from '../format.ts';

interface RegisterResponse {
  apiKey: string;
  referralCode: string;
  bindUrl?: string;
  claimUrl?: string;
  user: { id: string; accountType: string };
}

async function registerAccount(referralCode?: string): Promise<RegisterResponse> {
  assertAllowedHost(XAPI_API_HOST);
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
    const cfg = getConfig();
    const force = flags.force === 'true' || flags.force === '1' || flags.force === 'yes';
    if (cfg.apiKey && !force) {
      err('register would overwrite existing apiKey', 'Run "xapi-to register --force" to create a new account and replace the saved key.');
    }

    // 邀请码来源优先级：--referral-code > --referralCode > 第一个位置参数
    const rawReferral =
      flags['referral-code'] ?? flags['referralCode'] ?? args[0];
    const referralCode =
      typeof rawReferral === 'string' && rawReferral !== 'true' && rawReferral.length > 0
        ? rawReferral
        : undefined;

    const res = await registerAccount(referralCode);
    const bindUrl = res.bindUrl || res.claimUrl;

    saveConfig({ apiKey: res.apiKey });

    output({
      apiKey: res.apiKey,
      user: res.user,
      referralCode: res.referralCode,
      bindUrl,
      // Keep the backend's legacy field visible while clients migrate to bindUrl.
      claimUrl: res.claimUrl || bindUrl,
      ...(referralCode ? { referredBy: referralCode } : {}),
      note: force && cfg.apiKey
        ? 'apiKey replaced in ~/.xapi/config.json'
        : 'apiKey saved to ~/.xapi/config.json',
    }, flags.format as any);
  } catch (e: any) {
    err('register failed', e.message);
  }
}
