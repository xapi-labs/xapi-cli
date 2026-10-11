import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadWorkerArtifact, loadWorkerArtifactInput, normalizeWorkerObservability, withNativeWorkerOptions } from "../workers-artifact.ts";
import { importWranglerProject } from "../workers-wrangler-import.ts";
import { loadWorkerProject } from "../workers-project.ts";
import { loadWorkerProjectBundle } from "../workers-project-build.ts";

const fixtureRoot = fileURLToPath(new URL("./fixtures/wrangler-native-options/", import.meta.url));
const roots: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "xapi-native-observability-"));
  roots.push(root);
  return root;
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const observation = {
  enabled: true, head_sampling_rate: 0.25,
  logs: { enabled: true, head_sampling_rate: 0, invocation_logs: false, persist: false },
  traces: { enabled: true, head_sampling_rate: 0.1, persist: false },
};

test("accepts real Wrangler WfP multipart without rewriting private source-map bytes", async () => {
  const artifact = await loadWorkerArtifactInput(join(fixtureRoot, "observability-maps/worker.bundle"));
  if (!("bundle" in artifact.upload)) throw new Error("expected bundle");
  expect(artifact.upload.bundle.observability).toEqual(observation);
  expect(artifact.upload.bundle.assets).toBeUndefined();
  const map = artifact.upload.bundle.modules.find(module => module.contentType === "application/source-map")!;
  expect(map.path).toBe("index.js.map");
  const bytes = Buffer.from(map.content, "base64");
  expect(bytes.length).toBe(819);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("ce272e4bc27548a6c05e4bc1fbbd8d7b6b34b94d9f4d899a5d056b6a1b13ef89");
  expect(JSON.parse(bytes.toString()).sources).toEqual(["src/index.ts"]);
  expect(JSON.parse(bytes.toString()).sourceRoot).toBe("");
  // Metadata order may differ, semantics may not. Hash is canonical.
  expect(withNativeWorkerOptions(artifact, { observability: observation }).contentSha256).toBe(artifact.contentSha256);
  expect(() => withNativeWorkerOptions(artifact, { observability: { enabled: false } })).toThrow("rebuild");
  await expect(loadWorkerArtifactInput(join(fixtureRoot, "observability-maps/worker.bundle"), undefined, undefined, undefined, false)).rejects.toThrow("rebuild");
});

test("preserves native zero/false without requiring top-level enabled", async () => {
  const artifact = await loadWorkerArtifactInput(join(fixtureRoot, "logs-only-zero/worker.bundle"));
  expect("bundle" in artifact.upload && artifact.upload.bundle.observability).toEqual({ logs: { enabled: true, head_sampling_rate: 0, invocation_logs: false } });
  const disabled = await loadWorkerArtifactInput(join(fixtureRoot, "disabled/worker.bundle"));
  expect("bundle" in disabled.upload && disabled.upload.bundle.observability).toEqual({ enabled: false });
});

for (const input of [null, [], { enabled: "false" }, { head_sampling_rate: -0.1 }, { head_sampling_rate: 1.1 }, { head_sampling_rate: NaN }, { logs: { persist: 0 } }, { traces: { invocation_logs: false } }]) {
  test(`rejects malformed observability ${JSON.stringify(input)}`, () => {
    expect(() => normalizeWorkerObservability(input)).toThrow();
  });
}
test("does not treat account destinations as transferable tenant configuration", async () => {
  await expect(loadWorkerArtifactInput(join(fixtureRoot, "export-destinations/worker.bundle"))).rejects.toThrow("observability.logs.destinations");
});

test("module and directory builds attach map only on explicit request and keep the JS filename", () => {
  const root = workspace();
  const module = join(root, "custom.mjs");
  const map = '{"version":3,"file":"custom.mjs","sources":["src/main.ts"],"mappings":""}\n';
  writeFileSync(module, "export default { fetch() { return new Response('ok') } };\n");
  writeFileSync(`${module}.map`, map);
  expect(loadWorkerArtifact(module).kind).toBe("module");
  const direct = loadWorkerArtifact(module, undefined, undefined, true);
  const directory = loadWorkerArtifact(root, "custom.mjs", undefined, true);
  expect(direct.contentSha256).toBe(directory.contentSha256);
  if (!("bundle" in direct.upload)) throw new Error("bundle");
  expect(direct.upload.bundle.mainModule).toBe("custom.mjs");
  expect(Buffer.from(direct.upload.bundle.modules[1].content, "base64").toString()).toBe(map);
  const disabled = loadWorkerArtifact(root, "custom.mjs");
  expect("bundle" in disabled.upload && disabled.upload.bundle.modules.length).toBe(1);
});

test("import and project build agree on actual Wrangler telemetry and map settings", async () => {
  const root = workspace();
  cpSync(join(fixtureRoot, "observability-maps"), root, { recursive: true });
  mkdirSync(join(root, "src"));
  cpSync(join(root, "index.ts"), join(root, "src/index.ts"));
  const imported = importWranglerProject({ cwd: root, wranglerPath: "wrangler.jsonc", buildCommand: "unused", buildOutput: "worker.bundle" });
  expect(imported.report.compatible).toBe(true);
  expect(imported.report.entries).toContainEqual(expect.objectContaining({ path: "observability", category: "SUPPORTED" }));
  expect(imported.report.entries).toContainEqual(expect.objectContaining({ path: "upload_source_maps", category: "SUPPORTED" }));
  const loaded = loadWorkerProject(root);
  const artifact = await loadWorkerProjectBundle(loaded, "preview");
  expect("bundle" in artifact.upload && artifact.upload.bundle.observability).toEqual(observation);
  const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  config.observability.logs.persist = true;
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(config));
  await expect(loadWorkerProjectBundle(loaded, "preview")).rejects.toThrow("rebuild");
});

test("unsupported telemetry fails import with its precise configuration path", () => {
  const root = workspace();
  cpSync(join(fixtureRoot, "export-destinations"), root, { recursive: true });
  const imported = importWranglerProject({ cwd: root, wranglerPath: "wrangler.jsonc", buildCommand: "unused", buildOutput: "worker.bundle" });
  expect(imported.wrote).toBe(false);
  expect(imported.report.entries.some(entry => entry.category === "UNSUPPORTED" && entry.message.includes("observability.logs.destinations"))).toBe(true);
});

test("CLI canonical artifact matches the shared backend regression fixture", async () => {
  const expected = JSON.parse(readFileSync(join(fixtureRoot, "observability-maps/xapi-artifact.json"), "utf8"));
  const actual = await loadWorkerArtifactInput(join(fixtureRoot, "observability-maps/worker.bundle"));
  expect({ contentSha256: actual.contentSha256, sizeBytes: actual.sizeBytes, ...actual.upload }).toEqual(expected);
});

test("ordinary builds apply selected-environment observability and source-map intent", async () => {
  const root = workspace();
  cpSync(join(fixtureRoot, "observability-maps"), root, { recursive: true });
  writeFileSync(join(root, "custom.mjs"), "export default {};");
  writeFileSync(join(root, "custom.mjs.map"), '{"version":3,"sources":[],"mappings":""}');
  const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  config.env = { preview: { observability: { enabled: false }, upload_source_maps: false }, production: {} };
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(config));
  importWranglerProject({ cwd: root, wranglerPath: "wrangler.jsonc", buildCommand: "unused", buildOutput: "custom.mjs" });
  const project = loadWorkerProject(root);
  const preview = await loadWorkerProjectBundle(project, "preview");
  const production = await loadWorkerProjectBundle(project, "production");
  if (!("bundle" in preview.upload) || !("bundle" in production.upload)) throw new Error("bundles");
  expect(preview.upload.bundle.observability).toEqual({ enabled: false });
  expect(preview.upload.bundle.modules.length).toBe(1);
  expect(production.upload.bundle.observability).toEqual(observation);
  expect(production.upload.bundle.modules.length).toBe(2);
  expect(preview.contentSha256).not.toBe(production.contentSha256);
});

test("Wrangler preflight rejects a missing telemetry switch while preserving explicit false", async () => {
  const root = workspace();
  cpSync(join(fixtureRoot, "defaults"), root, { recursive: true });
  writeFileSync(join(root, "custom.mjs"), "export default {};");
  const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  config.observability = { head_sampling_rate: 0.25 };
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(config));
  const invalid = importWranglerProject({ cwd: root, wranglerPath: "wrangler.jsonc", buildCommand: "unused", buildOutput: "custom.mjs" });
  expect(invalid.report.compatible).toBe(false);
  expect(invalid.wrote).toBe(false);
  config.observability.logs = { enabled: false };
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(config));
  expect(importWranglerProject({ cwd: root, wranglerPath: "wrangler.jsonc", buildCommand: "unused", buildOutput: "custom.mjs" }).wrote).toBe(true);
  const project = loadWorkerProject(root);
  await expect(loadWorkerProjectBundle(project, "preview")).resolves.toBeDefined();
  delete config.observability.logs;
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(config));
  await expect(loadWorkerProjectBundle(project, "preview")).rejects.toThrow("requires enabled");
});
