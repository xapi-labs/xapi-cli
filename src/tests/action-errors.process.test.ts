import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = mkdtempSync(join(tmpdir(), 'xapi-action-errors-'));
const preload = join(root, 'fixture.mjs');
writeFileSync(preload, `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const exists = fs.existsSync;
fs.existsSync = p => String(p).endsWith('/.xapi/config.json') ? false : exists(p);
syncBuiltinESMExports();
globalThis.fetch = async () => {
  if (process.env.FIXTURE_NETWORK_ERROR) throw new TypeError('fetch failed');
  return new Response(process.env.FIXTURE_BODY, { status: Number(process.env.FIXTURE_STATUS || 200), headers: {'content-type':'application/json', 'retry-after':'7'} });
};
`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function call(body: unknown, status = 200, networkError = false, flags: string[] = []) {
  const result = spawnSync(process.execPath, ['--preload', preload, resolve(import.meta.dir, '../index.ts'), 'call', 'fixture.action', '--input', '{}', ...flags], {
    env: { ...process.env, XAPI_KEY: 'xapi_fixture_secret', XAPI_OUTPUT: 'json', FIXTURE_BODY: JSON.stringify(body), FIXTURE_STATUS: String(status), FIXTURE_NETWORK_ERROR: networkError ? '1' : '' },
    encoding: 'utf8', timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

describe('actual CLI failure signals', () => {
  test('business failure preserves the envelope and exits nonzero', () => {
    const body = { success: false, data: { reason: 'invalid account' }, error: { code: 'UPSTREAM_ERROR', message: 'Request rejected' } };
    const r = call(body);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual(body);
    expect(JSON.parse(r.stderr).detail).toMatchObject({ code: 'UPSTREAM_ERROR', outcome: 'failed' });
  });
  test('nested success=false and accepted asynchronous work remain successful', () => {
    for (const data of [{ success: false }, { task_id: 'job-1', status: 'pending' }]) {
      const r = call({ success: true, data });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout).data).toEqual(data);
      expect(r.stderr).toBe('');
    }
  });
  test('HTTP validation errors preserve fields after a long message and redact secrets', () => {
    const r = call({ message: 'x'.repeat(400), code: 'INVALID_INPUT', details: [{ instancePath: '/body/name', keyword: 'required', message: 'name required' }], apiKey: 'xapi_fixture_secret' }, 400);
    expect(r.status).toBe(1);
    const detail = JSON.parse(r.stderr).detail;
    expect(detail.status).toBe(400);
    expect(detail.code).toBe('INVALID_INPUT');
    expect(detail.details[0].instancePath).toBe('/body/name');
    expect(r.stderr).not.toContain('xapi_fixture_secret');
  });
  test('429 exposes Retry-After', () => {
    const r = call({ code: 'SERVICE_RATE_LIMIT_EXCEEDED', message: 'Wait' }, 429);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stderr).detail.retry_after_ms).toBe(7000);
  });
  test('SSE/download HTTP errors retain the same structured details', () => {
    const target = join(root, 'failed-download.bin');
    for (const flags of [['--stream'], ['--output', target]]) {
      const r = call({ code: 'SERVICE_RATE_LIMIT_EXCEEDED', details: { scope: 'user_service' } }, 429, false, flags);
      expect(r.status).toBe(1);
      expect(JSON.parse(r.stderr).detail).toMatchObject({ status: 429, code: 'SERVICE_RATE_LIMIT_EXCEEDED', retry_after_ms: 7000, details: { scope: 'user_service' } });
      expect(existsSync(target)).toBe(false);
    }
  });
  test('legacy business auth failure retains its envelope and redacts diagnostics', () => {
    const r = call({ success: false, data: { statusCode: 401, message: 'Invalid xapi_fixture_secret' } });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).success).toBe(false);
    expect(r.stdout + r.stderr).not.toContain('xapi_fixture_secret');
  });
  test('network failure reports an unknown outcome without an automatic retry', () => {
    const r = call({}, 200, true);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stderr).detail).toMatchObject({ code: 'EXECUTION_OUTCOME_UNKNOWN', outcome: 'unknown' });
    expect(JSON.parse(r.stderr).detail.hint).toContain('before retrying a write');
  });
});
