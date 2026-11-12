import { describe, expect, test } from 'bun:test';
import { actionErrorDetail, redactActionFailure } from '../action-error.ts';
import { HttpError, RequestTimeoutError } from '../client.ts';

describe('action error details', () => {
  test('timeout stays unknown and warns against replaying a write', () => {
    expect(actionErrorDetail(new RequestTimeoutError(60_000))).toMatchObject({ code: 'REQUEST_TIMEOUT', outcome: 'unknown' });
  });
  test('known HTTP failure stays failed even when the error body cannot be read', () => {
    expect(actionErrorDetail(new HttpError(503, 'could not read error response'))).toMatchObject({ status: 503, outcome: 'failed' });
  });
  test('credentials are redacted recursively without removing field locations', () => {
    expect(redactActionFailure({ details: [{ instancePath: '/body/token', message: 'Bearer sensitive-token' }], apiKey: 'secret', nested: { privateHeaders: { Authorization: 'secret' } } })).toEqual({ details: [{ instancePath: '/body/token', message: 'Bearer [redacted]' }], apiKey: '[redacted]', nested: { privateHeaders: '[redacted]' } });
  });
});
