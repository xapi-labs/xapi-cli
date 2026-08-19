#!/usr/bin/env bun

/**
 * Local OpenAI SandboxAgent + xAPI example.
 *
 * This file imports the xAPI adapter from ../src, so it works before the next
 * xapi-to package release. The model call uses DeepSeek through ai.xapi.to;
 * shell execution uses the xAPI Sandbox test gateway by default.
 */

import { OpenAIProvider, Runner } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { getConfig } from '../src/config.ts';
import { XapiAgentsSandboxClient } from '../src/openai-sandbox-client.ts';

const configuredApiKey = process.env.XAPI_KEY || process.env.XAPI_API_KEY || getConfig().apiKey;
const sandboxApiKey =
  process.env.XAPI_SANDBOX_KEY || process.env.XAPI_TEST_API_KEY || configuredApiKey;
const aiApiKey = process.env.XAPI_AI_KEY || configuredApiKey;

if (!sandboxApiKey) {
  throw new Error(
    'Sandbox key is required. Set XAPI_SANDBOX_KEY (or XAPI_TEST_API_KEY/XAPI_KEY).',
  );
}
if (!aiApiKey) {
  throw new Error(
    'AI Gateway key is required. Set XAPI_AI_KEY (or configure a production xAPI key).',
  );
}

const sandboxHost = process.env.XAPI_SANDBOX_HOST || 'sandbox.test.xapi.to';
const provider = process.env.XAPI_SANDBOX_PROVIDER || 'daytona';
const model = process.env.XAPI_MODEL || 'deepseek-v4-pro';
const maxHourlyUsd = Number(process.env.XAPI_SANDBOX_MAX_HOURLY_USD || '0.20');

if (!Number.isFinite(maxHourlyUsd) || maxHourlyUsd <= 0) {
  throw new Error('XAPI_SANDBOX_MAX_HOURLY_USD must be a positive number');
}

// Compute plane: xAPI quotes, creates, executes, audits, bills, and terminates.
const sandbox = new XapiAgentsSandboxClient({
  apiKey: sandboxApiKey,
  sandboxHost,
  provider,
  maxHourlyUsd,
  model,
});

// Model plane: DeepSeek through xAPI's OpenAI Chat Completions-compatible API.
const modelProvider = new OpenAIProvider({
  apiKey: aiApiKey,
  baseURL: 'https://ai.xapi.to/v1',
  useResponses: false,
  strictFeatureValidation: true,
});

// The xAPI key is not an OpenAI telemetry credential.
const runner = new Runner({ modelProvider, tracingDisabled: true });

const agent = new SandboxAgent({
  name: 'xAPI DeepSeek local sandbox agent',
  model,
  defaultManifest: new Manifest({ root: sandbox.workspaceRoot }),
  capabilities: [shell()],
  instructions: [
    'Work only inside the sandbox workspace.',
    'Use shell to complete the task.',
    'Use two separate shell calls: first write the artifact, then read it back.',
    'Verify the shell output before reporting success.',
  ].join(' '),
});

let finalOutput = '';
let failure: unknown;
let cleanupError: string | undefined;
const startedAt = new Date();

try {
  const result = await runner.run(
    agent,
    'Write exactly SDK_OK=42 to result.txt. Then read result.txt and verify it. ' +
      'Only after the shell output confirms the marker, reply exactly SDK_OK=42.',
    {
      maxTurns: 8,
      sandbox: { client: sandbox },
    },
  );

  finalOutput = String(result.finalOutput || '');
  if (!finalOutput.includes('SDK_OK=42')) {
    throw new Error(`agent final output did not contain SDK_OK=42: ${finalOutput}`);
  }
  if (sandbox.evidence.execCount < 2) {
    throw new Error(`expected at least 2 shell calls, got ${sandbox.evidence.execCount}`);
  }
} catch (error) {
  failure = error;
} finally {
  try {
    // close() terminates the instance, waits for a terminal state, then reads
    // operations, events, usage segments, billing periods, and final cost.
    await sandbox.lastSession?.close();
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
    failure ||= error;
  }
}

const report = {
  status: failure ? 'failed' : 'passed',
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  modelGateway: 'https://ai.xapi.to/v1',
  model,
  sandboxHost,
  provider,
  maxHourlyUsd,
  finalOutput,
  sandbox: sandbox.evidence,
  ...(cleanupError ? { cleanupError } : {}),
  ...(failure
    ? { error: failure instanceof Error ? failure.message : String(failure) }
    : {}),
};

console.log(JSON.stringify(report, null, 2));

if (failure) {
  throw failure;
}
