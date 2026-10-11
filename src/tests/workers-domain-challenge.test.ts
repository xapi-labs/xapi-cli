import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWorkerDomainChallenge } from "../workers-domain-challenge.ts";
import { workersCommand } from "../commands/workers.ts";
import * as config from "../config.ts";

const directories: string[] = [];
const restore: Array<() => void> = [];
const challenge = () => ({ challengeToken: "signed-token", hostname: "chat.example.com", environment: "preview",
  expiresAt: new Date(Date.now() + 600_000).toISOString(), dns: { type: "TXT" as const, name: "_xapi-worker-challenge.chat.example.com", value: "proof", ttl: 60 } });
async function saved(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "xapi-domain-")); directories.push(dir);
  const file = join(dir, "challenge.json");
  await writeFile(file, JSON.stringify(value)); return file;
}
afterEach(async () => { for (const fn of restore.splice(0).reverse()) fn(); for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("manual DNS challenge", () => {
  it("accepts saved API output and rejects mismatched environments or expired challenges", async () => {
    const value = challenge(); const file = await saved(value);
    expect(await readWorkerDomainChallenge(file, "preview")).toEqual(value);
    await expect(readWorkerDomainChallenge(file, "production")).rejects.toThrow("environment differs");
    await expect(readWorkerDomainChallenge(await saved({ ...value, expiresAt: "2020-01-01" }), "preview")).rejects.toThrow("expired");
    await expect(readWorkerDomainChallenge(await saved({ challengeToken: "hidden" }), "preview")).rejects.toThrow("metadata");
  });
  it("bounds the file before JSON parsing and never includes malformed token contents in errors", async () => {
    const file = await saved(challenge());
    await writeFile(file, "secret-invalid-json");
    await expect(readWorkerDomainChallenge(file, "preview")).rejects.toThrow("not valid JSON");
    await writeFile(file, "x".repeat(65_537));
    await expect(readWorkerDomainChallenge(file, "preview")).rejects.toThrow("64 KiB");
  });
  it("exposes challenge and single-request attach without xdomain or CF credentials", async () => {
    const envNames = ["XAPI_KEY", "XAPI_API_HOST", "XAPI_OUTPUT"] as const;
    const previous = envNames.map(name => process.env[name]);
    restore.push(() => envNames.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
    process.env.XAPI_KEY = "sk-test"; process.env.XAPI_API_HOST = "api.test.xapi.to"; process.env.XAPI_OUTPUT = "json";
    const configSpy = spyOn(config, "getConfig").mockReturnValue({ apiKey: "sk-test", actionHost: "action.xapi.to" });
    restore.push(() => configSpy.mockRestore());
    const value = challenge(); const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (target: string | URL | Request, init?: RequestInit) => {
      const url = String(target); calls.push({ url, init });
      return Response.json(url.endsWith("/challenges") ? value : { id: "domain-1", status: "PROVISIONING" });
    }) as typeof fetch); restore.push(() => fetchSpy.mockRestore());
    const print = spyOn(console, "log").mockImplementation(() => {}); restore.push(() => print.mockRestore());
    await workersCommand(["domains", "challenge", "worker-1"], { env: "preview", hostname: "chat.example.com", format: "json" });
    expect(JSON.parse(String(print.mock.calls[0][0]))).toEqual(value);
    await workersCommand(["domains", "attach", "worker-1"], { env: "preview", "challenge-file": await saved(value) });
    expect(calls.map(c => c.url)).toEqual([
      `https://${config.XAPI_API_HOST}/api/v1/workers/worker-1/domains/challenges`,
      `https://${config.XAPI_API_HOST}/api/v1/workers/worker-1/domains`,
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ challengeToken: value.challengeToken });
    expect(JSON.parse(String(print.mock.calls[1][0]))).toEqual({ id: "domain-1", status: "PROVISIONING" });
    expect(JSON.stringify(print.mock.calls[1])).not.toContain("signed-token");
  });
});
