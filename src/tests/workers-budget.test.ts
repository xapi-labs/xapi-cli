import { afterEach, expect, spyOn, test } from 'bun:test';
import * as config from '../config.ts';
import * as client from '../workers-client.ts';
import { workersCommand } from '../commands/workers.ts';

function fixture() {
  const configSpy = spyOn(config, 'getConfig').mockReturnValue({ actionHost: 'test.xapi.to', apiKey: 'synthetic-budget-key' });
  const mutation = spyOn(client, 'updateWorkerBudget');
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async () => Response.json({})) as unknown as typeof fetch);
  const log = spyOn(console, 'log').mockImplementation(() => {});
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const exit = spyOn(process, 'exit').mockImplementation((() => { throw new Error('CLI_EXIT_1'); }) as never);
  return { configSpy, mutation, fetchSpy, errors, restore() {
    exit.mockRestore(); errors.mockRestore(); log.mockRestore(); fetchSpy.mockRestore();
    mutation.mockRestore(); configSpy.mockRestore();
  } };
}

let current: ReturnType<typeof fixture> | undefined;
afterEach(() => { current?.restore(); current = undefined; });

for (const value of [undefined, '', 'true']) {
  test(`budget rejects missing daily amount (${String(value)}) before configuration or mutation`, async () => {
    const f = current = fixture();
    await expect(workersCommand(['budget', 'worker-owned', 'preview'],
      value === undefined ? {} : { 'daily-usd': value })).rejects.toThrow('CLI_EXIT_1');
    expect(f.errors.mock.calls.map(call => String(call[0])).join(' ')).toContain('--daily-usd is required');
    expect(f.configSpy).not.toHaveBeenCalled();
    expect(f.mutation).not.toHaveBeenCalled();
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
}

for (const environment of ['preview', 'production']) {
  for (const [value, expected] of [['none', null], ['0', 0], ['0.25', 0.25], ['100', 100]] as const) {
    test(`budget ${environment} forwards explicit ${value}`, async () => {
      const f = current = fixture();
      await workersCommand(['budget', 'worker-owned', environment], { 'daily-usd': value });
      expect(f.mutation).toHaveBeenCalledTimes(1);
      expect(f.mutation.mock.calls[0].slice(1)).toEqual(['worker-owned', environment, expected]);
      expect(f.fetchSpy).toHaveBeenCalledTimes(1);
      const [url, request] = f.fetchSpy.mock.calls[0];
      expect(String(url)).toEndWith(`/workers/worker-owned/environments/${environment}`);
      expect(request?.method).toBe('PATCH');
      expect(JSON.parse(request?.body as string)).toEqual({ dailyBudgetUsd: expected });
    });
  }
}
