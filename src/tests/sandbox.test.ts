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

  it('forwards cwd and explicit background execution', async () => {
    const execSpy = spyOn(sandboxClient, 'sandboxExec').mockResolvedValue({
      exitCode: 0,
      background: { sessionId: 'session-1', commandId: 'command-1' },
    });
    spies.push(execSpy);
    await sandboxExec(['box-1'], {
      command: 'python3 -m http.server 25319 --bind 0.0.0.0',
      cwd: '/workspace',
      background: 'true',
    });
    expect(execSpy).toHaveBeenCalledWith(
      expect.any(Object),
      'box-1',
      {
        command: 'python3 -m http.server 25319 --bind 0.0.0.0',
        timeoutSeconds: 60,
        cwd: '/workspace',
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
