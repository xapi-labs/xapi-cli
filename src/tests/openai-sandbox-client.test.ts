import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Manifest } from '@openai/agents/sandbox';
import * as sandbox from '../sandbox-client.ts';
import { XapiAgentsSandboxClient } from '../openai-sandbox-client.ts';

describe('OpenAI Agents Sandbox client', () => {
  const spies: Array<ReturnType<typeof spyOn>> = [];

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  function mockCreate(workspaceCommand: string[] = []) {
    const quote = spyOn(sandbox, 'sandboxQuote').mockResolvedValue({ quoteId: 'quote-1' });
    const create = spyOn(sandbox, 'sandboxCreate').mockResolvedValue({
      id: 'box-1', observedState: 'PROVISIONING',
    });
    const wait = spyOn(sandbox, 'sandboxWait').mockResolvedValue({
      id: 'box-1', observedState: 'RUNNING',
    });
    const exec = spyOn(sandbox, 'sandboxExec').mockImplementation((async (
      _opts: unknown, _id: string, body: { command: string },
    ) => {
      workspaceCommand.push(body.command);
      return { exitCode: 0, stdout: '', stderr: '' };
    }) as any);
    spies.push(quote, create, wait, exec);
    return { quote, create };
  }

  it('validates price ceilings and shell-quotes the workspace path', async () => {
    expect(() => new XapiAgentsSandboxClient({
      apiKey: 'sk-test', maxHourlyUsd: Number.NaN,
    })).toThrow(/positive finite number/);

    const commands: string[] = [];
    const mocked = mockCreate(commands);
    const client = new XapiAgentsSandboxClient({
      apiKey: 'sk-test',
      sandboxHost: 'sandbox.test.xapi.to',
      workspaceRoot: "/tmp/xapi agent's",
      maxHourlyUsd: 0.15,
    });
    await client.create(new Manifest({ root: client.workspaceRoot }));

    expect(mocked.quote).toHaveBeenCalledWith(expect.any(Object), {
      requirements: { capabilities: ['exec', 'files'] },
      maxEstimatedHourlyUsd: '0.15000000',
    });
    expect(commands).toEqual(["mkdir -p -- '/tmp/xapi agent'\\''s'"]);
    await expect(client.create({ options: { maxHourlyUsd: Infinity } })).rejects.toThrow(/positive finite number/);
    expect(mocked.create).toHaveBeenCalledTimes(1);
  });

  it('retries close after cleanup failure and verifies settled audit evidence', async () => {
    mockCreate();
    const get = spyOn(sandbox, 'sandboxGet')
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValue({ id: 'box-1', observedState: 'TERMINATED', totalCost: '0.001' });
    const audit = spyOn(sandbox, 'sandboxAudit').mockImplementation((async (
      _opts: unknown, _id: string, kind: string,
    ) => ({
      items: kind === 'operations'
        ? [{ status: 'SUCCEEDED' }]
        : kind === 'events'
          ? [{ status: 'ACCEPTED', currentState: 'TERMINATED' }]
          : kind === 'usageSegments'
            ? [{ status: 'SETTLED', endsAt: '2026-01-01T00:00:01Z' }]
            : [{ status: 'SETTLED', endedAt: '2026-01-01T00:00:01Z', amount: '0.001' }],
    })) as any);
    spies.push(get, audit);

    const client = new XapiAgentsSandboxClient({
      apiKey: 'sk-test', sandboxHost: 'sandbox.test.xapi.to',
    });
    const session = await client.create();

    await expect(session.close()).rejects.toThrow('temporary read failure');
    await session.close();
    await session.close();

    expect(get).toHaveBeenCalledTimes(3);
    expect(client.evidence).toEqual(expect.objectContaining({
      finalState: 'TERMINATED',
      totalCost: '0.001',
      auditVerified: true,
      auditCounts: {
        operations: 1, events: 1, usageSegments: 1, billingPeriods: 1,
      },
    }));
  });
});
