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
        { encoding: 'utf8', timeout: 10_000, env: { ...process.env, XAPI_TEST_PRELOAD_PROXY: proxy ? '1' : '0', XAPI_TEST_PRELOAD_DELEGATE: '0' } });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toMatchObject({ result: 'passed', unexpectedNetworkRequests: 0, restoredNetworkRequests: 1, intercepted: 4 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
}

for (const proxy of [false, true]) {
  test(`Node --import ${proxy ? 'proxy' : 'wrapper'} delegates real HTTP and preserves abort/response idle timers`, async () => {
    const root = mkdtempSync(join(process.cwd(), '.fetch-delegate-node-'));
    try {
      const build = await Bun.build({ entrypoints: ['client-fetch-preload.ts', 'client-fetch-delegate-native.ts', 'client-fetch-delegate-server.ts'].map(file => join(import.meta.dir, file)),
        outdir: root, naming: '[name].mjs', target: 'node', format: 'esm', packages: 'external' });
      expect(build.success).toBe(true);
      const result = spawnSync('node', ['--import', join(root, 'client-fetch-preload.mjs'), join(root, 'client-fetch-delegate-native.mjs')],
        { encoding: 'utf8', timeout: 15_000, env: { ...process.env, XAPI_TEST_PRELOAD_PROXY: proxy ? '1' : '0', XAPI_TEST_PRELOAD_DELEGATE: '1' } });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toMatchObject({ result: 'passed', intercepted: 17 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 20_000);
}

test('Bun default fetch preserves upload and response idle deadlines over real HTTP', async () => {
  const root = mkdtempSync(join(process.cwd(), '.fetch-delegate-bun-'));
  try {
    const build = await Bun.build({ entrypoints: ['client-fetch-delegate-native.ts', 'client-fetch-delegate-server.ts'].map(file => join(import.meta.dir, file)),
      outdir: root, naming: '[name].mjs', target: 'node', format: 'esm', packages: 'external' });
    expect(build.success).toBe(true);
    const result = spawnSync('bun', [join(root, 'client-fetch-delegate-native.mjs')],
      { encoding: 'utf8', timeout: 15_000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({ result: 'passed', intercepted: 0 });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
