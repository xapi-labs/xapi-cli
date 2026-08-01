/**
 * Tests for the CLI argument parser.
 */

import { describe, it, expect } from 'bun:test';
import { parseArgs } from '../args.ts';

describe('parseArgs', () => {
  it('collects positional args', () => {
    expect(parseArgs(['call', 'twitter.x'])).toEqual({ positional: ['call', 'twitter.x'], flags: {} });
  });

  it('parses --flag value (space form)', () => {
    expect(parseArgs(['get', 'x', '--format', 'table']).flags).toEqual({ format: 'table' });
  });

  it('parses --flag=value (inline form)', () => {
    expect(parseArgs(['get', 'x', '--format=table']).flags).toEqual({ format: 'table' });
  });

  it('allows values starting with -- via the inline form', () => {
    expect(parseArgs(['call', 'x', '--input={"a":"--b"}']).flags).toEqual({ input: '{"a":"--b"}' });
  });

  it('supports an empty inline value', () => {
    expect(parseArgs(['x', '--q=']).flags).toEqual({ q: '' });
  });

  it('treats a trailing --flag as boolean', () => {
    expect(parseArgs(['x', '--force']).flags).toEqual({ force: 'true' });
  });

  it('treats --flag followed by another --flag as boolean', () => {
    expect(parseArgs(['x', '--a', '--b', 'v']).flags).toEqual({ a: 'true', b: 'v' });
  });

  it('stops flag parsing after a bare "--"', () => {
    const r = parseArgs(['call', 'x', '--', '--not-a-flag', 'pos']);
    expect(r.positional).toEqual(['call', 'x', '--not-a-flag', 'pos']);
    expect(r.flags).toEqual({});
  });

  it('preserves an empty space-form value instead of coercing to boolean', () => {
    expect(parseArgs(['x', '--q', '']).flags).toEqual({ q: '' });
  });
});
