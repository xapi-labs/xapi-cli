#!/usr/bin/env node

/**
 * Real Sandbox Playground suite, executed exclusively through the built xAPI CLI.
 *
 * The suite covers the same nine user journeys as the web Playground and pins
 * workloads across all seven configured test providers. Every created instance
 * is tracked and terminated in finally; the final gate requires ACTIVE history
 * to be empty. The API key is read by the CLI from its normal config/env and is
 * never passed on argv or written to the report.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const cliEntry = resolve(root, 'dist/index.js');
const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  process.stdout.write(`Usage: node scripts/sandbox-playground-e2e.mjs [options]\n\n` +
    `  --host HOST       Sandbox Gateway (default: sandbox.test.xapi.to)\n` +
    `  --report FILE     Redacted JSON report path\n` +
    `  --only 1,8,9      Run selected scenario numbers\n` +
    `  --skip-gpu        Skip the billable RunPod GPU scenario\n`);
  process.exit(0);
}
const valueFlags = new Set(['--host', '--report', '--only']);
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--skip-gpu') continue;
  if (!valueFlags.has(arg)) throw new Error(`unknown argument: ${arg}; use --help`);
  if (!argv[index + 1] || argv[index + 1].startsWith('--')) {
    throw new Error(`${arg} requires a value`);
  }
  index += 1;
}
const valueAfter = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const host = valueAfter('--host', process.env.XAPI_SANDBOX_HOST || 'sandbox.test.xapi.to');
const reportPath = resolve(valueAfter(
  '--report',
  `/tmp/xapi-sandbox-cli-e2e-${new Date().toISOString().replaceAll(':', '-')}.json`,
));
const skipGpu = argv.includes('--skip-gpu');
const only = valueAfter('--only', '')
  .split(',').map((value) => value.trim()).filter(Boolean);
const startedAt = new Date();
const runTag = `sandbox-playground-e2e:${startedAt.toISOString()}:${randomUUID()}`;
const tracked = new Map();
const report = { startedAt: startedAt.toISOString(), host, runTag, scenarios: [], cleanup: [], finalGate: null };
let baselineActiveIds = new Set();

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const json = (value) => JSON.stringify(value);
const markerIn = (value, marker) => json(value).includes(marker);

function signalProcessTree(child, signal) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    try { child.kill(signal); } catch { /* The process may have exited between checks. */ }
  }
}

function runProcess(args, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forceKill;
    const timeout = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGTERM');
      forceKill = setTimeout(() => signalProcessTree(child, 'SIGKILL'), 30_000);
      forceKill.unref?.();
    }, timeoutMs);
    timeout.unref?.();
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (timedOut) {
        reject(new Error(
          `CLI command timed out after ${timeoutMs}ms and was terminated` +
          (result.stderr ? `: ${result.stderr.slice(0, 500)}` : ''),
        ));
        return;
      }
      resolvePromise(result);
    });
  });
}

function runBinary(binary, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

async function cli(command, { provider, timeoutMs = 420_000 } = {}) {
  const args = ['sandbox', ...command];
  if (provider) args.push('--provider', provider);
  args.push('--host', host, '--format', 'json');
  process.stdout.write(`  $ xapi ${args.slice(0, -2).join(' ')}\n`);
  const result = await runProcess(args, timeoutMs);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `CLI exited ${result.code}`);
  }
  try { return result.stdout ? JSON.parse(result.stdout) : null; }
  catch { throw new Error(`CLI returned non-JSON output: ${result.stdout.slice(0, 500)}`); }
}

async function scenario(name, providers, task) {
  const scenarioNumber = name.match(/^\d+/)?.[0];
  if (only.length && !only.includes(scenarioNumber)) {
    report.scenarios.push({ name, providers, status: 'skipped', reason: '--only filter' });
    return;
  }
  const begin = Date.now();
  process.stdout.write(`\n[scenario] ${name}\n`);
  const item = { name, providers, status: 'running', startedAt: new Date().toISOString() };
  report.scenarios.push(item);
  try {
    item.evidence = await task();
    item.status = 'passed';
  } catch (error) {
    item.status = 'failed';
    item.error = error.message;
    throw error;
  } finally {
    item.durationMs = Date.now() - begin;
    process.stdout.write(`[${item.status}] ${name} (${item.durationMs}ms)\n`);
  }
}

async function create(provider, capabilities, maxHourlyUsd, extra = []) {
  const command = ['create'];
  if (capabilities) command.push('--capabilities', capabilities);
  command.push(
    '--max-hourly-usd', String(maxHourlyUsd),
    '--metadata', JSON.stringify({ e2eRun: runTag, scenarioProvider: provider }),
    '--wait', '--wait-timeout', '6m', ...extra,
  );
  const detail = await cli(command, { provider });
  assert(detail?.id, `${provider} create did not return id`);
  assert(detail.observedState === 'RUNNING', `${provider} did not reach RUNNING`);
  tracked.set(detail.id, provider);
  return detail;
}

async function terminate(id, provider) {
  const result = await cli(['terminate', id, '--wait-timeout', '6m'], { provider });
  const state = result?.sandbox?.observedState || result?.observedState;
  assert(['TERMINATED', 'FAILED'].includes(state), `${id} cleanup ended in ${state || 'unknown state'}`);
  tracked.delete(id);
  return result?.sandbox || result;
}

async function audits(id, provider) {
  const values = (value) => Array.isArray(value) ? value : value?.items ?? value?.data ?? [];
  const deadline = Date.now() + 60_000;
  let lastError = 'audit has not settled';
  while (Date.now() < deadline) {
    const audit = {};
    for (const kind of ['operations', 'events', 'usageSegments', 'billingPeriods']) {
      audit[kind] = await cli(['audit', id, '--kind', kind]);
    }
    const detail = await cli(['get', id]);
    const operations = values(audit.operations);
    const events = values(audit.events);
    const usageSegments = values(audit.usageSegments);
    const billingPeriods = values(audit.billingPeriods);
    const operationsValid = operations.length > 0
      && operations.every((item) => item.status === 'SUCCEEDED');
    const terminalEvent = events.some((item) => ['TERMINATED', 'FAILED'].includes(item.currentState));
    const usageSettled = usageSegments.length > 0
      && usageSegments.every((item) => item.status === 'SETTLED' && item.endsAt);
    const billingSettled = billingPeriods.length > 0
      && billingPeriods.every((item) => item.status === 'SETTLED' && item.endedAt);
    const billingTotal = billingPeriods.reduce((sum, item) => sum + Number(item.amount || 0), 0);
    const totalCost = Number(detail?.totalCost);
    const costMatches = Number.isFinite(totalCost) && Number.isFinite(billingTotal)
      && Math.abs(totalCost - billingTotal) <= 1e-9;
    if (operationsValid && terminalEvent && usageSettled && billingSettled && costMatches) {
      return {
        counts: Object.fromEntries(Object.entries(audit).map(([kind, value]) => [kind, values(value).length])),
        statuses: Object.fromEntries(Object.entries(audit).map(([kind, value]) => [
          kind, values(value).map((item) => item.status || item.currentState || 'UNKNOWN'),
        ])),
        state: detail.observedState,
        totalCost: detail.totalCost,
        billingTotal,
        verified: true,
      };
    }
    lastError = [
      !operationsValid && 'operation status',
      !terminalEvent && 'terminal event',
      !usageSettled && 'usage settlement',
      !billingSettled && 'billing settlement',
      !costMatches && `cost mismatch ${billingTotal} != ${detail?.totalCost}`,
    ].filter(Boolean).join(', ');
    await sleep(1_000);
  }
  throw new Error(`${provider} sandbox ${id} audit verification timed out: ${lastError}`);
}

async function oneShot(provider, command, marker, maxHourlyUsd) {
  const value = await cli([
    'run', '--command', command, '--capabilities', 'exec',
    '--metadata', JSON.stringify({ e2eRun: runTag, scenarioProvider: provider }),
    '--max-hourly-usd', String(maxHourlyUsd), '--wait-timeout', '6m',
  ], { provider });
  assert(value?.finalState === 'TERMINATED', `${provider} one-shot left ${value?.finalState}`);
  assert(markerIn(value?.result, marker), `${provider} output missed ${marker}`);
  return {
    instanceId: value.instanceId,
    finalState: value.finalState,
    totalCost: value.totalCost,
    marker,
    audit: await audits(value.instanceId, provider),
  };
}

async function run() {
  const baseline = await cli(['history', '--state', 'ACTIVE', '--page-size', '100']);
  baselineActiveIds = new Set((baseline?.items || []).map((item) => item.id).filter(Boolean));
  report.baseline = { activeInstances: baselineActiveIds.size };
  await scenario('1. 跨服务商目录与报价', ['auto'], async () => {
    const offerings = await cli(['offerings']);
    const quote = await cli(['quote', '--capabilities', 'exec,files', '--max-hourly-usd', '0.60']);
    assert(Array.isArray(offerings) && offerings.length >= 7, `expected >=7 offerings, got ${offerings?.length}`);
    assert(quote?.quoteId && quote?.offering?.id, 'quote is incomplete');
    return { offeringCount: offerings.length, selected: quote.offering.name, quoteId: quote.quoteId };
  });

  await scenario('2. AI 编码 Agent', ['daytona'], async () => {
    const box = await create('daytona', 'exec,files', 0.20);
    try {
      await cli(['file', 'write', box.id, 'agent-task.txt', '--content', 'implement multiply and run tests'], { provider: 'daytona' });
      const execution = await cli(['exec', box.id, '--command', "mkdir -p agent-demo; printf 'export const multiply = (a,b) => a*b;\\n' > agent-demo/math.js; node -e \"import('./agent-demo/math.js').then(m=>{if(m.multiply(6,7)!==42)process.exit(1);console.log('AI_AGENT_OK=42')})\""], { provider: 'daytona' });
      assert(execution?.exitCode === 0 && markerIn(execution, 'AI_AGENT_OK=42'), 'AI coding test failed');
      const artifact = await cli(['file', 'read', box.id, 'agent-demo/math.js'], { provider: 'daytona' });
      assert(markerIn(artifact, 'multiply'), 'AI artifact was not readable');
      const final = await terminate(box.id, 'daytona');
      return { instanceId: box.id, artifactBytes: String(artifact?.content || '').length, audit: await audits(box.id, 'daytona'), finalState: final.observedState };
    } finally {
      if (tracked.has(box.id)) await terminate(box.id, 'daytona');
    }
  });

  await scenario('3. CI 复现与自动修复', ['runloop'], async () => oneShot(
    'runloop',
    "mkdir -p ci-demo; printf 'broken\\n' > ci-demo/status; sed -i.bak 's/broken/fixed/' ci-demo/status 2>/dev/null || sed -i 's/broken/fixed/' ci-demo/status; grep -q fixed ci-demo/status && echo CI_REPAIR_OK",
    'CI_REPAIR_OK', 0.30,
  ));

  await scenario('4. 数据分析与报告', ['modal'], async () => {
    const box = await create('modal', 'exec,files', 0.60);
    try {
      await cli(['file', 'write', box.id, '/tmp/metrics.csv', '--content', 'day,value\nmon,12\ntue,18\nwed,24\n'], { provider: 'modal' });
      const execution = await cli(['exec', box.id, '--command', "awk -F, 'NR>1{s+=$2;n++}END{printf \"DATA_REPORT_OK average=%.2f\\n\",s/n}' /tmp/metrics.csv | tee /tmp/report.txt"], { provider: 'modal' });
      assert(execution?.exitCode === 0 && markerIn(execution, 'DATA_REPORT_OK average=18.00'), 'data result mismatch');
      const reportFile = await cli(['file', 'read', box.id, '/tmp/report.txt'], { provider: 'modal' });
      assert(markerIn(reportFile, 'average=18.00'), 'report file was not persisted');
      const final = await terminate(box.id, 'modal');
      return { instanceId: box.id, result: 'average=18.00', audit: await audits(box.id, 'modal'), finalState: final.observedState };
    } finally {
      if (tracked.has(box.id)) await terminate(box.id, 'modal');
    }
  });

  await scenario('5. 多 Agent 并行隔离', ['e2b', 'vc-sandbox'], async () => {
    const [implementer, reviewer] = await Promise.all([
      oneShot('e2b', "sleep 2; echo IMPLEMENT_AGENT_OK", 'IMPLEMENT_AGENT_OK', 0.30),
      oneShot('vc-sandbox', "sleep 2; echo REVIEW_AGENT_OK", 'REVIEW_AGENT_OK', 0.50),
    ]);
    assert(implementer.instanceId !== reviewer.instanceId, 'agents unexpectedly shared one instance');
    return {
      isolatedInstanceIds: [implementer.instanceId, reviewer.instanceId],
      finalStates: [implementer.finalState, reviewer.finalState],
      audits: [implementer.audit, reviewer.audit],
    };
  });

  if (!skipGpu) {
    await scenario('6. GPU 实例与连接信息', ['runpod'], async () => {
      const box = await create('runpod', null, 1.00, ['--gpu-count', '1']);
      try {
        let connection = null;
        for (let attempt = 1; attempt <= 30; attempt += 1) {
          connection = await cli(['extension', box.id, 'runpod.connection_info', '--input', '{}'], { provider: 'runpod' });
          if (connection?.result?.result?.connectionReady) break;
          await sleep(10_000);
        }
        const info = connection?.result?.result;
        assert(info?.connectionReady === true, 'RunPod connection info did not become ready');
        assert(info?.publicIp && Object.keys(info?.portMappings || {}).length > 0, 'RunPod connection details are incomplete');
        const final = await terminate(box.id, 'runpod');
        return { instanceId: box.id, connectionReady: true, publicIpPresent: true, portMappingCount: Object.keys(info.portMappings).length, audit: await audits(box.id, 'runpod'), finalState: final.observedState };
      } finally {
        if (tracked.has(box.id)) await terminate(box.id, 'runpod');
      }
    });
  } else {
    report.scenarios.push({ name: '6. GPU 实例与连接信息', providers: ['runpod'], status: 'skipped' });
  }

  await scenario('7. 单次代码执行', ['auto'], async () => oneShot(
    'auto',
    "python3 -c \"print('RUN_CODE_OK=' + str(sum(i*i for i in range(10))))\"",
    'RUN_CODE_OK=285', 0.20,
  ));

  await scenario('8. Cloudflare Web 预览与临时 API', ['cf-edge'], async () => {
    const allocations = [];
    // Quick Tunnels are explicitly a best-effort debugging surface. A small
    // fraction of allocations complete the control-plane handshake but never
    // serve TLS. Retry with a fresh sandbox (and therefore a fresh tunnel
    // process) while the provider-side adapter rollout gains its own probe.
    for (let allocation = 1; allocation <= 4; allocation += 1) {
      const box = await create('cf-edge', 'exec,files,ports', 0.20);
      let tunnelHost = '';
      try {
        await cli(['file', 'write', box.id, 'index.html', '--content', '<!doctype html><h1>CF_PLAYGROUND_OK</h1>'], { provider: 'cf-edge' });
        const server = await cli([
          'exec', box.id, '--command',
          'nohup python3 -m http.server 8080 >/tmp/serve.log 2>&1 & i=0; until curl -sf http://127.0.0.1:8080/; do i=$((i+1)); [ "$i" -ge 20 ] && exit 7; sleep 1; done',
        ], { provider: 'cf-edge' });
        assert(server?.exitCode === 0 && markerIn(server, 'CF_PLAYGROUND_OK'), 'Cloudflare local preview failed');
        const port = await cli(['port', box.id, '8080'], { provider: 'cf-edge' });
        assert(port?.url, 'Cloudflare port did not return a public URL');
        tunnelHost = new URL(port.url).hostname;
        process.stdout.write(`  Cloudflare tunnel allocation ${allocation}/4: ${tunnelHost}\n`);
        let publicBody = '';
        let lastPublicError = '';
        for (let attempt = 1; attempt <= 4; attempt += 1) {
          const probe = await runBinary('curl', [
            '--silent', '--show-error', '--fail', '--max-time', '8', port.url,
          ]);
          publicBody = probe.stdout;
          if (probe.code === 0 && publicBody.includes('CF_PLAYGROUND_OK')) break;
          lastPublicError = probe.stderr || `curl exit ${probe.code}`;
          process.stdout.write(`  Cloudflare public probe ${attempt}/4: ${lastPublicError}\n`);
          await sleep(2_000);
        }
        if (publicBody.includes('CF_PLAYGROUND_OK')) {
          const final = await terminate(box.id, 'cf-edge');
          allocations.push({ instanceId: box.id, tunnelHost, reachable: true });
          return {
            instanceId: box.id,
            publicUrlVerified: true,
            publicStatus: 200,
            tunnelAllocations: allocations,
            audit: await audits(box.id, 'cf-edge'),
            finalState: final.observedState,
          };
        }
        allocations.push({ instanceId: box.id, tunnelHost, reachable: false, error: lastPublicError });
      } finally {
        if (tracked.has(box.id)) await terminate(box.id, 'cf-edge');
      }
    }
    throw new Error(`Cloudflare public URL stayed unreachable across ${allocations.length} fresh allocations`);
  });

  await scenario('9. 挂起、恢复与文件持久性', ['e2b'], async () => {
    const box = await create('e2b', 'exec,files', 0.30);
    try {
      await cli(['file', 'write', box.id, 'lifecycle-marker.txt', '--content', 'XAPI_LIFECYCLE_OK=42'], { provider: 'e2b' });
      const suspended = await cli(['suspend', box.id, '--wait-timeout', '6m'], { provider: 'e2b' });
      assert(suspended?.sandbox?.observedState === 'SUSPENDED', 'E2B did not suspend');
      const resumed = await cli(['resume', box.id, '--wait-timeout', '6m'], { provider: 'e2b' });
      assert(resumed?.sandbox?.observedState === 'RUNNING', 'E2B did not resume');
      const marker = await cli(['file', 'read', box.id, 'lifecycle-marker.txt'], { provider: 'e2b' });
      assert(markerIn(marker, 'XAPI_LIFECYCLE_OK=42'), 'file did not survive suspend/resume');
      const final = await terminate(box.id, 'e2b');
      return { instanceId: box.id, markerPreserved: true, audit: await audits(box.id, 'e2b'), finalState: final.observedState };
    } finally {
      if (tracked.has(box.id)) await terminate(box.id, 'e2b');
    }
  });
}

let failure = null;
try {
  await run();
} catch (error) {
  failure = error;
} finally {
  for (const [id, provider] of [...tracked.entries()]) {
    try {
      const detail = await terminate(id, provider);
      report.cleanup.push({ id, provider, status: detail.observedState });
    } catch (error) {
      report.cleanup.push({ id, provider, status: 'failed', error: error.message });
      failure ||= error;
    }
  }
  try {
    const active = await cli(['history', '--state', 'ACTIVE', '--page-size', '100']);
    const activeItems = active?.items || [];
    const newActive = activeItems.filter((item) => item.id && !baselineActiveIds.has(item.id));
    report.finalGate = {
      accountActiveInstances: active?.total ?? activeItems.length,
      baselineActiveInstances: baselineActiveIds.size,
      testCreatedActiveInstances: newActive.map((item) => item.id),
      stateCounts: active?.stateCounts,
    };
    if (newActive.length !== 0) {
      failure ||= new Error(`zero-residual gate failed: ${newActive.length} test-created instances remain`);
    }
  } catch (error) {
    report.finalGate = { error: error.message };
    failure ||= error;
  }
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - startedAt.getTime();
  report.status = failure ? 'failed' : 'passed';
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`\nReport: ${reportPath}\nStatus: ${report.status}\n`);
}

if (failure) {
  process.stderr.write(`${failure.stack || failure.message}\n`);
  process.exitCode = 1;
}
