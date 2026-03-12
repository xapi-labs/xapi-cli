/**
 * Tests for top-level action commands
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as client from '../client.ts';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { actionList, actionSearch, actionCategories, actionServices, actionGet, actionCall } from '../commands/action.ts';

const mockActions = [
  { id: 'twitter.tweet_detail', source: 'capability', version: '1', status: 'stable', displayName: 'twitter.tweet_detail', meta: { title: 'Get Tweet Detail', category: 'Social', cost: 10 } },
  { id: 'serper.search', source: 'api', uuid: 'abc-123', method: 'GET', version: '1', status: 'stable', displayName: 'GET /search', meta: { title: 'Google Search', category: 'Infrastructure', cost: 1 } },
];

describe('action commands', () => {
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

  describe('actionList', () => {
    it('calls client.actionList without source filter by default', async () => {
      const spy = spyOn(client, 'actionList').mockResolvedValue({ actions: mockActions, pagination: {} });
      await actionList([], {});
      expect(spy).toHaveBeenCalledWith(expect.any(Object), {
        source: undefined, page: undefined, page_size: undefined, category: undefined, service_id: undefined,
      });
      expect(outputSpy).toHaveBeenCalledWith({ actions: mockActions, pagination: {} }, undefined);
      spy.mockRestore();
    });

    it('filters by --source capability', async () => {
      const spy = spyOn(client, 'actionList').mockResolvedValue({ actions: [mockActions[0]], pagination: {} });
      await actionList([], { source: 'capability' });
      expect(spy).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ source: 'capability' }));
      spy.mockRestore();
    });

    it('filters by --source api', async () => {
      const spy = spyOn(client, 'actionList').mockResolvedValue({ actions: [mockActions[1]], pagination: {} });
      await actionList([], { source: 'api' });
      expect(spy).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ source: 'api' }));
      spy.mockRestore();
    });

    it('rejects invalid --source value', async () => {
      await expect(actionList([], { source: 'invalid' })).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('invalid --source value: "invalid". Must be "capability" or "api".');
    });

    it('passes pagination and category flags', async () => {
      const spy = spyOn(client, 'actionList').mockResolvedValue({ actions: [], pagination: {} });
      await actionList([], { page: '2', 'page-size': '10', category: 'Social' });
      expect(spy).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
        page: 2, page_size: 10, category: 'Social',
      }));
      spy.mockRestore();
    });

    it('renders table format with method and displayName columns', async () => {
      const spy = spyOn(client, 'actionList').mockResolvedValue({ actions: mockActions, pagination: {} });
      await actionList([], { format: 'table' });
      expect(outputSpy).toHaveBeenCalledWith(
        mockActions.map((a: any) => ({
          id: a.id, method: a.method ?? '', displayName: a.displayName ?? '', source: a.source, category: a.meta.category, status: a.status, cost: a.meta.cost,
        })),
        'table',
      );
      spy.mockRestore();
    });

    it('calls err on failure', async () => {
      const spy = spyOn(client, 'actionList').mockRejectedValue(new Error('timeout'));
      await expect(actionList([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('list failed', 'timeout');
      spy.mockRestore();
    });
  });

  describe('actionSearch', () => {
    it('searches without source filter by default', async () => {
      const spy = spyOn(client, 'actionSearch').mockResolvedValue({ results: mockActions, query: 'twitter', pagination: {} });
      await actionSearch(['twitter'], {});
      expect(spy).toHaveBeenCalledWith('twitter', expect.any(Object), expect.objectContaining({ source: undefined }));
      spy.mockRestore();
    });

    it('filters by --source capability', async () => {
      const spy = spyOn(client, 'actionSearch').mockResolvedValue({ results: [mockActions[0]], query: 'twitter', pagination: {} });
      await actionSearch(['twitter'], { source: 'capability' });
      expect(spy).toHaveBeenCalledWith('twitter', expect.any(Object), expect.objectContaining({ source: 'capability' }));
      spy.mockRestore();
    });

    it('filters by --source api', async () => {
      const spy = spyOn(client, 'actionSearch').mockResolvedValue({ results: [mockActions[1]], query: 'search', pagination: {} });
      await actionSearch(['search'], { source: 'api' });
      expect(spy).toHaveBeenCalledWith('search', expect.any(Object), expect.objectContaining({ source: 'api' }));
      spy.mockRestore();
    });

    it('passes category, page, and page-size', async () => {
      const spy = spyOn(client, 'actionSearch').mockResolvedValue({ results: [], query: 'x', pagination: {} });
      await actionSearch(['x'], { category: 'Social', page: '2', 'page-size': '5' });
      expect(spy).toHaveBeenCalledWith('x', expect.any(Object), expect.objectContaining({ category: 'Social', page: 2, page_size: 5 }));
      spy.mockRestore();
    });

    it('calls err when no query provided', async () => {
      await expect(actionSearch([], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('usage: xapi search <query>');
    });

    it('calls err on failure', async () => {
      const spy = spyOn(client, 'actionSearch').mockRejectedValue(new Error('fail'));
      await expect(actionSearch(['q'], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('search failed', 'fail');
      spy.mockRestore();
    });
  });

  describe('actionCategories', () => {
    it('fetches all categories by default', async () => {
      const spy = spyOn(client, 'actionCategories').mockResolvedValue({ categories: ['Social', 'Crypto'], total: 2 });
      await actionCategories([], {});
      expect(spy).toHaveBeenCalledWith(expect.any(Object), { source: undefined });
      expect(outputSpy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('filters by --source capability', async () => {
      const spy = spyOn(client, 'actionCategories').mockResolvedValue({ categories: ['Social'], total: 1 });
      await actionCategories([], { source: 'capability' });
      expect(spy).toHaveBeenCalledWith(expect.any(Object), { source: 'capability' });
      spy.mockRestore();
    });

    it('renders table format', async () => {
      const spy = spyOn(client, 'actionCategories').mockResolvedValue({ categories: ['Social', 'Crypto'], total: 2 });
      await actionCategories([], { format: 'table' });
      expect(outputSpy).toHaveBeenCalledWith([{ category: 'Social' }, { category: 'Crypto' }], 'table');
      spy.mockRestore();
    });
  });

  describe('actionServices', () => {
    const mockServices = [
      { id: 'capability', name: 'Built-in Capabilities', category: null, source: 'capability', endpointCount: 19, status: 'ACTIVE' },
      { id: 'uuid-1', name: 'Twitter API', category: 'Social', source: 'api', endpointCount: 26, status: 'ACTIVE' },
    ];

    it('fetches services', async () => {
      const spy = spyOn(client, 'actionServices').mockResolvedValue({ services: mockServices, pagination: {} });
      await actionServices([], {});
      expect(spy).toHaveBeenCalledTimes(1);
      expect(outputSpy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it('renders table format', async () => {
      const spy = spyOn(client, 'actionServices').mockResolvedValue({ services: mockServices, pagination: {} });
      await actionServices([], { format: 'table' });
      expect(outputSpy).toHaveBeenCalledWith(
        mockServices.map(s => ({ id: s.id, name: s.name, category: s.category ?? '', source: s.source, endpoints: s.endpointCount, status: s.status })),
        'table',
      );
      spy.mockRestore();
    });
  });

  describe('actionGet', () => {
    it('unwraps single-element array response', async () => {
      const spy = spyOn(client, 'actionGet').mockResolvedValue([mockActions[0]] as any);
      await actionGet(['twitter.tweet_detail'], {});
      expect(spy).toHaveBeenCalledWith('twitter.tweet_detail', expect.any(Object));
      expect(outputSpy).toHaveBeenCalledWith(mockActions[0], undefined);
      spy.mockRestore();
    });

    it('returns full array when multiple endpoints', async () => {
      const multiEndpoints = [
        { ...mockActions[1], method: 'GET', displayName: 'GET /2/tweets' },
        { ...mockActions[1], method: 'POST', displayName: 'POST /2/tweets' },
      ];
      const spy = spyOn(client, 'actionGet').mockResolvedValue(multiEndpoints as any);
      await actionGet(['x-official.2_tweets'], {});
      expect(outputSpy).toHaveBeenCalledWith(multiEndpoints, undefined);
      spy.mockRestore();
    });

    it('filters by --method flag', async () => {
      const multiEndpoints = [
        { ...mockActions[1], method: 'GET', displayName: 'GET /2/tweets' },
        { ...mockActions[1], method: 'POST', displayName: 'POST /2/tweets' },
      ];
      const spy = spyOn(client, 'actionGet').mockResolvedValue(multiEndpoints as any);
      await actionGet(['x-official.2_tweets'], { method: 'POST' });
      expect(outputSpy).toHaveBeenCalledWith(multiEndpoints[1], undefined);
      spy.mockRestore();
    });

    it('calls err when --method filter finds no match', async () => {
      const spy = spyOn(client, 'actionGet').mockResolvedValue([mockActions[0]] as any);
      await expect(actionGet(['twitter.tweet_detail'], { method: 'DELETE' })).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('no endpoint found for method "DELETE" in action "twitter.tweet_detail"');
      spy.mockRestore();
    });

    it('calls err when no id provided', async () => {
      await expect(actionGet([], {})).rejects.toThrow('err called');
    });
  });

  describe('actionCall', () => {
    let cfgSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      cfgSpy = spyOn(config, 'getConfig').mockReturnValue({ actionHost: 'action.xapi.to', apiKey: 'sk-test' });
    });

    afterEach(() => {
      cfgSpy.mockRestore();
    });

    it('calls client.actionCall with id and empty input', async () => {
      const spy = spyOn(client, 'actionCall').mockResolvedValue({ data: 'ok' });
      await actionCall(['twitter.tweet_detail'], {});
      expect(spy).toHaveBeenCalledWith('twitter.tweet_detail', {}, expect.any(Object));
      spy.mockRestore();
    });

    it('parses --input JSON flag', async () => {
      const spy = spyOn(client, 'actionCall').mockResolvedValue({ data: 'ok' });
      await actionCall(['twitter.tweet_detail'], { input: '{"tweet_id":"123"}' });
      expect(spy).toHaveBeenCalledWith('twitter.tweet_detail', { tweet_id: '123' }, expect.any(Object));
      spy.mockRestore();
    });

    it('calls err when no id provided', async () => {
      await expect(actionCall([], {})).rejects.toThrow('err called');
    });

    it('calls err on invalid --input JSON', async () => {
      await expect(actionCall(['test'], { input: 'not-json' })).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('--input must be valid JSON');
    });

    it('passes method inside input to upstream (no separate --method flag)', async () => {
      const spy = spyOn(client, 'actionCall').mockResolvedValue({ data: 'ok' });
      await actionCall(['x-official.2_tweets'], { input: '{"method":"POST","body":{"text":"hi"}}' });
      expect(spy).toHaveBeenCalledWith('x-official.2_tweets', { method: 'POST', body: { text: 'hi' } }, expect.any(Object));
      spy.mockRestore();
    });

    it('calls err when apiKey is missing', async () => {
      cfgSpy.mockReturnValue({ actionHost: 'action.xapi.to', apiKey: undefined });
      await expect(actionCall(['test'], {})).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith(
        'API key not configured',
        'Run "npx xapi-to register" to create an account, or "npx xapi-to config set apiKey=<key>" to set an existing key.',
      );
    });
  });
});
