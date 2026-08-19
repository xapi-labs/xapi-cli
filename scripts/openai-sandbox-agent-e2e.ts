#!/usr/bin/env bun

/**
 * Real OpenAI Sandbox Agents SDK integration:
 *   model harness  -> DeepSeek through https://ai.xapi.to/v1
 *   sandbox compute -> xAPI Sandbox Gateway
 *
 * The adapter intentionally implements the smallest honest contract required
 * by this example: an empty Manifest plus the SDK Shell capability. The xAPI
 * credentials come from env/normal CLI config, are never accepted on argv,
 * never enter the model prompt or sandbox, and are never written to the report.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  OpenAIProvider,
  Runner,
} from '@openai/agents';
import {
  Manifest,
  SandboxAgent,
  shell,
} from '@openai/agents/sandbox';
import { getConfig } from '../src/config.ts';
import { XapiAgentsSandboxClient } from '../src/openai-sandbox-client.ts';
import { sandboxHistory } from '../src/sandbox-client.ts';

const argv = process.argv.slice(2);
const usage = `Usage: bun scripts/openai-sandbox-agent-e2e.ts [options]\n\n` +
  `  --host HOST       Sandbox Gateway (default: sandbox.test.xapi.to)\n` +
  `  --provider NAME   Sandbox provider (default: daytona)\n` +
  `  --model NAME      ai.xapi.to model (default: deepseek-v4-pro)\n` +
  `  --report FILE     Redacted JSON report path\n`;
if (argv.includes('--help')) {
  process.stdout.write(usage);
  process.exit(0);
}
const valueFlags = new Set(['--host', '--provider', '--model', '--report']);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (!valueFlags.has(arg)) throw new Error(`unknown argument: ${arg}; use --help`);
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
    throw new Error(`${arg} requires a value`);
  }
  index += 1;
}
const after = (name: string, fallback: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || fallback : fallback;
};
const sandboxHost = after('--host', process.env.XAPI_SANDBOX_HOST || 'sandbox.test.xapi.to');
const provider = after('--provider', 'daytona');
const model = after('--model', 'deepseek-v4-pro');
const reportPath = resolve(after(
  '--report',
  `/tmp/xapi-openai-sandbox-agent-${new Date().toISOString().replaceAll(':', '-')}.json`,
));
const startedAt = new Date();

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function probeDeepSeek(apiKey: string) {
  const response = await fetch('https://ai.xapi.to/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply exactly XAPI_DEEPSEEK_OK' }],
      temperature: 0,
      max_tokens: 128,
    }),
  });
  const body = await response.json() as any;
  const content = String(body?.choices?.[0]?.message?.content || '');
  assert(response.ok, `ai.xapi.to DeepSeek probe failed with HTTP ${response.status}`);
  assert(content.includes('XAPI_DEEPSEEK_OK'), 'DeepSeek probe did not return its marker');
  return {
    status: response.status,
    gatewayProvider: response.headers.get('x-routing-provider'),
    model: body?.model,
    markerVerified: true,
    usage: body?.usage,
  };
}

const cfg = getConfig();
const configuredApiKey = process.env.XAPI_KEY || process.env.XAPI_API_KEY || cfg.apiKey;
const configuredKeySource = process.env.XAPI_KEY
  ? 'XAPI_KEY'
  : process.env.XAPI_API_KEY
    ? 'XAPI_API_KEY'
    : '~/.xapi/config.json';
const sandboxApiKey =
  process.env.XAPI_SANDBOX_KEY || process.env.XAPI_TEST_API_KEY || configuredApiKey;
const aiApiKey = process.env.XAPI_AI_KEY || configuredApiKey;
const sandboxKeySource = process.env.XAPI_SANDBOX_KEY
  ? 'XAPI_SANDBOX_KEY'
  : process.env.XAPI_TEST_API_KEY
    ? 'XAPI_TEST_API_KEY'
    : configuredKeySource;
const aiKeySource = process.env.XAPI_AI_KEY ? 'XAPI_AI_KEY' : configuredKeySource;
assert(
  sandboxApiKey,
  'Sandbox key is not configured; set XAPI_SANDBOX_KEY (or XAPI_TEST_API_KEY/XAPI_KEY)',
);
assert(
  aiApiKey,
  'AI Gateway key is not configured; set XAPI_AI_KEY (or configure a production xAPI key)',
);
const report: Record<string, unknown> = {
  startedAt: startedAt.toISOString(),
  modelGateway: 'https://ai.xapi.to/v1',
  model,
  sandboxHost,
  provider,
  credentials: {
    sandbox: { source: sandboxKeySource },
    ai: { source: aiKeySource },
  },
};
let failure: unknown;
const sandboxClient = new XapiAgentsSandboxClient({
  apiKey: sandboxApiKey,
  sandboxHost,
  provider,
  maxHourlyUsd: 0.20,
  model,
});
const workspaceRoot = sandboxClient.workspaceRoot;

try {
  report.deepSeekProbe = await probeDeepSeek(aiApiKey);
  const modelProvider = new OpenAIProvider({
    apiKey: aiApiKey,
    baseURL: 'https://ai.xapi.to/v1',
    useResponses: false,
    strictFeatureValidation: true,
  });
  const runner = new Runner({ modelProvider, tracingDisabled: true });
  const agent = new SandboxAgent({
    name: 'xAPI OpenAI Sandbox verifier',
    model,
    defaultManifest: new Manifest({ root: workspaceRoot }),
    capabilities: [shell()],
    instructions:
      'You are validating a real sandbox. You MUST use the shell tool. ' +
      `Run a Python command that writes ${workspaceRoot}/result.txt containing ` +
      'OPENAI_XAPI_SANDBOX_OK=42, then use shell to read that file. ' +
      'Only after the shell output confirms it, answer exactly OPENAI_XAPI_SANDBOX_OK=42.',
  });
  const result = await runner.run(
    agent,
    'Perform the sandbox verification now.',
    { maxTurns: 8, sandbox: { client: sandboxClient } },
  );
  const finalOutput = String(result.finalOutput || '');
  assert(finalOutput.includes('OPENAI_XAPI_SANDBOX_OK=42'), 'agent final output missed marker');
  assert(sandboxClient.evidence.execCount >= 2, 'agent did not perform write and read shell work');
  assert(sandboxClient.evidence.shellMarkerSeen, 'real sandbox shell output missed marker');
  report.sdk = {
    package: '@openai/agents',
    version: '0.15.0',
    transport: 'OpenAI Chat Completions compatible',
    tracingDisabled: true,
    finalMarkerVerified: true,
  };
  report.sandbox = sandboxClient.evidence;
} catch (error) {
  failure = error;
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  if (sandboxClient.lastSession && !sandboxClient.evidence.finalState) {
    await sandboxClient.lastSession.close().catch((error) => {
      failure ||= error;
      report.cleanupError = error instanceof Error ? error.message : String(error);
    });
  }
  try {
    const active = await sandboxHistory({ sandboxHost, apiKey: sandboxApiKey }, {
      state: 'ACTIVE', pageSize: 100,
    });
    const count = active?.total ?? active?.items?.length ?? -1;
    const testInstanceId = sandboxClient.evidence.instanceId;
    const testInstanceActive = Boolean(
      testInstanceId && active?.items?.some((item: any) => item.id === testInstanceId),
    );
    report.finalGate = {
      accountActiveInstances: count,
      testInstanceId,
      testInstanceActive,
      stateCounts: active?.stateCounts,
    };
    if (testInstanceActive) failure ||= new Error(`test sandbox ${testInstanceId} remains active`);
  } catch (error) {
    failure ||= error;
    report.finalGate = { error: error instanceof Error ? error.message : String(error) };
  }
  report.status = failure ? 'failed' : 'passed';
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    status: report.status,
    model,
    provider,
    report: reportPath,
    sandbox: sandboxClient.evidence,
    finalGate: report.finalGate,
  }, null, 2));
}

if (failure) {
  console.error(failure instanceof Error ? failure.stack : String(failure));
  process.exitCode = 1;
}
