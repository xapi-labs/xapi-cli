import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

test('shipped Node transport streams privately, rejects redirects and reuses four connections', async () => {
  const root=mkdtempSync(join(resolve(import.meta.dir,'../..'),'.worker-export-test-'));
  try {
    const build=await Bun.build({entrypoints:[join(import.meta.dir,'workers-data-export-native.ts')],outdir:root,
      target:'node',format:'esm',naming:'runner.mjs',external:['undici/index.js']});
    expect(build.success).toBe(true);
    const result=await new Promise<{status:string;checks:string[]}>((resolveResult,reject)=>{
      const child=spawn('node',[join(root,'runner.mjs')],{stdio:['ignore','pipe','pipe']});
      let stdout='',stderr=''; const timer=setTimeout(()=>child.kill('SIGKILL'),15_000);
      child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);code===0?resolveResult(JSON.parse(stdout)):reject(new Error(stderr || 'Native export fixture timed out'));});
    });
    expect(result.status).toBe('passed');expect(result.checks).toContain('four connection reuse');
  } finally {rmSync(root,{recursive:true,force:true});}
},20_000);
