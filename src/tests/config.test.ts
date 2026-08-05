/**
 * Tests for config commands
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as client from '../client.ts';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { configShow, configSet, configHealth } from '../commands/config.ts';

describe('config commands', () => {
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
  });

  afterEach(() => {
    outputSpy.mockRestore();
    errSpy.mockRestore();
  });

  describe('configShow', () => {
    it('outputs showConfig with the requested format', async () => {
      const summary = { actionHost: 'action.xapi.to', source: { apiKey: 'none' } };
      const spy = spyOn(config, 'showConfig').mockReturnValue(summary);
      await configShow([], {});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(outputSpy).toHaveBeenCalledWith(summary, undefined);
      spy.mockRestore();
    });
  });

  describe('configSet', () => {
    it('saves apiKey and reports that the file key is effective', async () => {
      const spy = spyOn(config, 'saveConfig').mockImplementation(() => {});
      const sourceSpy = spyOn(config, 'getApiKeySource').mockReturnValue('none');
      await configSet(['apiKey=sk-abc123'], {});
      expect(spy).toHaveBeenCalledWith({ apiKey: 'sk-abc123' });
      expect(outputSpy).toHaveBeenCalledWith({
        ok: true,
        updated: ['apiKey'],
        effective: true,
        source: 'file',
      }, undefined);
      spy.mockRestore();
      sourceSpy.mockRestore();
    });

    it('warns when XAPI_KEY still overrides the saved file key', async () => {
      const saveSpy = spyOn(config, 'saveConfig').mockImplementation(() => {});
      const sourceSpy = spyOn(config, 'getApiKeySource').mockReturnValue('XAPI_KEY');
      await configSet(['apiKey=sk-abc123'], { format: 'pretty' });
      expect(outputSpy).toHaveBeenCalledWith(expect.objectContaining({
        ok: true,
        effective: false,
        source: 'XAPI_KEY',
        warning: expect.stringContaining('overrides'),
      }), 'pretty');
      saveSpy.mockRestore();
      sourceSpy.mockRestore();
    });

    it('calls err when no args provided', async () => {
      await expect(configSet([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('usage: xapi-to config set apiKey=<key>');
    });

    it('calls err when key is host', async () => {
      await expect(configSet(['host=example.com'], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('host is built-in and cannot be configured');
    });

    it('calls err for unknown key', async () => {
      await expect(configSet(['foo=bar'], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('unknown config key: foo (only apiKey is configurable)');
    });

    it('calls err for malformed arg', async () => {
      await expect(configSet(['noequalssign'], {})).rejects.toThrow('err called');
    });

    it('reads apiKey from stdin when value is "-"', async () => {
      const saveSpy = spyOn(config, 'saveConfig').mockImplementation(() => {});
      const readSpy = spyOn(fs, 'readFileSync').mockReturnValue('sk-from-stdin\n' as any);
      await configSet(['apiKey=-'], {});
      expect(readSpy).toHaveBeenCalledWith(0, 'utf-8');
      expect(saveSpy).toHaveBeenCalledWith({ apiKey: 'sk-from-stdin' });
      saveSpy.mockRestore();
      readSpy.mockRestore();
    });

    it('calls err when apiKey is empty', async () => {
      await expect(configSet(['apiKey='], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('apiKey is empty');
    });
  });

  describe('configHealth', () => {
    let getConfigSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      getConfigSpy = spyOn(config, 'getConfig').mockReturnValue({
        actionHost: 'action.xapi.to',
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
        expect.objectContaining({ status: 'ok', host: 'action.xapi.to' }),
        undefined,
      );
      spy.mockRestore();
    });

    it('outputs error status and exits on failure', async () => {
      const spy = spyOn(client, 'healthCheck').mockRejectedValue(new Error('connection refused'));
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {}) as any);
      await configHealth([], {});
      expect(outputSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error', host: 'action.xapi.to', error: 'connection refused' }),
        undefined,
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      spy.mockRestore();
      exitSpy.mockRestore();
    });
  });
});
