import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as client from '../client.ts';
import * as config from '../config.ts';
import * as format from '../format.ts';
import { usage } from '../commands/usage.ts';

describe('usage command', () => {
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let getConfigSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => {
      throw new Error('err called');
    }) as any);
    getConfigSpy = spyOn(config, 'getConfig').mockReturnValue({
      actionHost: 'action.xapi.to',
      apiKey: 'sk-agent',
    });
  });

  afterEach(() => {
    outputSpy.mockRestore();
    errSpy.mockRestore();
    getConfigSpy.mockRestore();
  });

  it('reads the receipt directly with the configured API key', async () => {
    const receipt = {
      requestId: 'request/1',
      actualCostUsd: '0.00420000',
      balanceAfter: '99.99580000',
    };
    const requestSpy = spyOn(client, 'request').mockResolvedValue(receipt);

    await usage(['request/1'], {});

    expect(requestSpy).toHaveBeenCalledWith(
      'https://api.xapi.to/api/usage/requests/request%2F1',
      { method: 'GET', headers: { 'XAPI-KEY': 'sk-agent' } },
      30_000,
      2,
    );
    expect(outputSpy).toHaveBeenCalledWith(receipt, undefined);
    requestSpy.mockRestore();
  });

  it('requires a request ID', async () => {
    await expect(usage([], {})).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith(
      'request ID required',
      'Run: xapi-to usage <request-id>',
    );
  });
});
