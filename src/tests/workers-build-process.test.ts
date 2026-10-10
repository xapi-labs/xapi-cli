import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await pause(25);
  expect(check()).toBe(true);
}
function running(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Exercise the shipped Node runtime with a real shell -> npm script -> child,
// rather than a mocked ChildProcess or Bun's differing signal implementation.
async function fixture(mode: "normal" | "stubborn" | "pipes", timeoutMs: number) {
  const root = mkdtempSync(join(tmpdir(), "xapi-build-process-"));
  symlinkSync(new URL("../../node_modules", import.meta.url).pathname, join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", scripts: { build: "node parent.cjs" } }));
  writeFileSync(join(root, "parent.cjs"), `
    const {spawn} = require('node:child_process');
    const {writeFileSync} = require('node:fs');
    writeFileSync('parent.pid', String(process.pid));
    ${mode === "stubborn" ? "process.on('SIGTERM', () => {});" : ""}
    const child = spawn(process.execPath, ['child.cjs'], {stdio:'inherit'});
    ${mode === "pipes" ? "process.exit(0);" : "child.on('exit', code => process.exit(code));"}
  `);
  writeFileSync(join(root, "child.cjs"), `
    const {writeFileSync} = require('node:fs');
    ${mode !== "normal" ? "process.on('SIGTERM', () => {});" : ""}
    writeFileSync('child.pid', String(process.pid));
    console.log('build-child-stdout'); console.error('build-child-stderr');
    writeFileSync('environment.json', JSON.stringify({safe:process.env.BUILD_FIXTURE_SAFE, leaked:['XAPI_KEY','BUILD_API_KEY','BUILD_TOKEN','BUILD_SECRET','BUILD_PASSWORD','BUILD_CREDENTIAL'].some(name => process.env[name] !== undefined)}));
    ${mode === "normal" ? "writeFileSync('worker.mjs', 'export default {}');" : "setTimeout(() => {writeFileSync('late-output', 'must not happen'); console.log('late-stdout'); console.error('late-stderr');}, 4000); setInterval(() => {}, 1000);"}
  `);
  writeFileSync(join(root, "runner.ts"), `
    import {runWorkerProjectBuild} from ${JSON.stringify(new URL("../workers-project-build.ts", import.meta.url).pathname)};
    try { await runWorkerProjectBuild('npm run build', ${JSON.stringify(root)}, ${timeoutMs}); console.log('build-complete'); }
    catch(error) { console.error(error.message); process.exitCode = 1; }
  `);
  await build({ entryPoints: [join(root, "runner.ts")], outfile: join(root, "runner.js"), bundle: true, packages: "external", platform: "node", format: "esm" });
  let output = "";
  const cli = spawn("node", [join(root, "runner.js")], { stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env, BUILD_FIXTURE_SAFE: "visible", XAPI_KEY: "test-only", BUILD_API_KEY: "test-only",
    BUILD_TOKEN: "test-only", BUILD_SECRET: "test-only", BUILD_PASSWORD: "test-only", BUILD_CREDENTIAL: "test-only",
  } });
  cli.stdout!.on("data", data => output += data);
  cli.stderr!.on("data", data => output += data);
  const completion = new Promise<{code: number | null; signal: string | null}>(resolve => cli.once("close", (code, signal) => resolve({code, signal})));
  return { root, cli, completion, output: () => output, async cleanup() {
    for (const name of ["child.pid", "parent.pid"]) {
      if (existsSync(join(root, name))) {
        const pid = Number(readFileSync(join(root, name), "utf8"));
        if (running(pid)) process.kill(pid, "SIGKILL");
      }
    }
    if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
    cli.stdout?.destroy(); cli.stderr?.destroy();
    await pause(50);
    rmSync(root, { recursive: true, force: true });
  } };
}

test("normal package build completes and filters credential environment variables", async () => {
  const f = await fixture("normal", 5000);
  try {
    await f.completion;
    if (f.cli.exitCode !== 0) throw new Error(f.output());
    expect(await f.completion).toEqual({code: 0, signal: null});
    expect(f.output()).toContain("build-complete");
    expect(f.output()).toContain("build-child-stdout");
    expect(f.output()).toContain("build-child-stderr");
    expect(existsSync(join(f.root, "worker.mjs"))).toBe(true);
    expect(JSON.parse(readFileSync(join(f.root, "environment.json"), "utf8"))).toEqual({safe: "visible", leaked: false});
  } finally { await f.cleanup(); }
}, 10000);

for (const mode of ["stubborn", "pipes"] as const) {
  test.skipIf(process.platform === "win32")(`timeout kills ${mode} descendants, closes pipes and prevents late writes`, async () => {
    const f = await fixture(mode, 1500);
    try {
      await waitFor(() => existsSync(join(f.root, "child.pid")));
      const pid = Number(readFileSync(join(f.root, "child.pid"), "utf8"));
      let completed = false;
      void f.completion.then(() => completed = true);
      await waitFor(() => completed, 2800);
      expect(await f.completion).toEqual({code: 1, signal: null});
      expect(f.output()).toContain("Build exceeded");
      await waitFor(() => !running(pid));
      await pause(4100);
      expect(existsSync(join(f.root, "late-output"))).toBe(false);
      expect(f.output()).not.toContain("late-stdout");
      expect(f.output()).not.toContain("late-stderr");
    } finally { await f.cleanup(); }
  }, 15000);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test.skipIf(process.platform === "win32")(`${signal} cancellation terminates only this build group`, async () => {
    const unrelated: ChildProcess = spawn("node", ["-e", "setInterval(() => {}, 1000)"], {stdio: "ignore"});
    const f = await fixture("stubborn", 10000);
    try {
      await waitFor(() => existsSync(join(f.root, "child.pid")));
      const pid = Number(readFileSync(join(f.root, "child.pid"), "utf8"));
      f.cli.kill(signal);
      let completed = false;
      void f.completion.then(() => completed = true);
      await waitFor(() => completed, 2800);
      const result = await f.completion;
      expect(result.signal === signal || result.code === (signal === "SIGINT" ? 130 : 143)).toBe(true);
      await waitFor(() => !running(pid));
      expect(running(unrelated.pid!)).toBe(true);
      expect(existsSync(join(f.root, "late-output"))).toBe(false);
    } finally { unrelated.kill("SIGKILL"); await f.cleanup(); }
  }, 15000);
}
