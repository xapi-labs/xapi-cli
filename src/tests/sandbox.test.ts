import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpError } from '../client.ts';
import * as config from '../config.ts';
import * as format from '../format.ts';
import * as sandboxClient from '../sandbox-client.ts';
import {
  SANDBOX_HELP,
  requirementsFromFlags,
  sandboxAudit,
  sandboxCreate,
  sandboxExec,
  sandboxExtension,
  sandboxFile,
  sandboxHistory,
  sandboxOptions,
  sandboxResultExitCode,
  sandboxRun,
  sandboxSnapshot,
  sandboxState,
  sandboxTableRows,
  sandboxWait,
} from '../commands/sandbox.ts';

describe('sandbox commands', () => {
  let cfgSpy: ReturnType<typeof spyOn>;
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  const spies: Array<ReturnType<typeof spyOn>> = [];

  beforeEach(() => {
    cfgSpy = spyOn(config, 'getConfig').mockReturnValue({
      actionHost: 'action.xapi.to',
      sandboxHost: 'sandbox.test.xapi.to',
      apiKey: 'sk-test',
    });
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
  });

  afterEach(() => {
    cfgSpy.mockRestore();
    outputSpy.mockRestore();
    errSpy.mockRestore();
    while (spies.length) spies.pop()!.mockRestore();
  });

  it('streams binary downloads and removes partial files on interruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sandbox-download-'));
    const target = join(dir, 'binary');
    try {
      const bytes = Buffer.from([0, 255, 128, 10, 0, 240, 159, 152, 128]);
      const spy = spyOn(sandboxClient, 'sandboxFileDownload').mockResolvedValue(new ReadableStream({
        start(controller) { controller.enqueue(bytes.subarray(0, 5)); controller.enqueue(bytes.subarray(5)); controller.close(); },
      }));
      spies.push(spy);
      await sandboxFile(['download', 'box', '/tmp/binary'], { output: target });
      expect(await readFile(target)).toEqual(bytes);
      await expect(sandboxFile(['download', 'box', '/tmp/binary'], { output: target })).rejects.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      const partial = join(dir, 'partial');
      let reads = 0;
      spy.mockResolvedValue(new ReadableStream({ pull(controller) {
        if (reads++ === 0) controller.enqueue(bytes); else controller.error(new Error('network interrupted'));
      } }));
      await expect(sandboxFile(['download', 'box', '/tmp/binary'], { output: partial })).rejects.toThrow();
      await expect(readFile(partial)).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('snapshots once and preserves the operation without resuming or state polling', async () => {
    const action = spyOn(sandboxClient, 'sandboxStateAction').mockResolvedValue({ id: 'snap-op', status: 'SUCCEEDED' });
    const wait = spyOn(sandboxClient, 'sandboxWait').mockResolvedValue({} as any);
    spies.push(action, wait);
    await sandboxSnapshot(['box'], { 'idempotency-key': 'snap-key' });
    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(expect.any(Object), 'box', 'snapshot', { idempotencyKey: 'snap-key' });
    expect(wait).not.toHaveBeenCalled();
    expect(outputSpy).toHaveBeenCalledWith({ id: 'snap-op', status: 'SUCCEEDED', clientIdempotencyKey: 'snap-key' }, undefined);
  });

  it('keeps the snapshot recovery key after a lost response without replaying', async () => {
    const action = spyOn(sandboxClient, 'sandboxStateAction').mockRejectedValue(new Error('response lost'));
    spies.push(action);
    await expect(sandboxSnapshot(['box'], { 'idempotency-key': 'snap-key' })).rejects.toThrow('err called');
    expect(action).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('sandbox snapshot failed', expect.objectContaining({ instanceId: 'box', clientIdempotencyKey: 'snap-key', message: 'response lost' }));
  });

  it('advertises every adapter-backed provider in the top-level help', () => {
    for (const provider of [
      'daytona', 'cf-edge', 'e2b', 'runpod', 'runloop', 'modal',
      'vc-sandbox', 'fly', 'blaxel', 'cubesandbox',
    ]) {
      expect(SANDBOX_HELP).toContain(provider);
    }
  });

  it('maps resource and provider flags to safe client options and requirements', () => {
    expect(sandboxOptions({ provider: 'cf-edge' })).toEqual({
      sandboxHost: 'sandbox.test.xapi.to', apiKey: 'sk-test', provider: 'cf-edge',
    });
    expect(requirementsFromFlags({
      capabilities: 'exec, files', cpu: '2', memory: '4', 'gpu-count': '1', 'gpu-model': 'L4', regions: 'us,eu',
      'min-runtime': '24h',
    })).toEqual({
      capabilities: ['exec', 'files'],
      cpu: { min: 2 },
      memoryGiB: { min: 4 },
      gpu: { count: 1, model: 'L4' },
      regions: ['us', 'eu'],
      minContinuousRuntimeSeconds: 86400,
    });
    expect(requirementsFromFlags({
      requirements: '{"capabilities":["exec","files"],"cpu":{"min":4}}',
    }, ['exec'])).toEqual({ capabilities: ['exec', 'files'], cpu: { min: 4 } });
  });

  it('rejects a GPU model without a GPU count before quoting', () => {
    expect(() => requirementsFromFlags({ 'gpu-model': 'L4' })).toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('--gpu-model requires --gpu-count (or requirements.gpu.count)');
  });

  it('create enforces --max-hourly-usd through a quote instead of ignoring it', async () => {
    const quoteSpy = spyOn(sandboxClient, 'sandboxQuote').mockResolvedValue({ quoteId: 'quote-capped' });
    const createSpy = spyOn(sandboxClient, 'sandboxCreate').mockResolvedValue({
      id: 'box-capped', observedState: 'PROVISIONING',
    });
    spies.push(quoteSpy, createSpy);
    await sandboxCreate([], { 'max-hourly-usd': '0.10', capabilities: 'exec,files' });
    expect(quoteSpy).toHaveBeenCalledWith(expect.any(Object), {
      requirements: { capabilities: ['exec', 'files'] },
      maxEstimatedHourlyUsd: '0.10000000',
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ selection: { quoteId: 'quote-capped' } }),
    );
  });

  it('rejects a price ceiling that would be ignored by an exact offering selection', async () => {
    const createSpy = spyOn(sandboxClient, 'sandboxCreate').mockResolvedValue({
      id: 'must-not-create', observedState: 'PROVISIONING',
    });
    spies.push(createSpy);
    await expect(sandboxCreate([], {
      'offering-id': 'offering-1', 'max-hourly-usd': '0.10',
    })).rejects.toThrow('err called');
    expect(createSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('cannot be combined with --offering-id'));
  });

  it('returns recovery data when create succeeds but --wait fails', async () => {
    const createSpy = spyOn(sandboxClient, 'sandboxCreate').mockResolvedValue({
      id: 'box-recover', observedState: 'PROVISIONING',
    });
    const waitSpy = spyOn(sandboxClient, 'sandboxWait').mockRejectedValue(new Error('wait timed out'));
    const getSpy = spyOn(sandboxClient, 'sandboxGet').mockResolvedValue({
      id: 'box-recover', observedState: 'RUNNING',
    });
    spies.push(createSpy, waitSpy, getSpy);
    await expect(sandboxCreate([], {
      wait: 'true', 'idempotency-key': 'stable-create-key',
    })).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('sandbox create failed', expect.objectContaining({
      instanceId: 'box-recover',
      observedState: 'RUNNING',
      clientIdempotencyKey: 'stable-create-key',
      recovery: expect.objectContaining({
        inspect: 'xapi-to sandbox get box-recover',
        terminate: 'xapi-to sandbox terminate box-recover',
      }),
    }));
  });

  it('rejects unknown Sandbox flags before making a request', async () => {
    const quoteSpy = spyOn(sandboxClient, 'sandboxQuote').mockResolvedValue({ quoteId: 'must-not-quote' });
    spies.push(quoteSpy);
    await expect(sandboxCreate([], { 'max-hourly-usd-value': '0.10' })).rejects.toThrow('err called');
    expect(quoteSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('--max-hourly-usd-value'),
      expect.objectContaining({ hint: 'run xapi-to sandbox create --help' }),
    );
  });

  it('rejects ambiguous values for boolean safety flags', async () => {
    const createSpy = spyOn(sandboxClient, 'sandboxCreate').mockResolvedValue({
      id: 'must-not-create', observedState: 'PROVISIONING',
    });
    spies.push(createSpy);
    await expect(sandboxCreate([], { wait: 'maybe' })).rejects.toThrow('err called');
    expect(createSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('--wait must be a boolean flag or --wait=true|false');
  });

  it('does not force exec onto a managed RunPod GPU create', async () => {
    const quoteSpy = spyOn(sandboxClient, 'sandboxQuote').mockResolvedValue({ quoteId: 'quote-gpu' });
    const createSpy = spyOn(sandboxClient, 'sandboxCreate').mockResolvedValue({
      id: 'gpu-1', observedState: 'PROVISIONING',
    });
    spies.push(quoteSpy, createSpy);
    await sandboxCreate([], { provider: 'runpod', 'gpu-count': '1', 'max-hourly-usd': '1.00' });
    expect(quoteSpy).toHaveBeenCalledWith(expect.any(Object), {
      requirements: { gpu: { count: 1 } },
      maxEstimatedHourlyUsd: '1.00000000',
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.any(Object), expect.objectContaining({ selection: { quoteId: 'quote-gpu' } }),
    );
  });

  it('supports positional command shorthand for exec', async () => {
    const execSpy = spyOn(sandboxClient, 'sandboxExec').mockResolvedValue({ exitCode: 0, stdout: 'ok' });
    spies.push(execSpy);
    await sandboxExec(['box-1', 'npm', 'test'], {});
    expect(execSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxHost: 'sandbox.test.xapi.to' }),
      'box-1',
      { command: 'npm test', timeoutSeconds: 60 },
    );
  });

  it('forwards cwd, environment and explicit background execution', async () => {
    const execSpy = spyOn(sandboxClient, 'sandboxExec').mockResolvedValue({
      exitCode: 0,
      background: { sessionId: 'session-1', commandId: 'command-1' },
    });
    spies.push(execSpy);
    await sandboxExec(['box-1'], {
      command: 'python3 -m http.server 25319 --bind 0.0.0.0',
      cwd: '/workspace',
      env: '{"TASK_MODE":"demo","SPACE":"value with spaces"}',
      background: 'true',
    });
    expect(execSpy).toHaveBeenCalledWith(
      expect.any(Object),
      'box-1',
      {
        command: 'python3 -m http.server 25319 --bind 0.0.0.0',
        cwd: '/workspace',
        env: { TASK_MODE: 'demo', SPACE: 'value with spaces' },
        background: true,
      },
    );
  });

  it('invokes provider extensions with parsed JSON and an idempotency key', async () => {
    const extensionSpy = spyOn(sandboxClient, 'sandboxExtension').mockResolvedValue({
      result: { connectionReady: true },
    });
    spies.push(extensionSpy);
    await sandboxExtension(['box-1', 'runpod.connection_info'], {
      provider: 'runpod', input: '{"includePorts":true}', 'idempotency-key': 'extension-key-1',
    });
    expect(extensionSpy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'runpod' }),
      'box-1',
      'runpod.connection_info',
      { input: { includePorts: true }, idempotencyKey: 'extension-key-1' },
    );
  });

  it.each(['unconfirmed', 'confirmed FAILED'])('explains status-dependent extension recovery without retrying (%s)', async outcome => {
    const error = outcome === 'unconfirmed' ? new Error('response lost')
      : new HttpError(403, 'operation status FAILED: fix upstream permission');
    const extensionSpy = spyOn(sandboxClient, 'sandboxExtension').mockRejectedValue(error);
    spies.push(extensionSpy);
    await expect(sandboxExtension(['box-1', 'daytona.snapshot.delete'], {
      input: '{"name":"owned-snapshot"}', 'idempotency-key': 'original-extension-key',
    })).rejects.toThrow('err called');
    expect(extensionSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('sandbox extension failed', expect.objectContaining({
      message: error.message, clientIdempotencyKey: 'original-extension-key',
      retry: expect.stringContaining('xapi-to sandbox audit box-1 --kind operations'),
    }));
    const hint = (errSpy.mock.calls[0]![1] as any).retry as string;
    expect(hint).toContain('For an unconfirmed outcome, reconcile with --idempotency-key original-extension-key');
    expect(hint).toContain('For confirmed FAILED, fix the upstream reason, then deliberately use a NEW idempotency key');
    expect(hint).toContain('the original key returns the original failure');
  });

  it('preserves the existing streaming connection recovery hint and original key', async () => {
    const extensionSpy = spyOn(sandboxClient, 'sandboxExtension').mockResolvedValue({
      result: { url: 'https://unused.example.invalid/connection', protocol: 'unsupported' },
    });
    spies.push(extensionSpy);
    await expect(sandboxExtension(['box-1', 'cloudflare.terminal.open'], {
      stream: 'true', 'idempotency-key': 'connection-key',
    })).rejects.toThrow('err called');
    expect(extensionSpy).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('sandbox extension failed', expect.objectContaining({
      clientIdempotencyKey: 'connection-key',
      retry: 'Open a new connection grant with a new idempotency key; reuse sessionId or log byte offsets. This does not replay the business command.',
    }));
  });

  it('downloads binary files using base64 without UTF-8 corruption', async () => {
    const readSpy = spyOn(sandboxClient, 'sandboxFileRead').mockResolvedValue({
      path: 'artifact.bin', content: 'AP+A', encoding: 'base64',
    });
    spies.push(readSpy);
    const directory = await mkdtemp(join(tmpdir(), 'xapi-cli-file-'));
    const target = join(directory, 'artifact.bin');
    try {
      await sandboxFile(['read', 'box-1', 'artifact.bin'], { output: target });
      expect(readSpy).toHaveBeenCalledWith(expect.any(Object), 'box-1', 'artifact.bin', 'base64');
      expect([...await readFile(target)]).toEqual([0, 255, 128]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('queries the dedicated history endpoint with normalized filters', async () => {
    const historySpy = spyOn(sandboxClient, 'sandboxHistory').mockResolvedValue({ items: [] });
    spies.push(historySpy);
    await sandboxHistory([], { state: 'history', search: 'agent run', page: '2', 'page-size': '25' });
    expect(historySpy).toHaveBeenCalledWith(expect.any(Object), {
      state: 'HISTORY', search: 'agent run', page: 2, pageSize: 25,
    });
  });

  it('normalizes and validates wait states before polling', async () => {
    const waitSpy = spyOn(sandboxClient, 'sandboxWait').mockResolvedValue({
      id: 'box-1', observedState: 'RUNNING',
    });
    spies.push(waitSpy);
    await sandboxWait(['box-1'], { state: 'running,failed' });
    expect(waitSpy).toHaveBeenCalledWith(
      expect.any(Object), 'box-1', ['RUNNING', 'FAILED'], 300_000, 2_000,
    );
  });

  it('enforces the audit page-size contract', async () => {
    const auditSpy = spyOn(sandboxClient, 'sandboxAudit').mockResolvedValue({ items: [] });
    spies.push(auditSpy);
    await expect(sandboxAudit(['box-1'], { 'page-size': '101' })).rejects.toThrow('err called');
    expect(auditSpy).not.toHaveBeenCalled();
  });

  it('lets a consumer query pending holds without changing default settled audit',async()=>{
    const auditSpy=spyOn(sandboxClient,'sandboxAudit').mockResolvedValue({items:[]});spies.push(auditSpy);
    await sandboxAudit(['box-1'],{kind:'billingPeriods','billing-status':'pending'});
    expect(auditSpy).toHaveBeenCalledWith(expect.any(Object),'box-1','billingPeriods',1,100,'pending');
  });

  it('projects offerings into a concise Sandbox-specific table', () => {
    expect(sandboxTableRows('offerings', [{
      id: 'offering-1',
      name: 'Daytona Small',
      resources: { cpu: 1, memoryGiB: 1, volumeGiB: 3 },
      capabilities: {
        exec: true, backgroundExec: true, files: true, ports: true,
        extensionIds: ['daytona.configure_idle'],
      },
      lifecycle: { suspension: { supported: true } },
      billing: { estimatedHourlyUsdByState: { RUNNING: '0.07693488' } },
    }])).toEqual([{
      id: 'offering-1',
      name: 'Daytona Small',
      cpu: 1,
      memoryGiB: 1,
      volumeGiB: 3,
      gpu: '',
      exec: 'yes',
      background: 'yes',
      files: 'yes',
      ports: 'yes',
      suspend: 'yes',
      hourlyUsd: '0.07693488',
      extensions: 'daytona.configure_idle',
    }]);
  });

  function mockSuccessfulRun() {
    const quoteSpy = spyOn(sandboxClient, 'sandboxQuote').mockResolvedValue({
      quoteId: 'quote-1', offering: { name: 'Cloudflare Sandbox' },
    });
    const createSpy = spyOn(sandboxClient, 'sandboxCreate').mockResolvedValue({
      id: 'box-1', observedState: 'PROVISIONING',
    });
    const waitSpy = spyOn(sandboxClient, 'sandboxWait')
      .mockResolvedValueOnce({ id: 'box-1', observedState: 'RUNNING' })
      .mockResolvedValueOnce({ id: 'box-1', observedState: 'TERMINATED', totalCost: '0.001' });
    const execSpy = spyOn(sandboxClient, 'sandboxExec').mockResolvedValue({ exitCode: 0, stdout: '42\n' });
    const getSpy = spyOn(sandboxClient, 'sandboxGet')
      .mockResolvedValueOnce({ id: 'box-1', observedState: 'RUNNING' })
      .mockResolvedValueOnce({ id: 'box-1', observedState: 'TERMINATED', totalCost: '0.001' });
    const stateSpy = spyOn(sandboxClient, 'sandboxStateAction').mockResolvedValue({ status: 'RUNNING' });
    spies.push(quoteSpy, createSpy, waitSpy, execSpy, getSpy, stateSpy);
    return { quoteSpy, createSpy, waitSpy, execSpy, getSpy, stateSpy };
  }

  it('returns the confirmed matching terminate operation instead of the launch snapshot', async () => {
    const get = spyOn(sandboxClient, 'sandboxGet').mockResolvedValue({ id: 'box', observedState: 'RUNNING' });
    const state = spyOn(sandboxClient, 'sandboxStateAction').mockResolvedValue({ id: 'terminate-op', status: 'RUNNING', completedAt: null });
    const confirmed = { id: 'terminate-op', status: 'SUCCEEDED', completedAt: '2026-10-09T06:14:00Z' };
    const wait = spyOn(sandboxClient, 'sandboxWait').mockResolvedValue({ id: 'box', observedState: 'TERMINATED', operations: [confirmed] });
    spies.push(get, state, wait);
    await sandboxState('terminate', ['box'], {});
    expect((outputSpy.mock.calls.at(-1)?.[0] as any).operation).toEqual(confirmed);
    expect(state).toHaveBeenCalledTimes(1);
  });

  it('does not invent an operation result from a different operation or just a terminal state', async () => {
    const get = spyOn(sandboxClient, 'sandboxGet').mockResolvedValue({ id: 'box', observedState: 'RUNNING' });
    const acknowledgement = { id: 'current-op', status: 'RUNNING' };
    const state = spyOn(sandboxClient, 'sandboxStateAction').mockResolvedValue(acknowledgement);
    const wait = spyOn(sandboxClient, 'sandboxWait').mockResolvedValue({ id: 'box', observedState: 'TERMINATED', operations: [{ id: 'other-op', status: 'SUCCEEDED' }] });
    spies.push(get, state, wait);
    await sandboxState('terminate', ['box'], {});
    expect((outputSpy.mock.calls.at(-1)?.[0] as any).operation).toEqual(acknowledgement);
    expect(state).toHaveBeenCalledTimes(1);
  });

  for (const action of ['suspend', 'resume'] as const) {
    it(`returns the confirmed matching ${action} receipt without another mutation`, async () => {
      const state = spyOn(sandboxClient, 'sandboxStateAction').mockResolvedValue({ id: 'current-op', status: 'RUNNING' });
      const confirmed = { id: 'current-op', status: 'SUCCEEDED', completedAt: '2026-10-09T08:45:00Z' };
      const wait = spyOn(sandboxClient, 'sandboxWait').mockResolvedValue({ id: 'box', observedState: action === 'suspend' ? 'SUSPENDED' : 'RUNNING', operations: [confirmed] });
      spies.push(state, wait);
      await sandboxState(action, ['box'], {});
      expect((outputSpy.mock.calls.at(-1)?.[0] as any).operation).toEqual(confirmed);
      expect(state).toHaveBeenCalledTimes(1);
      expect(wait).toHaveBeenCalledTimes(1);
    });
    it(`keeps the original ${action} receipt if only another operation is available`, async () => {
      const acknowledgement = { id: 'current-op', status: 'RUNNING' };
      const state = spyOn(sandboxClient, 'sandboxStateAction').mockResolvedValue(acknowledgement);
      const wait = spyOn(sandboxClient, 'sandboxWait').mockResolvedValue({ id: 'box', observedState: action === 'suspend' ? 'SUSPENDED' : 'RUNNING', operations: [{ id: 'other-op', status: 'SUCCEEDED' }] });
      spies.push(state, wait);
      await sandboxState(action, ['box'], {});
      expect((outputSpy.mock.calls.at(-1)?.[0] as any).operation).toEqual(acknowledgement);
      expect(state).toHaveBeenCalledTimes(1);
    });
  }

  it('run quotes, creates, waits, executes, and always terminates', async () => {
    const mocked = mockSuccessfulRun();
    await sandboxRun([], {
      command: 'python3 -c "print(42)"', provider: 'cf-edge',
      metadata: '{"e2eRun":"run-42","client":"must-not-override"}',
    });
    expect(mocked.quoteSpy).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'cf-edge' }),
      expect.objectContaining({
        requirements: { capabilities: ['exec'] },
        maxEstimatedHourlyUsd: '0.20000000',
      }),
      expect.any(Object),
    );
    expect(mocked.execSpy).toHaveBeenCalledWith(
      expect.any(Object),
      'box-1',
      expect.objectContaining({ command: 'python3 -c "print(42)"' }),
      expect.any(Object),
    );
    expect(mocked.stateSpy).toHaveBeenCalledWith(
      expect.any(Object), 'box-1', 'terminate', expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(mocked.createSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        metadata: { e2eRun: 'run-42', client: 'xapi-cli', command: 'sandbox run' },
      }),
    );
    expect(outputSpy).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'box-1', finalState: 'TERMINATED', totalCost: '0.001',
      result: { exitCode: 0, stdout: '42\n' },
    }), undefined);
  });

  it('run cleans up when command execution fails', async () => {
    const mocked = mockSuccessfulRun();
    mocked.execSpy.mockRejectedValue(new Error('command exploded'));
    await expect(sandboxRun([], { command: 'false' })).rejects.toThrow('err called');
    expect(mocked.stateSpy).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('sandbox run failed', expect.objectContaining({
      message: 'command exploded',
      instanceId: 'box-1',
      cleanup: expect.objectContaining({ state: 'TERMINATED' }),
    }));
  });

  it('reconciles cleanup through the aggregate route after a provider read 404', async () => {
    const mocked = mockSuccessfulRun();
    mocked.waitSpy.mockReset();
    mocked.waitSpy
      .mockResolvedValueOnce({ id: 'box-1', observedState: 'RUNNING' })
      .mockRejectedValueOnce(new HttpError(404, 'not found'))
      .mockResolvedValueOnce({ id: 'box-1', observedState: 'TERMINATED', totalCost: '0.001' });

    await sandboxRun([], { command: 'echo ok', provider: 'daytona' });

    expect(mocked.waitSpy).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ provider: undefined }),
      'box-1',
      ['TERMINATED', 'FAILED'],
      expect.any(Number),
      expect.any(Number),
    );
    expect(outputSpy).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'box-1', finalState: 'TERMINATED', totalCost: '0.001',
    }), undefined);
  });

  it('run keeps an instance only with explicit --keep', async () => {
    const quoteSpy = spyOn(sandboxClient, 'sandboxQuote').mockResolvedValue({ quoteId: 'quote-1' });
    const createSpy = spyOn(sandboxClient, 'sandboxCreate').mockResolvedValue({ id: 'box-1', observedState: 'PROVISIONING' });
    const waitSpy = spyOn(sandboxClient, 'sandboxWait').mockResolvedValue({ id: 'box-1', observedState: 'RUNNING' });
    const execSpy = spyOn(sandboxClient, 'sandboxExec').mockResolvedValue({ exitCode: 0 });
    const getSpy = spyOn(sandboxClient, 'sandboxGet').mockResolvedValue({ id: 'box-1', observedState: 'RUNNING', totalCost: '0.0001' });
    const stateSpy = spyOn(sandboxClient, 'sandboxStateAction').mockResolvedValue({});
    spies.push(quoteSpy, createSpy, waitSpy, execSpy, getSpy, stateSpy);
    await sandboxRun([], { command: 'echo ok', keep: 'true' });
    expect(stateSpy).not.toHaveBeenCalled();
    expect(outputSpy).toHaveBeenCalledWith(expect.objectContaining({
      finalState: 'RUNNING',
      cleanup: expect.objectContaining({ kept: true }),
    }), undefined);
  });

  it('normalizes remote non-zero exit codes for the local process', () => {
    expect(sandboxResultExitCode({ exitCode: 0 })).toBeUndefined();
    expect(sandboxResultExitCode({ exitCode: 7 })).toBe(7);
    expect(sandboxResultExitCode({ exitCode: 999 })).toBe(255);
  });
});


describe('Sandbox native capacity flags',()=>{
  it('ceil-divides large millisecond values exactly before checking seconds representability',()=>{
    expect(requirementsFromFlags({'min-runtime':'9007199254740989001ms'}).minContinuousRuntimeSeconds).toBe(9007199254740990);
    expect(requirementsFromFlags({'min-runtime':'1ms'}).minContinuousRuntimeSeconds).toBe(1);
  });

  it('passes capacity and lifetime beyond the old product ceilings unchanged',()=>{
    const requirements=requirementsFromFlags({'gpu-count':'2048','gpu-model':'native-'+ 'x'.repeat(130),'min-runtime':'366d','cpu':'0.0000001'});
    expect(requirements.gpu?.count).toBe(2048);
    expect(requirements.gpu?.model?.length).toBeGreaterThan(120);
    expect(requirements.minContinuousRuntimeSeconds).toBe(31622400);
    expect(requirements.cpu?.min).toBe(0.0000001);
  });
});
