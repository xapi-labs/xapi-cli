import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("the actual create --config CLI links required Secrets without build or resource writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-first-project-"));
  const id = "22222222-2222-4222-8222-222222222222";
  const requests: string[] = [];
  let input: any;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (request.method === "POST" && path === "/api/v1/workers") {
      input = await request.json();
      return Response.json({ id, ...input });
    }
    if (request.method === "GET" && path === `/api/v1/workers/${id}`) return Response.json({ id, ...input });
    return Response.json({ error: "Unexpected endpoint" }, { status: 404 });
  } });
  try {
    const config = join(root, "xapi.worker.json");
    writeFileSync(config, JSON.stringify({ version: 1, worker: { name: "Pi Agent", slug: "pi-test", template: "worker" },
      wrangler: "wrangler.jsonc", build: { command: "must-not-run", output: "dist/worker.mjs" },
      environments: { preview: { dailyBudgetUsd: null, defaultResourceLocation: "apac", secrets: ["SIGNING_KEY"] }, production: { dailyBudgetUsd: 0 } } }));
    const run = async () => {
      const child = Bun.spawn([process.execPath, fileURLToPath(new URL("../index.ts", import.meta.url)), "workers", "create", "--config", config, "--format", "json"], {
        cwd: root, env: { ...process.env, XAPI_KEY: "test-key", XAPI_API_HOST: `127.0.0.1:${server.port}` }, stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      return JSON.parse(stdout);
    };
    const first = await run();
    expect(first.id).toBe(id);
    expect(first.project).toMatchObject({ linked: true, created: true });
    expect(JSON.parse(readFileSync(config, "utf8")).workerId).toBe(id);
    expect(input).toMatchObject({ name: "Pi Agent", slug: "pi-test", previewDailyBudgetUsd: null, productionDailyBudgetUsd: 0, defaultResourceLocation: "apac" });
    const second = await run();
    expect(second.project).toMatchObject({ linked: true, created: false });
    expect(requests).toEqual(["POST /api/v1/workers", `GET /api/v1/workers/${id}`]);
    // Config-only creation must stay independent of Secret values and build
    // output, even when the environment declarations differ.
    for (const [preview, production] of [
      [[], ["PRODUCTION_KEY"]],
      [["PREVIEW_KEY"], ["PRODUCTION_KEY"]],
      [["SHARED_NAME"], ["SHARED_NAME"]],
      [[], []],
    ]) {
      const declared = JSON.parse(readFileSync(config, "utf8"));
      declared.environments.preview.secrets = preview;
      declared.environments.production.secrets = production;
      writeFileSync(config, JSON.stringify(declared));
      const linked = await run();
      expect(linked.project.created).toBe(false);
      expect(linked.next).toContain("If an environment requires Secrets");
      expect(linked.next).toContain(`Preview: xapi workers secrets apply ${id} --env preview --env-file .env.preview`);
      expect(linked.next).toContain(`Production: xapi workers secrets apply ${id} --env production --env-file .env.production`);
    }
    expect(requests.slice(2)).toEqual(Array(4).fill(`GET /api/v1/workers/${id}`));
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
