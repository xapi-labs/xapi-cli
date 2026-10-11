import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('real Node HTTP transport and ambiguous Worker writes preserve recovery and never replay', async () => {
  const root = mkdtempSync(join(process.cwd(), '.http-recovery-node-'));
  try {
    const build = await Bun.build({ entrypoints: [join(import.meta.dir, 'client-http-recovery-native.ts')],
      outdir: root, naming: 'runner.mjs', target: 'node', format: 'esm', packages: 'external' });
    expect(build.success).toBe(true);
    const result = spawnSync('node', [join(root, 'runner.mjs')], { encoding: 'utf8', timeout: 15_000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(JSON.parse(result.stdout).result).toBe('passed');
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20_000);
