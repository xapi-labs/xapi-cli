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

import { XAPI_API_HOST, getApiKeySource, getConfig, saveConfig, scheme, assertAllowedHost } from '../config.ts';
import { output, err } from '../format.ts';

interface RegisterResponse {
  apiKey: string;
  referralCode: string;
  bindUrl?: string;
  claimUrl?: string;
  user: { id: string; accountType: string };
}

export const REGISTER_HELP = `xapi-to register - Create a new xAPI account

USAGE
  xapi-to register [referral-code] [flags]

FLAGS
  --referral-code <code>    Submit an inviter's referral code
  --referralCode <code>     Alias for --referral-code
  --force                   Replace an existing file-based API key
  --format json|pretty|table  Output format

The API key is saved to ~/.xapi/config.json. If XAPI_KEY or XAPI_API_KEY is set,
unset it before registering because environment variables override the saved file.
`;

function validateRegisterResponse(value: unknown): RegisterResponse {
  const res = value as Partial<RegisterResponse> | null;
  if (!res || typeof res.apiKey !== 'string' || !res.apiKey.trim()) {
    throw new Error('invalid register response: missing apiKey');
  }
  if (typeof res.referralCode !== 'string' || !res.user || typeof res.user.id !== 'string') {
    throw new Error('invalid register response: missing account details');
  }
  return res as RegisterResponse;
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
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`refusing to follow redirect to "${res.headers.get('location') ?? '?'}"`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return validateRegisterResponse(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

export async function register(args: string[], flags: Record<string, string>) {
  if (flags.help) {
    console.log(REGISTER_HELP);
    return;
  }
  try {
    const cfg = getConfig();
    const force = flags.force === 'true' || flags.force === '1' || flags.force === 'yes';
    const source = getApiKeySource();
    if (source === 'XAPI_KEY' || source === 'XAPI_API_KEY') {
      err(
        'register cannot replace an API key supplied by an environment variable',
        `Unset ${source} first; it would continue to override the newly saved key.`,
      );
    }
    if (cfg.apiKey && !force) {
      err('register would overwrite existing apiKey', 'Run "xapi-to register --force" to create a new account and replace the saved key.');
    }

    // 邀请码来源优先级：--referral-code > --referralCode > 第一个位置参数
    const rawReferral =
      flags['referral-code'] ?? flags['referralCode'] ?? args[0];
    if (rawReferral === 'true') {
      err('--referral-code requires a code');
    }
    const referralCode =
      typeof rawReferral === 'string' && rawReferral.length > 0
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
      // The backend may accept the registration while ignoring an invalid code,
      // so only report that the code was submitted, not that a referral exists.
      ...(referralCode ? { referralCodeProvided: referralCode } : {}),
      note: force && cfg.apiKey
        ? 'apiKey replaced in ~/.xapi/config.json'
        : 'apiKey saved to ~/.xapi/config.json',
    }, flags.format as any);
  } catch (e: any) {
    err('register failed', e.message);
  }
}
