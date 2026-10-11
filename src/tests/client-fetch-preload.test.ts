import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const proxy of [false, true]) {
  test(`Node --import ${proxy ? 'proxy' : 'wrapper'} fetch intercepts reads, uploads, downloads and SSE`, async () => {
    const root = mkdtempSync(join(process.cwd(), '.fetch-preload-node-'));
    try {
      const build = await Bun.build({ entrypoints: ['client-fetch-preload.ts', 'client-fetch-preload-native.ts'].map(file => join(import.meta.dir, file)),
        outdir: root, naming: '[name].mjs', target: 'node', format: 'esm', packages: 'external' });
      expect(build.success).toBe(true);
      const result = spawnSync('node', ['--import', join(root, 'client-fetch-preload.mjs'), join(root, 'client-fetch-preload-native.mjs')],
        { encoding: 'utf8', timeout: 10_000, env: { ...process.env, XAPI_TEST_PRELOAD_PROXY: proxy ? '1' : '0' } });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toMatchObject({ result: 'passed', unexpectedNetworkRequests: 0, restoredNetworkRequests: 1, intercepted: 4 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
}
