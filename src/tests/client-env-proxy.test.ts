import { expect, test } from 'bun:test';
import { readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/PROXY|NODE_OPTIONS|API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY/i.test(key)) delete env[key];
}
env.NODE_USE_ENV_PROXY = '0';
// Use an already installed supporting Node; never download a runtime for tests.
const candidates = ['node'];
const versions = join(homedir(), '.nvm/versions/node');
try {
  for (const version of readdirSync(versions).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    candidates.push(join(versions, version, 'bin/node'));
  }
} catch { /* optional local installations */ }
const node = candidates.find(binary => {
  const result = spawnSync(binary, ['--help'], { env, encoding: 'utf8', timeout: 5000 });
  return result.status === 0 && result.stdout.includes('--use-env-proxy');
});
const configSupported = node && spawnSync(node, ['--help'], { env, encoding: 'utf8' }).stdout.includes('--experimental-config-file');
const version = node && spawnSync(node, ['--version'], { env, encoding: 'utf8' }).stdout.trim();

for (const mode of ['flag', 'env', 'options', 'no-proxy', 'disabled', 'direct',
  'config', 'config-disabled', 'config-no-proxy', 'config-direct', 'default-config',
  'flag-underscore', 'options-underscore', 'config-underscore', 'config-underscore-direct', 'negative-underscore',
  'config-false-env', 'default-config-false-env', 'config-absent-env', 'config-false-env-options', 'config-false-env-flag',
  'config-underscore-false-env', 'disabled-env', 'preload-delete-env', 'preload-options-delete-env', 'require-delete-env',
  'config-false-env-preload']) {
  test.skipIf(!node || (mode.includes('config') && !configSupported))(`native environment proxy routing is preserved (${mode}, ${version})`, async () => {
    const root = mkdtempSync(join(process.cwd(), '.env-proxy-test-'));
    try {
      const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'client-env-proxy-native.ts')],
        outdir: root, naming: 'runner.mjs', target: 'node', format: 'esm', packages: 'external' });
      expect(build.success).toBe(true);
      const result = spawnSync(node!, [join(root, 'runner.mjs'), mode], { env, encoding: 'utf8', timeout: 30_000 });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      const { report } = JSON.parse(result.stdout);
      const direct = ['disabled', 'disabled-env', 'direct', 'config-disabled', 'config-direct',
        'config-underscore-direct', 'negative-underscore'].includes(mode);
      // Node 22/24 differ on false config plus NODE_USE_ENV_PROXY=1. Aliased
      // config loading also varies. Compare actual no-CLI native routing, not
      // getOptionValue or the adapter's own prediction; bypasses must fail.
      const nativePrecedence = ['config-false-env', 'default-config-false-env', 'config-underscore',
        'config-underscore-false-env', 'config-false-env-preload'].includes(mode);
      expect([0, 1]).toContain(report.native.proxyConnects);
      const expected = nativePrecedence ? report.native.proxyConnects
        : direct || ['no-proxy', 'config-no-proxy'].includes(mode) ? 0 : 1;
      const disabled = direct || (!expected && ['config-false-env', 'default-config-false-env'].includes(mode));
      for (const operation of ['native', 'request', 'session', 'stream', 'download', 'wrapper', 'timeout', 'cancel', 'redirect']) {
        // Node can replenish a proxy connection after abort without replaying
        // the HTTP request. Count target requests separately from CONNECTs.
        expect(report[operation].targetRequests).toBe(1);
        if (expected && ['timeout', 'cancel'].includes(operation)) {
          expect(report[operation].proxyConnects).toBeGreaterThanOrEqual(1);
        } else expect(report[operation].proxyConnects).toBe(expected);
        if (['request', 'session'].includes(operation)) {
          // NO_PROXY still uses native routing. Explicitly disabled proxy modes
          // must recover the paired transport as well as making direct requests.
          expect(report[operation].deadlineDispatches).toBe(disabled ? 1 : 0);
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);
}
