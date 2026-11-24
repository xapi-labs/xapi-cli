import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const shape of [false, true]) {
  test(`native fetch loader uses paired transport; Node 18 shape=${shape}`, async () => {
    const root = mkdtempSync(join(process.cwd(), '.native-loader-'));
    try {
      const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'client-native-loader.ts')], outdir: root,
        naming: '[name].mjs', target: 'node', format: 'esm', packages: 'external' });
      expect(build.success).toBe(true);
      const result = spawnSync('node', [join(root, 'client-native-loader.mjs'), ...(shape ? ['--node18-shape'] : [])],
        { encoding: 'utf8', timeout: 5000 });
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toMatchObject({ result: 'passed', dispatches: 2, intercepted: 1 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 10000);
}
