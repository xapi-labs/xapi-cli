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

// Shape of the cold Nest pause receipt; no native stop result exists in this payload.
const receipt = { environmentId: "test-environment", state: "SUSPENDING", version: 3,
  status: "ACCEPTED", retryRequired: true, errorCode: "CONTAINER_STOP_PENDING",
  errorMessage: "CONTAINER_STOP_PENDING", message: "Maintenance has not completed." };

for (const format of ["human", "json"]) test(`real Node pause CLI preserves HTTP 202 exit 0 with ${format} evidence`, async () => {
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
  try {
    const file = await runner(), env = { ...process.env };
    for (const key of Object.keys(env)) if (/API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY/i.test(key)) delete env[key];
    env.XAPI_KEY = "synthetic-retention-key";
    env.XAPI_API_HOST = `127.0.0.1:${(server.address() as any).port}`;
    const args = [file, "workers", "retention", "pause", "worker-1", "--env", "preview"];
    if (format === "json") args.push("--format", "json");
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn("node", args, { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.stdout.on("data", chunk => stdout += chunk);
      child.stderr.on("data", chunk => stderr += chunk);
      child.on("error", error => { clearTimeout(timer); reject(error); });
      child.on("close", code => { clearTimeout(timer); resolveResult({ code, stdout, stderr }); });
    });
    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toEndWith("/worker-1/environments/preview/retention/actions");
    expect(JSON.parse(calls[0].body)).toEqual({ action: "pause" });
    if (format === "json") expect(JSON.parse(result.stdout)).toEqual(receipt);
    else {
      expect(result.stdout).toContain("State: SUSPENDING");
      expect(result.stdout).toContain("Request status: ACCEPTED");
      expect(result.stdout).toContain("Reported pending/error code: CONTAINER_STOP_PENDING");
      expect(result.stdout).toContain("Container stop is not confirmed complete");
      expect(result.stdout).toContain("retryRequired=true");
      expect(result.stdout).toContain("xapi workers retention show worker-1 --env preview --format json");
      expect(result.stdout).not.toContain("Execution is paused");
      expect(result.stdout).not.toContain("retention resume");
      expect(result.stdout).not.toContain("--force");
    }
    expect(result.stdout + result.stderr).not.toContain("synthetic-retention-key");
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}, 30_000);
