import { afterAll, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

let root: string | undefined;
let entry: Promise<string> | undefined;
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
async function runner() {
  if (!entry) entry = (async () => {
    root = mkdtempSync(join(resolve(import.meta.dir, "../.."), ".worker-retention-test-"));
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, "../index.ts")], outdir: root,
      target: "node", format: "esm", naming: "cli.mjs",
      external: ["undici", "@openai/agents", "acorn", "busboy", "jsonc-parser", "smol-toml", "zod"] });
    if (!result.success) throw new Error(result.logs.join("\n"));
    return join(root, "cli.mjs");
  })();
  return entry;
}

async function run(args: string[], host: string) {
  const file = await runner(), env = { ...process.env };
  for (const key of Object.keys(env)) if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY/i.test(key)) delete env[key];
  env.XAPI_KEY = "synthetic-retention-key";
  env.XAPI_API_HOST = host;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn("node", [file, "workers", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => { clearTimeout(timer); resolveResult({ code, stdout, stderr }); });
  });
}

async function fixture(receipt: Record<string, unknown>) {
  const calls: Array<{ method: string | undefined; path: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      calls.push({ method: req.method, path: req.url!, body });
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify(receipt));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { calls, host: `127.0.0.1:${(server.address() as any).port}`,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

for (const action of ["resume", "delete"]) for (const format of ["human", "json"])
  test(`real Node ${action} CLI preserves HTTP 202 exit 0 with ${format} evidence`, async () => {
    const state = action === "resume" ? "RESUMING" : "DELETING";
    const receipt = { environmentId: "test-environment", state, version: 3, status: "ACCEPTED" };
    const f = await fixture(receipt);
    try {
      const args = ["retention", action, "worker-1", "--env", "preview"];
      if (action === "delete") args.push("--yes");
      if (format === "json") args.push("--format", "json");
      const result = await run(args, f.host);
      expect(result.code).toBe(0);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].method).toBe("POST");
      expect(f.calls[0].path).toEndWith("/worker-1/environments/preview/retention/actions");
      expect(JSON.parse(f.calls[0].body)).toEqual({ action });
      if (format === "json") expect(JSON.parse(result.stdout)).toEqual(receipt);
      else {
        expect(result.stdout).toContain(`State: ${state}`);
        expect(result.stdout).toContain("Request status: ACCEPTED");
        expect(result.stdout).toContain("work is pending");
        expect(result.stdout).toContain("xapi workers retention show worker-1 --env preview");
      }
      expect(result.stdout + result.stderr).not.toContain("synthetic-retention-key");
    } finally { await f.close(); }
  }, 30_000);

for (const action of ["pause", "keep-paused"]) for (const environment of ["preview", "production"])
  test(`real Node CLI rejects retention ${action} in ${environment} before HTTP`, async () => {
    const f = await fixture({ status: "ACCEPTED" });
    try {
      const result = await run(["retention", action, "worker-1", "--env", environment, "--yes", "--format", "json"], f.host);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("retention show|quote|accept|resume|delete");
      expect(f.calls).toHaveLength(0);
      expect(result.stdout + result.stderr).not.toContain("synthetic-retention-key");
    } finally { await f.close(); }
  }, 30_000);

test("system suspension stays observable with pending native stop evidence", async () => {
  const receipt = { lifecycle: { state: "SUSPENDING", lastErrorCode: "CONTAINER_STOP_PENDING" } };
  const f = await fixture(receipt);
  try {
    const result = await run(["retention", "show", "worker-1", "--env", "preview"], f.host);
    expect(result.code).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].method).toBe("GET");
    expect(f.calls[0].path).toEndWith("/worker-1/environments/preview/retention");
    expect(result.stdout).toContain("Lifecycle SUSPENDING: work is pending");
    expect(result.stdout).toContain("Container stop is not confirmed complete");
    expect(result.stdout).toContain("xapi workers retention show worker-1 --env preview --format json");
  } finally { await f.close(); }
}, 30_000);

for (const action of ["show", "quote"]) for (const retained of [true, false]) for (const format of ["human", "json"])
  test(`retention ${action} gives consistent financial retention guidance: retained=${retained}, ${format}`, async () => {
    const receipt = { policyVersion: "retention-v3", lifecycle: {
      state: retained ? "SUSPENDED_GRACE" : "ACTIVE",
      retentionStartedAt: retained ? "2026-10-11T00:00:00.000Z" : null,
    } };
    const f = await fixture(receipt);
    try {
      const args = ["retention", action, "worker-1", "--env", "preview"];
      if (format === "json") args.push("--format", "json");
      const result = await run(args, f.host);
      expect(result.code).toBe(0);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].method).toBe("GET");
      expect(f.calls[0].path).toEndWith(action === "quote" ? "/retention/quote/WORKER" : "/retention");
      if (format === "json") expect(JSON.parse(result.stdout)).toEqual(receipt);
      else {
        expect(result.stdout).not.toContain("Owner deletion is available at any time");
        expect(result.stdout).toContain("User deletion is unavailable during financial retention");
        expect(result.stdout).toContain("add sufficient funds and explicitly recover first");
        expect(result.stdout).toContain("System cleanup remains independent");
      }
      expect(result.stdout + result.stderr).not.toContain("synthetic-retention-key");
    } finally { await f.close(); }
  }, 30_000);
