/**
 * Tests for config commands
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as client from '../client.ts';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { configShow, configSet, configHealth } from '../commands/config.ts';

describe('config commands', () => {
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    outputSpy.mockRestore();
    errSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  describe('configShow', () => {
    it('calls showConfig', async () => {
      const spy = spyOn(config, 'showConfig').mockImplementation(() => {});
      await configShow([], {});
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe('configSet', () => {
    it('saves apiKey and prints ok', async () => {
      const spy = spyOn(config, 'saveConfig').mockImplementation(() => {});
      await configSet(['apiKey=sk-abc123'], {});
      expect(spy).toHaveBeenCalledWith({ apiKey: 'sk-abc123' });
      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify({ ok: true, updated: ['apiKey'] }));
      spy.mockRestore();
    });

    it('calls err when no args provided', async () => {
      await expect(configSet([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('usage: xapi config set apiKey=<key>');
    });

    it('calls err when key is host', async () => {
      await expect(configSet(['host=example.com'], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('host is built-in and cannot be configured');
    });

    it('calls err for unknown key', async () => {
      await expect(configSet(['foo=bar'], )).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('unknown config key: foo (only apiKey is configurable)');
    });

    it('calls err for malformed arg', async () => {
      await expect(configSet(['noequalssign'], {})).rejects.toThrow('err called');
    });
  });

  describe('configHealth', () => {
    let getConfigSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      getConfigSpy = spyOn(config, 'getConfig').mockReturnValue({
        capabilityHost: 'c.xapi.to',
        proxyHost: 'p.xapi.to',
        apiKey: 'sk-test',
      });
    });

    afterEach(() => {
      getConfigSpy.mockRestore();
    });

    it('outputs ok status on success', async () => {
      const spy = spyOn(client, 'healthCheck').mockResolvedValue({});
      await configHealth([], {});
      expect(outputSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'ok', host: 'c.xapi.to' }),
        undefined,
      );
      spy.mockRestore();
    });

    it('outputs error status and exits on failure', async () => {
      const spy = spyOn(client, 'healthCheck').mockRejectedValue(new Error('connection refused'));
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as any);
      await configHealth([], {});
      expect(outputSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error', host: 'c.xapi.to', error: 'connection refused' }),
        undefined,
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      spy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
