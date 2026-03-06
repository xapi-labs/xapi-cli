/**
 * Tests for api commands
 */

import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import * as client from '../client.ts';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { apiList, apiSearch, apiCategories, apiGet, apiCall } from '../commands/api.ts';

const mockApis = [
  { uuid: 'abc-123', status: 'active', meta: { title: 'Token Price', category: 'DeFi', cost: 5 } },
  { uuid: 'def-456', status: 'active', meta: { title: 'News Feed', category: 'News', cost: 3 } },
];

describe('api commands', () => {
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

  describe('apiList', () => {
    it('calls client.apiList and outputs result', async () => {
      const spy = spyOn(client, 'apiList').mockResolvedValue({ apis: mockApis, pagination: {} });
      await apiList([], {});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(outputSpy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('passes pagination flags', async () => {
      const spy = spyOn(client, 'apiList').mockResolvedValue({ apis: [], pagination: {} });
      await apiList([], { page: '2', 'page-size': '20' });
      expect(spy).toHaveBeenCalledWith(expect.any(Object), { page: 2, page_size: 20, category: undefined });
      spy.mockRestore();
    });

    it('passes category filter', async () => {
      const spy = spyOn(client, 'apiList').mockResolvedValue({ apis: [], pagination: {} });
      await apiList([], { category: 'DeFi' });
      expect(spy).toHaveBeenCalledWith(expect.any(Object), { page: undefined, page_size: undefined, category: 'DeFi' });
      spy.mockRestore();
    });

    it('renders table format', async () => {
      const spy = spyOn(client, 'apiList').mockResolvedValue({ apis: mockApis, pagination: {} });
      await apiList([], { format: 'table' });
      expect(outputSpy).toHaveBeenCalledWith(
        mockApis.map(a => ({ id: a.uuid, title: a.meta.title, category: a.meta.category, status: a.status, cost: a.meta.cost })),
        'table',
      );
      spy.mockRestore();
    });

    it('calls err on failure', async () => {
      const spy = spyOn(client, 'apiList').mockRejectedValue(new Error('timeout'));
      await expect(apiList([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('api list failed', 'timeout');
      spy.mockRestore();
    });
  });

  describe('apiSearch', () => {
    it('calls client.apiSearch with query', async () => {
      const spy = spyOn(client, 'apiSearch').mockResolvedValue({ results: mockApis, total_matches: 2, query: 'token' });
      await apiSearch(['token'], {});
      expect(spy).toHaveBeenCalledWith('token', expect.any(Object), { category: undefined, limit: undefined });
      spy.mockRestore();
    });

    it('passes limit and category flags', async () => {
      const spy = spyOn(client, 'apiSearch').mockResolvedValue({ results: [], total_matches: 0, query: 'x' });
      await apiSearch(['x'], { limit: '5', category: 'DeFi' });
      expect(spy).toHaveBeenCalledWith('x', expect.any(Object), { category: 'DeFi', limit: 5 });
      spy.mockRestore();
    });

    it('calls err when no query provided', async () => {
      await expect(apiSearch([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('usage: xapi api search <query>');
    });
  });

  describe('apiCategories', () => {
    it('calls client.apiCategories and outputs result', async () => {
      const spy = spyOn(client, 'apiCategories').mockResolvedValue({ categories: ['DeFi', 'News'], total: 2 });
      await apiCategories([], {});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(outputSpy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('renders table format', async () => {
      const spy = spyOn(client, 'apiCategories').mockResolvedValue({ categories: ['DeFi', 'News'], total: 2 });
      await apiCategories([], { format: 'table' });
      expect(outputSpy).toHaveBeenCalledWith([{ category: 'DeFi' }, { category: 'News' }], 'table');
      spy.mockRestore();
    });
  });

  describe('apiGet', () => {
    it('calls client.apiGet for single id', async () => {
      const spy = spyOn(client, 'apiGet').mockResolvedValue(mockApis[0]);
      await apiGet(['abc-123'], {});
      expect(spy).toHaveBeenCalledWith('abc-123', expect.any(Object));
      spy.mockRestore();
    });

    it('calls client.apiBatch for multiple ids', async () => {
      const spy = spyOn(client, 'apiBatch').mockResolvedValue({ apis: mockApis });
      await apiGet(['abc-123', 'def-456'], {});
      expect(spy).toHaveBeenCalledWith(['abc-123', 'def-456'], expect.any(Object));
      spy.mockRestore();
    });

    it('calls err when no id provided', async () => {
      await expect(apiGet([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('usage: xapi api get <id> [id2 ...]');
    });
  });

  describe('apiCall', () => {
    let cfgSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      cfgSpy = spyOn(config, 'getConfig').mockReturnValue({ capabilityHost: 'c.xapi.to', apiKey: 'sk-test' });
    });

    afterEach(() => {
      cfgSpy.mockRestore();
    });

    it('calls client.apiCall with id and empty input', async () => {
      const spy = spyOn(client, 'apiCall').mockResolvedValue({ data: 'ok' });
      await apiCall(['abc-123'], {});
      expect(spy).toHaveBeenCalledWith('abc-123', {}, expect.any(Object));
      spy.mockRestore();
    });

    it('parses --input JSON flag', async () => {
      const spy = spyOn(client, 'apiCall').mockResolvedValue({ data: 'ok' });
      await apiCall(['abc-123'], { input: '{"query":"BTC"}' });
      expect(spy).toHaveBeenCalledWith('abc-123', { query: 'BTC' }, expect.any(Object));
      spy.mockRestore();
    });

    it('parses positional key=value args', async () => {
      const spy = spyOn(client, 'apiCall').mockResolvedValue({ data: 'ok' });
      await apiCall(['abc-123', 'chain=eth', 'limit=10'], {});
      expect(spy).toHaveBeenCalledWith('abc-123', { chain: 'eth', limit: '10' }, expect.any(Object));
      spy.mockRestore();
    });

    it('calls err when no id provided', async () => {
      await expect(apiCall([], {})).rejects.toThrow('err called');
    });

    it('calls err on invalid --input JSON', async () => {
      await expect(apiCall(['abc-123'], { input: '{bad}' })).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('--input must be valid JSON');
    });

    it('calls err when apiKey is missing', async () => {
      cfgSpy.mockReturnValue({ capabilityHost: 'c.xapi.to', apiKey: undefined });
      await expect(apiCall(['abc-123'], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith(
        'API key not configured',
        'Run "npx @xapi-to/xapi register" to create an account, or "npx @xapi-to/xapi config set apiKey=<key>" to set an existing key.',
      );
    });
  });
});
