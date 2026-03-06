/**
 * Tests for cap commands
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import * as client from '../client.ts';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { capList, capSearch, capGet, capCall } from '../commands/cap.ts';

const mockCaps = [
  { id: 'twitter.tweet_detail', version: '1', status: 'stable', meta: { title: 'Get Tweet Detail', cost: 10 } },
  { id: 'web.search', version: '1', status: 'stable', meta: { title: 'Web Search', cost: 5 } },
];

describe('cap commands', () => {
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

  describe('capList', () => {
    it('calls client.capList and outputs result', async () => {
      const spy = spyOn(client, 'capList').mockResolvedValue({ capabilities: mockCaps });
      await capList([], {});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(outputSpy).toHaveBeenCalledWith({ capabilities: mockCaps }, undefined);
      spy.mockRestore();
    });

    it('renders table format', async () => {
      const spy = spyOn(client, 'capList').mockResolvedValue({ capabilities: mockCaps });
      await capList([], { format: 'table' });
      expect(outputSpy).toHaveBeenCalledWith(
        mockCaps.map(c => ({ id: c.id, title: c.meta.title, status: c.status, cost: c.meta.cost })),
        'table',
      );
      spy.mockRestore();
    });

    it('calls err on client failure', async () => {
      const spy = spyOn(client, 'capList').mockRejectedValue(new Error('network error'));
      await expect(capList([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('cap list failed', 'network error');
      spy.mockRestore();
    });
  });

  describe('capSearch', () => {
    it('calls client.capSearch with query', async () => {
      const spy = spyOn(client, 'capSearch').mockResolvedValue({ capabilities: mockCaps });
      await capSearch(['twitter'], {});
      expect(spy).toHaveBeenCalledWith('twitter', expect.any(Object));
      expect(outputSpy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('calls err when no query provided', async () => {
      await expect(capSearch([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('usage: xapi cap search <query>');
    });

    it('uses results field if present', async () => {
      const spy = spyOn(client, 'capSearch').mockResolvedValue({ results: mockCaps });
      await capSearch(['web'], {});
      expect(outputSpy).toHaveBeenCalledWith({ results: mockCaps }, undefined);
      spy.mockRestore();
    });
  });

  describe('capGet', () => {
    it('calls client.capGet with id', async () => {
      const spy = spyOn(client, 'capGet').mockResolvedValue(mockCaps[0]);
      await capGet(['twitter.tweet_detail'], {});
      expect(spy).toHaveBeenCalledWith('twitter.tweet_detail', expect.any(Object));
      expect(outputSpy).toHaveBeenCalledWith(mockCaps[0], undefined);
      spy.mockRestore();
    });

    it('calls err when no id provided', async () => {
      await expect(capGet([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('usage: xapi cap get <id>');
    });
  });

  describe('capCall', () => {
    let cfgSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      cfgSpy = spyOn(config, 'getConfig').mockReturnValue({ capabilityHost: 'c.xapi.to', apiKey: 'sk-test' });
    });

    afterEach(() => {
      cfgSpy.mockRestore();
    });

    it('calls client.capCall with id and empty input', async () => {
      const spy = spyOn(client, 'capCall').mockResolvedValue({ data: 'ok' });
      await capCall(['twitter.tweet_detail'], {});
      expect(spy).toHaveBeenCalledWith('twitter.tweet_detail', {}, expect.any(Object));
      spy.mockRestore();
    });

    it('parses --input JSON flag', async () => {
      const spy = spyOn(client, 'capCall').mockResolvedValue({ data: 'ok' });
      await capCall(['twitter.tweet_detail'], { input: '{"tweet_id":"123"}' });
      expect(spy).toHaveBeenCalledWith('twitter.tweet_detail', { tweet_id: '123' }, expect.any(Object));
      spy.mockRestore();
    });

    it('parses positional key=value args', async () => {
      const spy = spyOn(client, 'capCall').mockResolvedValue({ data: 'ok' });
      await capCall(['twitter.tweet_detail', 'tweet_id=456'], {});
      // numeric strings stay as strings (backend handles type coercion)
      expect(spy).toHaveBeenCalledWith('twitter.tweet_detail', { tweet_id: '456' }, expect.any(Object));
      spy.mockRestore();
    });

    it('calls err when no id provided', async () => {
      await expect(capCall([], {})).rejects.toThrow('err called');
    });

    it('calls err on invalid --input JSON', async () => {
      await expect(capCall(['twitter.tweet_detail'], { input: 'not-json' })).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('--input must be valid JSON');
    });

    it('calls err when apiKey is missing', async () => {
      cfgSpy.mockReturnValue({ capabilityHost: 'c.xapi.to', apiKey: undefined });
      await expect(capCall(['twitter.tweet_detail'], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith(
        'API key not configured',
        'Run "npx @xapi-to/xapi register" to create an account, or "npx @xapi-to/xapi config set apiKey=<key>" to set an existing key.',
      );
    });
  });
});
