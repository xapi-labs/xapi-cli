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

for (const mode of ['flag', 'env', 'options', 'no-proxy', 'disabled', 'direct']) {
  test.skipIf(!node)(`native environment proxy routing is preserved (${mode})`, async () => {
    const root = mkdtempSync(join(process.cwd(), '.env-proxy-test-'));
    try {
      const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'client-env-proxy-native.ts')],
        outdir: root, naming: 'runner.mjs', target: 'node', format: 'esm', packages: 'external' });
      expect(build.success).toBe(true);
      const result = spawnSync(node!, [join(root, 'runner.mjs'), mode], { env, encoding: 'utf8', timeout: 30_000 });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      const { report } = JSON.parse(result.stdout);
      const expected = ['no-proxy', 'disabled', 'direct'].includes(mode) ? 0 : 1;
      for (const operation of ['native', 'request', 'session', 'stream', 'download', 'wrapper', 'timeout', 'cancel', 'redirect']) {
        // Node can replenish a proxy connection after abort without replaying
        // the HTTP request. Count target requests separately from CONNECTs.
        expect(report[operation].targetRequests).toBe(1);
        if (expected && ['timeout', 'cancel'].includes(operation)) {
          expect(report[operation].proxyConnects).toBeGreaterThanOrEqual(1);
        } else expect(report[operation].proxyConnects).toBe(expected);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 40_000);
}
