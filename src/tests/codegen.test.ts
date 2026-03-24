/**
 * Tests for code generation module
 */

import { describe, it, expect } from 'bun:test';
import { resolveTarget, buildDefaultInput, generateCode } from '../codegen.ts';

describe('resolveTarget', () => {
  it('resolves short aliases', () => {
    expect(resolveTarget('py')).toEqual({ lang: 'python', lib: 'requests' });
    expect(resolveTarget('js')).toEqual({ lang: 'javascript', lib: 'fetch' });
    expect(resolveTarget('ts')).toEqual({ lang: 'typescript', lib: 'fetch' });
    expect(resolveTarget('curl')).toEqual({ lang: 'curl', lib: 'curl' });
    expect(resolveTarget('go')).toEqual({ lang: 'go', lib: 'net/http' });
  });

  it('resolves full language names', () => {
    expect(resolveTarget('python')).toEqual({ lang: 'python', lib: 'requests' });
    expect(resolveTarget('javascript')).toEqual({ lang: 'javascript', lib: 'fetch' });
    expect(resolveTarget('typescript')).toEqual({ lang: 'typescript', lib: 'fetch' });
  });

  it('resolves language.library format', () => {
    expect(resolveTarget('python.requests')).toEqual({ lang: 'python', lib: 'requests' });
    expect(resolveTarget('python.httpx')).toEqual({ lang: 'python', lib: 'httpx' });
    expect(resolveTarget('javascript.fetch')).toEqual({ lang: 'javascript', lib: 'fetch' });
    expect(resolveTarget('javascript.axios')).toEqual({ lang: 'javascript', lib: 'axios' });
    expect(resolveTarget('py.httpx')).toEqual({ lang: 'python', lib: 'httpx' });
    expect(resolveTarget('js.axios')).toEqual({ lang: 'javascript', lib: 'axios' });
  });

  it('is case-insensitive', () => {
    expect(resolveTarget('Python')).toEqual({ lang: 'python', lib: 'requests' });
    expect(resolveTarget('CURL')).toEqual({ lang: 'curl', lib: 'curl' });
    expect(resolveTarget('JS')).toEqual({ lang: 'javascript', lib: 'fetch' });
  });

  it('throws on unknown target', () => {
    expect(() => resolveTarget('ruby')).toThrow('unknown --code target');
    expect(() => resolveTarget('rust')).toThrow('unknown --code target');
  });
});

describe('buildDefaultInput', () => {
  it('uses default values from schema', () => {
    const schema = {
      properties: {
        query: { type: 'string', default: 'hello' },
        count: { type: 'number', default: 10 },
        verbose: { type: 'boolean', default: true },
      },
    };
    expect(buildDefaultInput(schema)).toEqual({
      query: 'hello',
      count: 10,
      verbose: true,
    });
  });

  it('falls back to type defaults when no default specified', () => {
    const schema = {
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
        active: { type: 'boolean' },
        tags: { type: 'array' },
        meta: { type: 'object' },
      },
    };
    expect(buildDefaultInput(schema)).toEqual({
      name: '',
      age: 0,
      active: false,
      tags: [],
      meta: {},
    });
  });

  it('returns empty object when no properties', () => {
    expect(buildDefaultInput({})).toEqual({});
    expect(buildDefaultInput({ properties: undefined })).toEqual({});
  });

  it('handles integer type', () => {
    const schema = { properties: { page: { type: 'integer' } } };
    expect(buildDefaultInput(schema)).toEqual({ page: 0 });
  });

  it('falls back to empty string for unknown types', () => {
    const schema = { properties: { val: { type: 'null' as any } } };
    expect(buildDefaultInput(schema)).toEqual({ val: '' });
  });

  it('returns fresh object/array instances on each call (no shared references)', () => {
    const schema = {
      properties: {
        tags: { type: 'array' },
        meta: { type: 'object' },
      },
    };
    const a = buildDefaultInput(schema);
    const b = buildDefaultInput(schema);
    expect(a.tags).not.toBe(b.tags);
    expect(a.meta).not.toBe(b.meta);
  });

  it('clones reference-type default values to prevent shared mutation', () => {
    const schema = {
      properties: {
        items: { type: 'array', default: ['a', 'b'] },
        config: { type: 'object', default: { key: 'val' } },
      },
    };
    const a = buildDefaultInput(schema);
    const b = buildDefaultInput(schema);
    expect(a.items).toEqual(['a', 'b']);
    expect(a.items).not.toBe(b.items);
    expect(a.config).not.toBe(b.config);
  });
});

describe('generateCode', () => {
  const params = {
    actionId: 'twitter.tweet_detail',
    input: { tweet_id: '123' },
    actionHost: 'action.xapi.to',
  };

  describe('curl', () => {
    it('generates valid curl command', () => {
      const result = generateCode('curl', params);
      expect(result.lang).toBe('curl');
      expect(result.lib).toBe('curl');
      expect(result.code).toContain('curl -X POST');
      expect(result.code).toContain('https://action.xapi.to/v1/actions/execute');
      expect(result.code).toContain('XAPI-Key');
      expect(result.code).toContain('XAPI_KEY');
      expect(result.code).toContain('twitter.tweet_detail');
      expect(result.code).toContain('"tweet_id": "123"');
    });

    it('escapes single quotes in input values', () => {
      const result = generateCode('curl', {
        ...params,
        input: { query: "it's a test" },
      });
      expect(result.code).toContain("'\\''");
      expect(result.code).not.toMatch(/[^\\]'s a test'/);
    });
  });

  describe('python', () => {
    it('generates requests code', () => {
      const result = generateCode('python', params);
      expect(result.lang).toBe('python');
      expect(result.lib).toBe('requests');
      expect(result.code).toContain('import requests');
      expect(result.code).toContain('requests.post');
      expect(result.code).toContain('os.environ["XAPI_KEY"]');
      expect(result.code).toContain('XAPI-Key');
      expect(result.code).toContain('twitter.tweet_detail');
    });

    it('generates httpx code', () => {
      const result = generateCode('python.httpx', params);
      expect(result.lang).toBe('python');
      expect(result.lib).toBe('httpx');
      expect(result.code).toContain('import httpx');
      expect(result.code).toContain('httpx.post');
    });

    it('formats Python booleans correctly', () => {
      const result = generateCode('py', {
        ...params,
        input: { flag: true, other: false },
      });
      expect(result.code).toContain('True');
      expect(result.code).toContain('False');
      expect(result.code).not.toContain('true');
      expect(result.code).not.toContain('false');
    });

    it('formats Python None for null values', () => {
      const result = generateCode('py', {
        ...params,
        input: { value: null as any },
      });
      expect(result.code).toContain('None');
    });
  });

  describe('javascript', () => {
    it('generates fetch code', () => {
      const result = generateCode('js', params);
      expect(result.lang).toBe('javascript');
      expect(result.lib).toBe('fetch');
      expect(result.code).toContain('await fetch');
      expect(result.code).toContain('process.env.XAPI_KEY');
      expect(result.code).toContain('XAPI-Key');
      expect(result.code).toContain('twitter.tweet_detail');
    });

    it('generates axios code', () => {
      const result = generateCode('js.axios', params);
      expect(result.lang).toBe('javascript');
      expect(result.lib).toBe('axios');
      expect(result.code).toContain('import axios');
      expect(result.code).toContain('axios.post');
    });
  });

  describe('typescript', () => {
    it('generates fetch code with types', () => {
      const result = generateCode('ts', params);
      expect(result.lang).toBe('typescript');
      expect(result.lib).toBe('fetch');
      expect(result.code).toContain('const resp: Response');
      expect(result.code).toContain('process.env.XAPI_KEY!');
    });
  });

  describe('go', () => {
    it('generates net/http code', () => {
      const result = generateCode('go', params);
      expect(result.lang).toBe('go');
      expect(result.lib).toBe('net/http');
      expect(result.code).toContain('package main');
      expect(result.code).toContain('http.NewRequest');
      expect(result.code).toContain('os.Getenv("XAPI_KEY")');
      expect(result.code).toContain('XAPI-Key');
    });

    it('handles backticks in input values via Go string concatenation', () => {
      const result = generateCode('go', {
        ...params,
        input: { query: 'text`with`backticks' },
      });
      expect(result.code).toContain('` + "`" + `');
    });
  });

  it('uses localhost scheme for local hosts', () => {
    const result = generateCode('curl', { ...params, actionHost: 'localhost:3003' });
    expect(result.code).toContain('http://localhost:3003');
  });

  it('rejects malicious actionHost values', () => {
    expect(() => generateCode('curl', {
      ...params,
      actionHost: 'evil.com"; rm -rf /',
    })).toThrow('invalid actionHost');

    expect(() => generateCode('py', {
      ...params,
      actionHost: 'x.to/../../evil',
    })).toThrow('invalid actionHost');
  });

  it('accepts valid actionHost values', () => {
    expect(() => generateCode('curl', { ...params, actionHost: 'action.xapi.to' })).not.toThrow();
    expect(() => generateCode('curl', { ...params, actionHost: 'localhost:3003' })).not.toThrow();
    expect(() => generateCode('curl', { ...params, actionHost: '127.0.0.1:8080' })).not.toThrow();
  });

  describe('curl header quoting', () => {
    it('uses double quotes for XAPI-Key header to prevent word splitting', () => {
      const result = generateCode('curl', params);
      expect(result.code).toContain('-H "XAPI-Key: ${XAPI_KEY}"');
    });
  });
});
