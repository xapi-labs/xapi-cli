#!/usr/bin/env bun
/**
 * OAuth bind 手动测试脚本
 *
 * 用法:
 *   bun scripts/test-oauth-bind.ts
 *
 * 环境变量:
 *   XAPI_API_HOST   后端地址 (默认: localhost:3033)
 *   XAPI_API_KEY    使用已有 API Key（不填则自动注册新账号）
 *   PROVIDER        OAuth provider 名称 (默认: twitter)
 */

import { spawnSync } from 'child_process';
import {
  loginWithApiKey,
  listKeys,
  enableOAuthForKey,
  listOAuthProviders,
  initiateOAuth,
  listOAuthBindings,
} from '../src/client.ts';

const API_HOST = process.env.XAPI_API_HOST || 'localhost:3033';
const BASE_URL = `http://${API_HOST}`;
const PROVIDER = (process.env.PROVIDER || 'twitter').toLowerCase();

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? 'start'
    : process.platform === 'darwin' ? 'open'
    : 'xdg-open';
  try { spawnSync(cmd, [url], { stdio: 'ignore' }); } catch {}
}

function log(msg: string) { console.log(`  ${msg}`); }
function sep() { console.log('  ' + '─'.repeat(55)); }

async function main() {
  console.log('\n  xapi OAuth Bind — 本地测试');
  sep();

  // 1. API Key
  let apiKey = process.env.XAPI_API_KEY || '';
  if (!apiKey) {
    log('未设置 XAPI_API_KEY，正在注册新账号...');
    const res = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      console.error(`  ✗ 注册失败: HTTP ${res.status}`);
      process.exit(1);
    }
    const data = await res.json() as any;
    apiKey = data.apiKey;
    log(`新账号 API Key: ${apiKey}`);
  } else {
    log(`使用已有 API Key: ${apiKey.slice(0, 14)}...`);
  }

  // 2. Login
  log('正在登录...');
  const loginResult = await loginWithApiKey(apiKey, API_HOST) as any;
  if (!loginResult?.accessToken) {
    console.error('  ✗ 登录失败');
    process.exit(1);
  }
  const jwt = loginResult.accessToken;
  log('登录成功');

  // 3. Find key record
  const keys = await listKeys(jwt, API_HOST) as any[];
  const prefix = apiKey.substring(0, 7);
  const keyRecord = keys.find((k: any) => k.keyPreview.startsWith(prefix)) ?? keys[0];
  const keyId = keyRecord.id;
  log(`Key ID: ${keyId}`);

  // 4. Enable OAuth
  if (!keyRecord.oauthEnabled) {
    log('开启 OAuth...');
    await enableOAuthForKey(keyId, apiKey, jwt, API_HOST);
    log('OAuth 已开启');
  }

  // 5. Find provider
  const providers = await listOAuthProviders(API_HOST) as any[];
  const provider = providers.find(
    (p: any) =>
      p.type?.toLowerCase().includes(PROVIDER) ||
      p.name?.toLowerCase().includes(PROVIDER),
  );
  if (!provider) {
    const available = providers.map((p: any) => p.type).join(', ');
    console.error(`  ✗ Provider "${PROVIDER}" 未找到，可用: ${available}`);
    process.exit(1);
  }

  // 6. Initiate
  log(`发起 ${provider.name} OAuth 授权...`);
  const init = await initiateOAuth(keyId, provider.id, jwt, API_HOST) as any;
  const { authorizationUrl } = init;

  sep();
  log(`Provider : ${provider.name}`);
  log(`Key      : ${keyRecord.keyPreview}`);
  log('');
  log('请在浏览器中完成授权:');
  log(authorizationUrl);
  sep();
  log('正在打开浏览器...');
  openBrowser(authorizationUrl);
  console.log('');

  // 7. Poll
  const timeoutMs = 5 * 60 * 1000;
  const intervalMs = 3_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const bindings = await listOAuthBindings(jwt, API_HOST) as any[];
      const match = bindings.find(
        (b: any) => b.apiKeyId === keyId && b.providerId === provider.id,
      );
      if (match) {
        const account = match.providerAccountName ?? match.providerAccountId;
        process.stdout.write('\r');
        sep();
        log(`✓ 授权成功！已绑定 @${account}`);
        log(`  Binding ID: ${match.id}`);
        sep();
        console.log('');
        process.exit(0);
      }
    } catch {}
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    process.stdout.write(`\r  等待授权完成... (${remaining}s)  `);
  }

  process.stdout.write('\n');
  console.error('  ✗ 超时：5 分钟内未完成授权');
  process.exit(1);
}

main().catch((e) => {
  console.error(`  ✗ 错误: ${e.message}`);
  process.exit(1);
});
