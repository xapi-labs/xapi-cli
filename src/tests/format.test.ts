/**
 * Tests for output formatting
 */

import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { output } from '../format.ts';

describe('output formatting', () => {
  let consoleSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    consoleSpy?.mockRestore();
    consoleSpy = undefined;
  });

  it('renders table rows from wrapped objects', () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

    output({ bindings: [{ id: 'bind-1', provider: 'Twitter' }], count: 1 }, 'table');

    expect(consoleSpy.mock.calls[0][0]).toContain('id');
    expect(consoleSpy.mock.calls[0][0]).toContain('provider');
    expect(consoleSpy.mock.calls.some((call: any[]) => String(call[0]).includes('bind-1'))).toBe(true);
  });

  it('stringifies nested table values instead of printing [object Object]', () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

    output([
      {
        id: 'prov-1',
        scopeDefinitions: [{ scope: 'tweet.read', required: true }],
      },
    ], 'table');

    const printed = consoleSpy.mock.calls.map((call: any[]) => String(call[0])).join('\n');
    expect(printed).toContain('"tweet.read"');
    expect(printed).not.toContain('[object Object]');
  });

  it('marks truncated table cells instead of silently cutting identifiers', () => {
    consoleSpy = spyOn(console, 'log').mockImplementation(() => {});

    output([{ id: 'x'.repeat(80) }], 'table');

    const printed = consoleSpy.mock.calls.map((call: any[]) => String(call[0])).join('\n');
    expect(printed).toContain('…');
    expect(printed).not.toContain('x'.repeat(80));
  });
});
