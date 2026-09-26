import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadWorkerArtifactInput,
  normalizeWorkerVariableOptions,
  withNativeWorkerOptions,
  withWorkerVars,
} from "../workers-artifact.ts";
import { uploadWorkerArtifact } from "../workers-client.ts";
import { loadWorkerProjectBundle } from "../workers-project-build.ts";
import { loadWorkerProject } from "../workers-project.ts";
import { importWranglerProject, readWranglerDeploymentSettings } from "../workers-wrangler-import.ts";

const fixtures = fileURLToPath(new URL("./fixtures/wrangler-native-options/", import.meta.url));
const roots: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "xapi-variable-options-"));
  roots.push(root);
  return root;
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

async function native(options: Record<string, unknown> = {}) {
  const root = workspace();
  const metadata = { main_module: "index.js", bindings: [], ...options };
  const path = join(root, "worker.bundle");
  writeFileSync(path, [
    '--variable-test\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n',
    JSON.stringify(metadata),
    '\r\n--variable-test\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\nContent-Type: application/javascript+module\r\n\r\n',
    'export default {};\r\n--variable-test--\r\n',
  ].join(""));
  return loadWorkerArtifactInput(path);
}

test("canonical variable options omit defaults and retain only JSON-string exceptions", () => {
  expect(normalizeWorkerVariableOptions({})).toEqual({});
  expect(normalizeWorkerVariableOptions({ vars: {}, varTypes: {}, keepBindings: [] })).toEqual({});
  const normalized = normalizeWorkerVariableOptions({
    vars: { Z: "json-string", TEXT: "plain", OBJECT: { a: 1 }, NULL: null, NUMBER: 42, ARRAY: [], BOOL: false, A: "" },
    varTypes: { Z: "json", TEXT: "plain_text", OBJECT: "json", NULL: "json", NUMBER: "json", ARRAY: "json", BOOL: "json", A: "json" },
    keepBindings: ["json", "plain_text", "json"],
  });
  expect(normalized.keepBindings).toEqual(["plain_text", "json"]);
  expect(normalized.varTypes).toEqual({ A: "json", Z: "json" });
  expect(Object.keys(normalized.vars!)).toEqual(["A", "ARRAY", "BOOL", "NULL", "NUMBER", "OBJECT", "TEXT", "Z"]);
  expect(normalizeWorkerVariableOptions(normalized)).toEqual(normalized);
});

for (const input of [
  { keepBindings: true }, { keepBindings: null }, { keepBindings: "all" },
  { keepBindings: ["*"] }, { keepBindings: ["secret_text"] }, { keepBindings: ["kv_namespace"] },
  { varTypes: null }, { varTypes: [] }, { varTypes: "json" },
  { vars: { A: "value" }, varTypes: { MISSING: "json" } },
  { vars: {}, varTypes: { toString: "json" } },
  { vars: { A: 1 }, varTypes: { A: "plain_text" } },
  { vars: { A: null }, varTypes: { A: "plain_text" } },
  { vars: { A: "value" }, varTypes: { A: "secret_text" } },
  { vars: { A: undefined } }, { vars: { A: NaN } },
]) {
  test(`rejects invalid public variable options ${JSON.stringify(input)}`, () => {
    expect(() => normalizeWorkerVariableOptions(input)).toThrow();
  });
}

test("native retention ignores independent secrets, deduplicates public types, and preserves old hashes", async () => {
  const baseline = await native();
  for (const keep_bindings of [[], ["secret_text"], ["secret_key", "secret_text", "secret_key"]]) {
    const artifact = await native({ keep_bindings });
    expect(artifact.upload).toEqual(baseline.upload);
    expect(artifact.contentSha256).toBe(baseline.contentSha256);
    expect(artifact.sizeBytes).toBe(baseline.sizeBytes);
    expect(withNativeWorkerOptions(artifact, { keepBindings: [] })).toBe(artifact);
  }
  const artifact = await native({ keep_bindings: ["json", "secret_key", "plain_text", "json", "secret_text"] });
  expect(artifact.upload).toMatchObject({ bundle: { keepBindings: ["plain_text", "json"] } });
  expect(artifact.contentSha256).not.toBe(baseline.contentSha256);
  expect(withNativeWorkerOptions(artifact, { keepBindings: ["json", "plain_text", "json"] })).toBe(artifact);
  expect(() => withNativeWorkerOptions(artifact, {})).toThrow("rebuild");
  expect(() => withNativeWorkerOptions(baseline, { keepBindings: ["json"] })).toThrow("rebuild");
});

for (const keep_bindings of [null, true, "all", ["all"], ["*"], ["kv_namespace"], ["d1"], ["r2_bucket"], ["inherit"], ["secret_text", "queue"], [{}]]) {
  test(`rejects native retention without explicit target mapping ${JSON.stringify(keep_bindings)}`, async () => {
    await expect(native({ keep_bindings })).rejects.toThrow("explicit target mapping");
  });
}

test("native JSON strings retain binding type across value validation and canonical hashing", async () => {
  const artifact = await native({
    cache_options: { enabled: false },
    keep_bindings: ["json", "plain_text"],
    observability: { enabled: false },
    bindings: [
      { name: "VERSION", type: "version_metadata" },
      { name: "TEXT", type: "plain_text", text: "hello" },
      { name: "JSON_STRING", type: "json", json: "hello" },
      { name: "JSON_OBJECT", type: "json", json: { a: true } },
    ],
  });
  if (!("bundle" in artifact.upload)) throw new Error("expected bundle");
  const bundle = artifact.upload.bundle;
  expect(bundle.varTypes).toEqual({ JSON_STRING: "json" });
  expect(withWorkerVars(artifact, { TEXT: "hello", JSON_OBJECT: { a: true }, JSON_STRING: "hello" })).toBe(artifact);
  expect(() => withWorkerVars(artifact, { ...bundle.vars, JSON_STRING: "changed" })).toThrow("vars differ");
  expect(() => withWorkerVars(artifact, { ...bundle.vars, TEXT: undefined })).toThrow("JSON values");
  const bytes = Buffer.from(JSON.stringify({
    cacheOptions: { enabled: false },
    versionMetadata: { binding: "VERSION" },
    keepBindings: ["plain_text", "json"],
    varTypes: { JSON_STRING: "json" },
    observability: { enabled: false },
    vars: { JSON_OBJECT: { a: true }, JSON_STRING: "hello", TEXT: "hello" },
    version: 1,
    mainModule: "index.js",
    modules: [{ path: "index.js", contentBase64: Buffer.from("export default {};").toString("base64"), contentType: "application/javascript+module" }],
  }));
  expect(artifact.contentSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(artifact.sizeBytes).toBe(bytes.length);
  const plain = await native({ bindings: [{ name: "A", type: "plain_text", text: "hello" }] });
  const json = await native({ bindings: [{ name: "A", type: "json", json: "hello" }] });
  expect(json.contentSha256).not.toBe(plain.contentSha256);
});

test("full-options Wrangler capture imports and builds without changing maps or observability", async () => {
  const root = workspace();
  cpSync(join(fixtures, "full-options"), root, { recursive: true });
  const result = importWranglerProject({ cwd: root, wranglerPath: "wrangler.jsonc", buildCommand: "unused", buildOutput: "worker.bundle" });
  expect(result.wrote).toBe(true);
  expect(result.report.compatible).toBe(true);
  expect(result.report.entries).toContainEqual(expect.objectContaining({ path: "keep_vars", category: "SUPPORTED" }));
  const project = loadWorkerProject(root);
  const artifact = await loadWorkerProjectBundle(project, "preview");
  const baseline = await loadWorkerArtifactInput(join(fixtures, "observability-maps/worker.bundle"));
  if (!("bundle" in artifact.upload) || !("bundle" in baseline.upload)) throw new Error("expected bundles");
  expect(artifact.upload.bundle).toEqual({ ...baseline.upload.bundle, keepBindings: ["plain_text", "json"] });
  expect(artifact.upload.bundle.modules).toEqual(baseline.upload.bundle.modules);
  expect(artifact.contentSha256).not.toBe(baseline.contentSha256);
  const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  config.keep_vars = false;
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify(config));
  await expect(loadWorkerProjectBundle(project, "preview")).rejects.toThrow("variable retention");
});

for (const keep_vars of [true, false, undefined]) {
  test(`only root keep_vars controls import and ordinary builds (${keep_vars})`, async () => {
    const root = workspace();
    writeFileSync(join(root, "index.mjs"), "export default {};");
    writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({
      name: "variable-test", main: "index.mjs", keep_vars,
      vars: { ROOT: "not-inherited" },
      env: {
        preview: { keep_vars: !keep_vars, vars: { PUBLIC: "preview" } },
        production: { keep_vars: "ignored-invalid-value" },
      },
    }));
    const result = importWranglerProject({ cwd: root, wranglerPath: "wrangler.jsonc", buildCommand: "unused", buildOutput: "index.mjs" });
    expect(result.wrote).toBe(true);
    for (const environment of ["preview", "production"] as const) {
      expect(result.report.entries).toContainEqual(expect.objectContaining({
        path: `env.${environment}.keep_vars`, category: "IGNORED", message: expect.stringContaining("only top-level keep_vars"),
      }));
      const project = loadWorkerProject(root);
      const settings = readWranglerDeploymentSettings(project, environment);
      expect(settings.keepBindings).toEqual(keep_vars ? ["plain_text", "json"] : undefined);
      expect(Object.hasOwn(settings, "keepBindings")).toBe(keep_vars === true);
      const artifact = await loadWorkerProjectBundle(project, environment);
      expect("bundle" in artifact.upload ? artifact.upload.bundle.keepBindings : undefined).toEqual(settings.keepBindings);
      expect("bundle" in artifact.upload ? artifact.upload.bundle.vars : undefined).toEqual(environment === "preview" ? { PUBLIC: "preview" } : undefined);
    }
  });
}

test("invalid root keep_vars blocks import before writing even when env supplies a boolean", () => {
  const root = workspace();
  writeFileSync(join(root, "wrangler.jsonc"), JSON.stringify({ name: "invalid", main: "index.js", keep_vars: "all", env: { preview: { keep_vars: true } } }));
  const result = importWranglerProject({ cwd: root, wranglerPath: "wrangler.jsonc" });
  expect(result.wrote).toBe(false);
  expect(existsSync(join(root, "xapi.worker.json"))).toBe(false);
  expect(result.report.entries.some(entry => entry.category === "UNSUPPORTED" && entry.message.includes("Top-level keep_vars must be a boolean"))).toBe(true);
});

test("upload manifest carries canonical retention and JSON-string types without private retention", async () => {
  const artifact = await native({ keep_bindings: ["secret_text", "json", "plain_text"], bindings: [
    { name: "STRING", type: "json", json: "hello" },
    { name: "TEXT", type: "plain_text", text: "hi" },
  ] });
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  try {
    await uploadWorkerArtifact({ apiHost: "test.xapi.to", apiKey: "test-only" }, "worker/id", { ...artifact.upload, idempotencyKey: "variable-options" });
    const [target, init] = fetchSpy.mock.calls[0];
    expect(target).toBe("https://test.xapi.to/api/v1/workers/worker%2Fid/artifacts/bundle");
    const form = init!.body as FormData;
    const manifest = JSON.parse(String(form.get("manifest")));
    expect(manifest).toMatchObject({ keepBindings: ["plain_text", "json"], varTypes: { STRING: "json" }, vars: { STRING: "hello", TEXT: "hi" } });
    expect(JSON.stringify(manifest)).not.toContain("secret_text");
    expect(form.getAll("files")).toHaveLength(1);
    expect(await (form.get("files") as Blob).text()).toBe("export default {};");
  } finally {
    fetchSpy.mockRestore();
  }
});
