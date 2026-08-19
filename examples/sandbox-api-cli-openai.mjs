#!/usr/bin/env node

/**
 * Zero-context xAPI Sandbox walkthrough.
 *
 * It demonstrates three independent entry points against the test service:
 *   1. Direct Sandbox HTTP API lifecycle
 *   2. Local xapi-to CLI one-shot lifecycle
 *   3. OpenAI Agents SDK SandboxAgent + xAPI DeepSeek + xAPI Sandbox
 *
 * No instance ID is required. Every demo creates its own instance and verifies
 * termination/cost before returning. Credentials are read only from environment
 * variables or the normal local xAPI configuration and are never embedded here.
 *
 * Usage (run through the package script so dist/ is built first):
 *   npm run demo:sandbox
 *   npm run demo:sandbox -- api
 *   npm run demo:sandbox -- cli
 *   npm run demo:sandbox -- openai
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { OpenAIProvider, Runner } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { XapiAgentsSandboxClient } from '../dist/openai-sandbox-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../dist/index.js');
const mode = process.argv[2] || 'all';
const allowedModes = new Set(['all', 'api', 'cli', 'openai']);

if (!allowedModes.has(mode)) {
  throw new Error('usage: npm run demo:sandbox -- [all|api|cli|openai]');
}

const sandboxHost = process.env.XAPI_SANDBOX_HOST || 'sandbox.test.xapi.to';
const provider = process.env.XAPI_SANDBOX_PROVIDER || 'daytona';
const model = process.env.XAPI_MODEL || 'deepseek-v4-pro';
const maxHourlyUsd = Number(process.env.XAPI_SANDBOX_MAX_HOURLY_USD || '0.20');
const effectiveSandboxApiKey = process.env.XAPI_SANDBOX_KEY || process.env.XAPI_TEST_API_KEY;
const sandboxCredentialSource = process.env.XAPI_SANDBOX_KEY
  ? 'XAPI_SANDBOX_KEY'
  : process.env.XAPI_TEST_API_KEY
    ? 'XAPI_TEST_API_KEY'
    : null;

if (!effectiveSandboxApiKey) {
  throw new Error('set XAPI_SANDBOX_KEY (or XAPI_TEST_API_KEY) before running the Sandbox demo');
}

if (!Number.isFinite(maxHourlyUsd) || maxHourlyUsd <= 0) {
  throw new Error('XAPI_SANDBOX_MAX_HOURLY_USD must be a positive number');
}

function step(scope, message) {
  console.log(`\n[${scope}] ${message}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function loadAiApiKey() {
  if (process.env.XAPI_AI_KEY) return { apiKey: process.env.XAPI_AI_KEY, source: 'XAPI_AI_KEY' };
  try {
    const config = JSON.parse(await readFile(join(homedir(), '.xapi', 'config.json'), 'utf8'));
    if (typeof config?.apiKey === 'string' && config.apiKey.trim()) {
      return { apiKey: config.apiKey, source: '~/.xapi/config.json' };
    }
  } catch {
    // Fall through to the focused error below.
  }
  throw new Error(
    'OpenAI/DeepSeek demo needs a production ai.xapi.to credential in XAPI_AI_KEY ' +
    'or ~/.xapi/config.json; Sandbox and AI credentials are intentionally kept separate',
  );
}

function sandboxBaseUrl(host, pinnedProvider) {
  const url = new URL(host.includes('://') ? host : `https://${host}`);
  if (url.protocol !== 'https:') throw new Error('public Sandbox host must use HTTPS');
  if (!url.hostname.endsWith('.xapi.to')) throw new Error('Sandbox host must be under *.xapi.to');
  if (pinnedProvider && pinnedProvider !== 'auto') {
    assert(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(pinnedProvider), 'invalid provider');
    const labels = url.hostname.split('.');
    const sandboxIndex = labels.indexOf('sandbox');
    const productionAliases = { daytona: 'daytona-sandbox', e2b: 'e2b-sandbox' };
    const gatewayLabel = labels.slice(sandboxIndex).join('.') === 'sandbox.xapi.to'
      ? productionAliases[pinnedProvider] || pinnedProvider
      : pinnedProvider;
    if (sandboxIndex === 0) labels.unshift(gatewayLabel);
    else if (sandboxIndex === 1) labels[0] = gatewayLabel;
    else throw new Error('provider pinning requires a sandbox.<xapi-domain> host');
    url.hostname = labels.join('.');
  }
  return url.toString().replace(/\/$/, '');
}

async function apiRequest(apiKey, baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: 'error',
    ...init,
    headers: {
      accept: 'application/json',
      'xapi-key': apiKey,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${path} failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitForState(apiKey, baseUrl, id, wanted, timeoutMs = 360_000) {
  const deadline = Date.now() + timeoutMs;
  let detail;
  while (Date.now() < deadline) {
    detail = await apiRequest(apiKey, baseUrl, `/v1/sandboxes/${encodeURIComponent(id)}`);
    if (wanted.includes(detail.observedState)) return detail;
    if (['FAILED', 'TERMINATED'].includes(detail.observedState)) {
      throw new Error(`sandbox ${id} entered ${detail.observedState} while waiting for ${wanted.join('/')}`);
    }
    await sleep(2_000);
  }
  throw new Error(`sandbox ${id} did not enter ${wanted.join('/')} (last: ${detail?.observedState})`);
}

async function terminateApiSandbox(apiKey, baseUrl, id) {
  let detail = await apiRequest(apiKey, baseUrl, `/v1/sandboxes/${encodeURIComponent(id)}`);
  const deadline = Date.now() + 360_000;
  const idempotencyKey = `demo:api:terminate:${randomUUID()}`;
  while (!['TERMINATED', 'FAILED'].includes(detail.observedState) && Date.now() < deadline) {
    try {
      await apiRequest(apiKey, baseUrl, `/v1/sandboxes/${encodeURIComponent(id)}/terminate`, {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey }),
      });
      return waitForState(apiKey, baseUrl, id, ['TERMINATED', 'FAILED'], deadline - Date.now());
    } catch (error) {
      detail = await apiRequest(apiKey, baseUrl, `/v1/sandboxes/${encodeURIComponent(id)}`);
      if (['TERMINATED', 'FAILED'].includes(detail.observedState)) return detail;
      if (!String(error?.message || error).includes('HTTP 409')) throw error;
      await sleep(2_000);
    }
  }
  if (!['TERMINATED', 'FAILED'].includes(detail.observedState)) {
    throw new Error(`sandbox ${id} cleanup timed out in ${detail.observedState}`);
  }
  return detail;
}

function itemCount(value) {
  if (Array.isArray(value)) return value.length;
  return value?.items?.length ?? value?.data?.length ?? 0;
}

function items(value) {
  if (Array.isArray(value)) return value;
  return value?.items ?? value?.data ?? [];
}

async function readAndVerifyAudit(apiKey, baseUrl, id) {
  const audit = {};
  for (const kind of ['operations', 'events', 'usageSegments', 'billingPeriods']) {
    audit[kind] = await apiRequest(
      apiKey,
      baseUrl,
      `/v1/sandboxes/${encodeURIComponent(id)}/audit?kind=${kind}&page=1&pageSize=100`,
    );
  }
  const operations = items(audit.operations);
  const events = items(audit.events);
  const usageSegments = items(audit.usageSegments);
  const billingPeriods = items(audit.billingPeriods);
  assert(operations.length > 0, `sandbox ${id} has no operations audit`);
  assert(operations.every((item) => item.status === 'SUCCEEDED'), `sandbox ${id} has a non-SUCCEEDED operation`);
  assert(events.some((item) => item.currentState === 'TERMINATED'), `sandbox ${id} has no TERMINATED event`);
  assert(usageSegments.length > 0, `sandbox ${id} has no usage segments`);
  assert(usageSegments.every((item) => item.status === 'SETTLED' && item.endsAt), `sandbox ${id} has open usage`);
  assert(billingPeriods.length > 0, `sandbox ${id} has no billing periods`);
  assert(billingPeriods.every((item) => item.status === 'SETTLED' && item.endedAt), `sandbox ${id} has open billing`);
  return Object.fromEntries(Object.entries(audit).map(([kind, value]) => [kind, itemCount(value)]));
}

async function runApiDemo(apiKey) {
  const scope = 'API';
  const baseUrl = sandboxBaseUrl(sandboxHost, provider);
  let id;
  let finalDetail;
  let failure;

  step(scope, `1/7 获取 Offering（${baseUrl}）`);
  const offerings = await apiRequest(apiKey, baseUrl, '/v1/offerings');
  assert(Array.isArray(offerings) && offerings.length > 0, 'no Sandbox offerings returned');

  try {
    step(scope, '2/7 按 exec/files 能力和价格上限获取报价');
    const quote = await apiRequest(apiKey, baseUrl, '/v1/quotes', {
      method: 'POST',
      body: JSON.stringify({
        requirements: { capabilities: ['exec', 'files'] },
        maxEstimatedHourlyUsd: maxHourlyUsd.toFixed(8),
      }),
    });
    assert(quote.quoteId, 'quote response did not include quoteId');

    step(scope, '3/7 使用 quoteId 和幂等键创建实例');
    const created = await apiRequest(apiKey, baseUrl, '/v1/sandboxes', {
      method: 'POST',
      body: JSON.stringify({
        selection: { quoteId: quote.quoteId },
        metadata: { client: 'sandbox-api-cli-openai-demo', scenario: 'direct-api' },
        idempotencyKey: `demo:api:create:${randomUUID()}`,
      }),
    });
    id = created.id;
    assert(id, 'create response did not include sandbox id');

    step(scope, `4/7 等待实例 ${id} 进入 RUNNING`);
    await waitForState(apiKey, baseUrl, id, ['RUNNING']);

    step(scope, '5/7 执行真实 Shell 命令并验证 marker');
    const result = await apiRequest(apiKey, baseUrl, `/v1/sandboxes/${encodeURIComponent(id)}/commands`, {
      method: 'POST',
      body: JSON.stringify({ command: 'printf "API_DEMO_OK=42\\n"', timeoutSeconds: 60 }),
    });
    assert(result.exitCode === 0, `remote exit code was ${result.exitCode}`);
    assert(String(result.stdout).includes('API_DEMO_OK=42'), 'API marker was not returned');
  } catch (error) {
    failure = error;
  } finally {
    if (id) {
      step(scope, '6/7 finally 终止实例并等待服务端终态');
      try { finalDetail = await terminateApiSandbox(apiKey, baseUrl, id); }
      catch (error) { failure ||= error; }
    }
  }

  if (failure) throw failure;
  assert(finalDetail?.observedState === 'TERMINATED', `API instance ended in ${finalDetail?.observedState}`);
  assert(finalDetail.totalCost !== undefined, 'API final cost is missing');

  step(scope, '7/7 验证操作、事件、用量、账单与最终费用');
  const audits = await readAndVerifyAudit(apiKey, baseUrl, id);
  return {
    instanceId: id,
    marker: 'API_DEMO_OK=42',
    finalState: finalDetail.observedState,
    totalCost: finalDetail.totalCost,
    auditCounts: audits,
  };
}

async function runProcess(command, args, env = process.env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', rejectRun);
    child.once('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function runCliDemo(apiKey) {
  const scope = 'CLI';
  step(scope, '调用本地构建的 xapi-to sandbox run');
  const executed = await runProcess(process.execPath, [
    CLI,
    'sandbox', 'run',
    '--host', sandboxHost,
    '--provider', provider,
    '--max-hourly-usd', maxHourlyUsd.toFixed(2),
    '--command', 'printf "CLI_DEMO_OK=42\\n"',
  ], { ...process.env, XAPI_KEY: apiKey, XAPI_API_KEY: '' });
  if (executed.code !== 0) {
    throw new Error(`CLI exited ${executed.code}: ${executed.stderr || executed.stdout}`);
  }
  const result = JSON.parse(executed.stdout);
  assert(result.result?.exitCode === 0, 'CLI remote command failed');
  assert(String(result.result?.stdout).includes('CLI_DEMO_OK=42'), 'CLI marker was not returned');
  assert(result.finalState === 'TERMINATED', `CLI instance ended in ${result.finalState}`);
  assert(result.cleanup?.operationStatus === 'SUCCEEDED', 'CLI cleanup operation did not succeed');
  assert(result.cleanup?.state === 'TERMINATED', 'CLI cleanup did not reach TERMINATED');
  assert(result.totalCost !== undefined, 'CLI final cost is missing');
  const auditCounts = await readAndVerifyAudit(
    apiKey,
    sandboxBaseUrl(sandboxHost, provider),
    result.instanceId,
  );
  return {
    instanceId: result.instanceId,
    clientIdempotencyKey: result.clientIdempotencyKey,
    marker: 'CLI_DEMO_OK=42',
    finalState: result.finalState,
    cleanup: result.cleanup,
    totalCost: result.totalCost,
    auditCounts,
  };
}

async function runOpenAiDemo(sandboxKey, aiKey) {
  const scope = 'OPENAI';
  const sandbox = new XapiAgentsSandboxClient({
    apiKey: sandboxKey,
    sandboxHost,
    provider,
    maxHourlyUsd,
    model,
  });
  const modelProvider = new OpenAIProvider({
    apiKey: aiKey,
    baseURL: 'https://ai.xapi.to/v1',
    useResponses: false,
    strictFeatureValidation: true,
  });
  const runner = new Runner({ modelProvider, tracingDisabled: true });
  const agent = new SandboxAgent({
    name: 'xAPI DeepSeek demo agent',
    model,
    defaultManifest: new Manifest({ root: sandbox.workspaceRoot }),
    capabilities: [shell()],
    instructions: [
      'Work only inside the sandbox workspace.',
      'Use one shell call to write exactly SDK_OK=42 to result.txt.',
      'Use a second shell call to read result.txt.',
      'After the output is verified, reply exactly SDK_OK=42.',
    ].join(' '),
  });

  let finalOutput = '';
  let failure;
  step(scope, `DeepSeek (${model}) 通过 ai.xapi.to 驱动 SandboxAgent`);
  try {
    const result = await runner.run(agent, 'Create and verify result.txt now.', {
      maxTurns: 8,
      sandbox: { client: sandbox },
    });
    finalOutput = String(result.finalOutput || '');
    assert(finalOutput.includes('SDK_OK=42'), 'OpenAI agent final marker was not returned');
    // One call prepares the workspace; the Agent must add separate write/read calls.
    assert(sandbox.evidence.execCount >= 3, 'OpenAI agent did not perform separate write/read shell calls');
    assert(sandbox.evidence.shellMarkerSeen, 'OpenAI agent shell output did not contain the marker');
  } catch (error) {
    failure = error;
  } finally {
    step(scope, '关闭 SDK Session，终止实例并读取审计与费用');
    try { await sandbox.lastSession?.close(); }
    catch (error) { failure ||= error; }
  }
  if (failure) throw failure;
  assert(sandbox.evidence.finalState === 'TERMINATED', `OpenAI instance ended in ${sandbox.evidence.finalState}`);
  assert(sandbox.evidence.totalCost !== undefined, 'OpenAI final cost is missing');
  const auditCounts = await readAndVerifyAudit(
    sandboxKey,
    sandboxBaseUrl(sandboxHost, provider),
    sandbox.evidence.instanceId,
  );
  return {
    modelGateway: 'https://ai.xapi.to/v1',
    model,
    tracingDisabled: true,
    finalOutput,
    ...sandbox.evidence,
    auditCounts,
  };
}

async function finalActiveGate(apiKey, testInstanceIds) {
  const baseUrl = sandboxBaseUrl(sandboxHost, 'auto');
  const active = await apiRequest(apiKey, baseUrl, '/v1/sandbox-history?state=ACTIVE&page=1&pageSize=100');
  const count = Number(active.total ?? itemCount(active));
  const activeIds = new Set(items(active).map((item) => item.id).filter(Boolean));
  const testCreatedActiveInstances = testInstanceIds.filter((id) => activeIds.has(id));
  return {
    accountActiveInstances: count,
    testCreatedActiveInstances,
    stateCounts: active.stateCounts,
  };
}

const aiCredential = await loadAiApiKey();
const report = {
  status: 'running',
  mode,
  sandboxHost,
  provider,
  model,
  environment: {
    sandbox: sandboxHost.includes('.test.') ? 'test' : 'production',
    modelGateway: 'production (ai.xapi.to has no test environment)',
  },
  credentials: {
    sandbox: { source: sandboxCredentialSource },
    ai: { source: aiCredential.source },
  },
  startedAt: new Date().toISOString(),
  results: {},
};

try {
  if (mode === 'all' || mode === 'api') {
    report.results.api = await runApiDemo(effectiveSandboxApiKey);
  }
  if (mode === 'all' || mode === 'cli') {
    report.results.cli = await runCliDemo(effectiveSandboxApiKey);
  }
  if (mode === 'all' || mode === 'openai') {
    report.results.openai = await runOpenAiDemo(effectiveSandboxApiKey, aiCredential.apiKey);
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    const testInstanceIds = Object.values(report.results)
      .map((result) => result?.instanceId)
      .filter(Boolean);
    report.finalGate = await finalActiveGate(effectiveSandboxApiKey, testInstanceIds);
    if (report.finalGate.testCreatedActiveInstances.length !== 0) {
      report.status = 'failed';
      report.error ||= `${report.finalGate.testCreatedActiveInstances.length} demo Sandbox instances remain active`;
      process.exitCode = 1;
    }
  } catch (error) {
    report.status = 'failed';
    report.error ||= `final active-instance gate failed: ${error instanceof Error ? error.message : String(error)}`;
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  console.log(`\n${JSON.stringify(report, null, 2)}`);
}
