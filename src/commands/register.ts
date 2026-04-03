/**
 * register command: create a new user account
 *
 * POST /auth/register — no auth required
 * Returns apiKey (shown once), claimCode, claimUrl, tweetTemplate
 * Automatically saves apiKey to ~/.xapi/config.json
 */

import { XAPI_API_HOST, saveConfig, scheme } from '../config.ts';
import { output, err } from '../format.ts';

async function registerAccount(referralCode?: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const body: Record<string, string> = {};
    if (referralCode) body.referralCode = referralCode;

    const res = await fetch(`${scheme(XAPI_API_HOST)}://${XAPI_API_HOST}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json() as Promise<{
      apiKey: string;
      claimCode: string;
      referralCode: string;
      claimSessionId: string;
      claimUrl: string;
      tweetTemplate: string;
      user: { id: string; accountType: string };
    }>;
  } finally {
    clearTimeout(timer);
  }
}

export async function register(args: string[], flags: Record<string, string>) {
  try {
    const res = await registerAccount(flags.referral);

    // auto-save apiKey
    saveConfig({ apiKey: res.apiKey });

    output({
      apiKey: res.apiKey,
      referralCode: res.referralCode,
      user: res.user,
      claim: {
        code: res.claimCode,
        sessionId: res.claimSessionId,
        url: res.claimUrl,
      },
      tweetTemplate: res.tweetTemplate,
      note: 'apiKey saved to ~/.xapi/config.json',
    }, flags.format as any);
  } catch (e: any) {
    err('register failed', e.message);
  }
}
