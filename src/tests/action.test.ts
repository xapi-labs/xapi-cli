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

    it('outputs code snippet when --code flag is set', async () => {
      const mockSchema = {
        ...mockActions[0],
        input: {
          type: 'object',
          required: ['tweet_id'],
          properties: {
            tweet_id: { type: 'string' },
            with_community: { type: 'boolean', default: true },
          },
        },
      };
      const spy = spyOn(client, 'actionGet').mockResolvedValue([mockSchema] as any);
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      await actionGet(['twitter.tweet_detail'], { code: 'curl', format: 'pretty' });
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('curl -X POST');
      expect(output).toContain('twitter.tweet_detail');
      expect(output).toContain('XAPI-Key');
      spy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('outputs JSON-wrapped code when --code with default format', async () => {
      const mockSchema = {
        ...mockActions[0],
        input: { type: 'object', properties: { tweet_id: { type: 'string' } } },
      };
      const spy = spyOn(client, 'actionGet').mockResolvedValue([mockSchema] as any);
      await actionGet(['twitter.tweet_detail'], { code: 'py' });
      expect(outputSpy).toHaveBeenCalledWith(
        expect.objectContaining({ language: 'python', library: 'requests', code: expect.any(String) }),
        'json',
      );
      spy.mockRestore();
    });

    it('calls err when --code has no value (bare flag) without making API call', async () => {
      const spy = spyOn(client, 'actionGet');
      await expect(actionGet(['twitter.tweet_detail'], { code: 'true' })).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy).toHaveBeenCalledWith(
        '--code requires a target language, e.g. --code curl, --code py, --code js',
      );
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('includes top-level method and excludes input.method in --code for API actions', async () => {
      const mockSchema = {
        ...mockActions[1],
        method: 'POST',
        input: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['POST'], description: 'HTTP method (fixed: POST)' },
            body: { type: 'object', properties: { text: { type: 'string' } } },
          },
          required: ['method', 'body'],
        },
      };
      const spy = spyOn(client, 'actionGet').mockResolvedValue([mockSchema] as any);
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      await actionGet(['x-official.2_tweets'], { code: 'curl', format: 'pretty' });
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('"method": "POST"');
      expect(output).not.toContain('"method": ""');
      spy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('warns to stderr when action has multiple endpoints under --code', async () => {
      const multiActions = [
        { ...mockActions[0], method: 'GET', input: {} },
        { ...mockActions[0], method: 'POST', input: {} },
      ];
      const spy = spyOn(client, 'actionGet').mockResolvedValue(multiActions as any);
      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      await actionGet(['twitter.tweet_detail'], { code: 'curl', format: 'pretty' });
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('Warning: action "twitter.tweet_detail" has 2 endpoints'),
      );
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('curl -X POST');
      spy.mockRestore();
      stderrSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('throws for unknown --code target without making API call', async () => {
      const spy = spyOn(client, 'actionGet');
      await expect(actionGet(['test'], { code: 'ruby' })).rejects.toThrow('unknown --code target');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
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
      expect(spy).toHaveBeenCalledWith('twitter.tweet_detail', {}, expect.any(Object), undefined);
      spy.mockRestore();
    });

    it('parses --input JSON flag', async () => {
      const spy = spyOn(client, 'actionCall').mockResolvedValue({ data: 'ok' });
      await actionCall(['twitter.tweet_detail'], { input: '{"tweet_id":"123"}' });
      expect(spy).toHaveBeenCalledWith('twitter.tweet_detail', { tweet_id: '123' }, expect.any(Object), undefined);
      spy.mockRestore();
    });

    it('calls err when no id provided', async () => {
      await expect(actionCall([], {})).rejects.toThrow('err called');
    });

    it('calls err on invalid --input JSON', async () => {
      await expect(actionCall(['test'], { input: 'not-json' })).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('--input must be valid JSON');
    });

    it('extracts method from input and passes as separate param', async () => {
      const spy = spyOn(client, 'actionCall').mockResolvedValue({ data: 'ok' });
      await actionCall(['x-official.2_tweets'], { input: '{"method":"POST","body":{"text":"hi"}}' });
      expect(spy).toHaveBeenCalledWith('x-official.2_tweets', { body: { text: 'hi' } }, expect.any(Object), 'POST');
      spy.mockRestore();
    });

    it('--method flag takes priority over method in input', async () => {
      const spy = spyOn(client, 'actionCall').mockResolvedValue({ data: 'ok' });
      await actionCall(['x-official.2_tweets'], { input: '{"method":"GET","body":{"text":"hi"}}', method: 'POST' });
      expect(spy).toHaveBeenCalledWith('x-official.2_tweets', { body: { text: 'hi' } }, expect.any(Object), 'POST');
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

    it('outputs code snippet and does not execute when --code flag is set', async () => {
      const callSpy = spyOn(client, 'actionCall');
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      await actionCall(['twitter.tweet_detail'], { input: '{"tweet_id":"123"}', code: 'py', format: 'pretty' });
      expect(callSpy).not.toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('requests.post');
      expect(output).toContain('"tweet_id": "123"');
      callSpy.mockRestore();
      consoleSpy.mockRestore();
    });

    it('does not require apiKey when --code flag is set', async () => {
      cfgSpy.mockReturnValue({ actionHost: 'action.xapi.to', apiKey: undefined });
      const consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      await actionCall(['test'], { code: 'curl', format: 'pretty' });
      expect(consoleSpy).toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('throws for unknown --code target', async () => {
      await expect(actionCall(['test'], { code: 'ruby' })).rejects.toThrow('unknown --code target');
    });

    it('calls err when --code has no value (bare flag)', async () => {
      await expect(actionCall(['test'], { code: 'true' })).rejects.toThrow('err called');
      expect(errSpy).toHaveBeenCalledWith('--code requires a target language, e.g. --code curl, --code py, --code js');
    });
  });

  describe('subcommand --help', () => {
    let consoleSpy: ReturnType<typeof spyOn>;
    let exitSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      consoleSpy = spyOn(console, 'log').mockImplementation(() => {});
      exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); }) as any;
    });

    afterEach(() => {
      consoleSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it('actionList --help prints help and exits', async () => {
      await expect(actionList([], { help: 'true' })).rejects.toThrow('process.exit');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('xapi list'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('--source'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('actionSearch --help prints help and exits', async () => {
      await expect(actionSearch([], { help: 'true' })).rejects.toThrow('process.exit');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('xapi search'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('--category'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('actionGet --help prints help and exits', async () => {
      await expect(actionGet([], { help: 'true' })).rejects.toThrow('process.exit');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('xapi get'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('CODE TARGETS'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('python.httpx'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('actionCall --help prints help and exits', async () => {
      await expect(actionCall([], { help: 'true' })).rejects.toThrow('process.exit');
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('xapi call'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('--input'));
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('CODE TARGETS'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('--help takes priority over missing arguments', async () => {
      // Even without required args, --help should show help instead of error
      await expect(actionGet([], { help: 'true' })).rejects.toThrow('process.exit');
      expect(errSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });
});
