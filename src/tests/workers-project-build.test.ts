import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWorkerProject } from "../workers-project.ts";
import { loadWorkerProjectBundle, prepareWorkerProjectBundle } from "../workers-project-build.ts";
import { loadWorkerArtifactInput } from "../workers-artifact.ts";
import { initWorkerProject } from "../workers-init.ts";

const roots: string[] = [];
afterEach(() =>
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
const container = {
  name: "api",
  className: "ApiContainer",
  image: "docker.io/example/api:v1",
  instanceType: "lite" as const,
  maxInstances: 2,
  rolloutActiveGracePeriod: 0,
};

function project(native: boolean, withContainer = true) {
  const root = mkdtempSync(join(tmpdir(), "container-project-build-"));
  roots.push(root);
  const output = native ? "worker.bundle" : "worker.mjs";
  const source =
    'export class ApiContainer {}\nexport default { fetch() { return new Response("ok"); } };';
  const settings = {
    main_module: "worker.mjs",
    compatibility_date: "2026-09-10",
    bindings: [
      {
        name: "API_CONTAINER",
        type: "durable_object_namespace",
        class_name: container.className,
      },
    ],
    containers: [
      {
        name: "wrangler-generated-apicontainer",
        class_name: container.className,
      },
    ],
  };
  writeFileSync(
    join(root, output),
    native
      ? `--test-boundary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(settings)}\r\n--test-boundary\r\nContent-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"\r\nContent-Type: application/javascript+module\r\n\r\n${source}\r\n--test-boundary--\r\n`
      : source,
  );
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({ compatibility_date: "2026-09-10" }),
  );
  const environment = {
    dailyBudgetUsd: 0.25,
    resources: [
      {
        type: "durable_object",
        bindingName: "API_CONTAINER",
        className: "ApiContainer",
      },
    ],
  };
  writeFileSync(
    join(root, "xapi.worker.json"),
    JSON.stringify({
      version: 1,
      worker: { name: "Container build", slug: "container-build" },
      wrangler: "wrangler.jsonc",
      build: { command: "unused", output },
      ...(withContainer ? { containers: [container] } : {}),
      environments: { preview: environment, production: environment },
    }),
  );
  return loadWorkerProject(root);
}

for (const native of [false, true]) {
  test(`project build preserves Container intent and artifact identity (${native ? "native bundle" : "module"})`, async () => {
    const config = project(native);
    const actual = await loadWorkerProjectBundle(config, "preview");
    const expected = await loadWorkerArtifactInput(
      join(config.rootDir, config.config.build.output),
      undefined,
      undefined,
      [container],
    );
    expect(actual.upload).toEqual(expected.upload);
    expect(actual.contentSha256).toBe(expected.contentSha256);
    expect(actual.sizeBytes).toBe(expected.sizeBytes);
    if (!("bundle" in actual.upload))
      throw new Error("Container requires bundle");
    expect(actual.upload.bundle.containers).toEqual([container]);
  });
}
test("native Container class without explicit project intent remains rejected", async () => {
  await expect(
    loadWorkerProjectBundle(project(true, false), "preview"),
  ).rejects.toThrow("Container classes differ");
});


test("includes selected public vars in module builds without inheriting root vars into a named environment", async () => {
  const loaded = project(false, false);
  writeFileSync(
    join(loaded.rootDir, "wrangler.jsonc"),
    JSON.stringify({
      compatibility_date: "2026-09-10",
      vars: { ROOT_ONLY: "not-inherited" },
      env: {
        preview: {
          vars: { ORIGIN: "https://preview.example", FLAGS: { uploads: true } },
        },
        production: {},
      },
    }),
  );
  const preview = await loadWorkerProjectBundle(loaded, "preview");
  const production = await loadWorkerProjectBundle(loaded, "production");
  expect("bundle" in preview.upload && preview.upload.bundle.vars).toEqual({
    ORIGIN: "https://preview.example",
    FLAGS: { uploads: true },
  });
  expect(
    "bundle" in production.upload && production.upload.bundle.vars,
  ).toBeFalsy();
  expect(preview.contentSha256).not.toBe(production.contentSha256);
});

test("rejects stale native vars and collisions with declared Secrets before publishing", async () => {
  const native = project(true);
  writeFileSync(
    join(native.rootDir, "wrangler.jsonc"),
    JSON.stringify({
      compatibility_date: "2026-09-10",
      vars: { ORIGIN: "changed" },
    }),
  );
  await expect(loadWorkerProjectBundle(native, "preview")).rejects.toThrow(
    "variables differ",
  );
  const module = project(false, false);
  module.config.environments.preview.secrets = ["PRIVATE_TOKEN"];
  writeFileSync(
    join(module.rootDir, "wrangler.jsonc"),
    JSON.stringify({
      compatibility_date: "2026-09-10",
      vars: { PRIVATE_TOKEN: "public" },
    }),
  );
  await expect(loadWorkerProjectBundle(module, "preview")).rejects.toThrow(
    "Duplicate",
  );
});

test("attaches native configuration to an ordinary module build and detects binding collisions", async () => {
  const config = project(false);
  writeFileSync(
    join(config.rootDir, "wrangler.jsonc"),
    JSON.stringify({
      compatibility_date: "2026-09-10",
      cache: { enabled: false },
      version_metadata: { binding: "VERSION" },
    }),
  );
  const artifact = await loadWorkerProjectBundle(config, "preview");
  expect(artifact.upload).toMatchObject({
    bundle: {
      cacheOptions: { enabled: false },
      versionMetadata: { binding: "VERSION" },
    },
  });
  writeFileSync(
    join(config.rootDir, "wrangler.jsonc"),
    JSON.stringify({
      compatibility_date: "2026-09-10",
      version_metadata: { binding: "API_CONTAINER" },
    }),
  );
  await expect(loadWorkerProjectBundle(config, "preview")).rejects.toThrow(
    "Duplicate",
  );
});

test("inherits the selected Wrangler asset routing while resolving nested config paths", async () => {
  const loaded = project(false, false);
  loaded.config.wrangler = "generated/wrangler.jsonc";
  loaded.config.assets = { directory: "client" };
  mkdirSync(join(loaded.rootDir, "generated"));
  mkdirSync(join(loaded.rootDir, "client"));
  writeFileSync(join(loaded.rootDir, "client/index.html"), "<h1>Application</h1>");
  writeFileSync(join(loaded.rootDir, loaded.config.wrangler), JSON.stringify({
    compatibility_date: "2026-09-10",
    assets: { directory: "../client", binding: "ASSETS", not_found_handling: "404-page" },
    env: { preview: { assets: {
      directory: "../client", binding: "ASSETS", html_handling: "none",
      not_found_handling: "single-page-application", run_worker_first: ["/api", "/api/*"],
    } } },
  }));
  const first = await loadWorkerProjectBundle(loaded, "preview");
  expect(first.upload).toMatchObject({ bundle: { assets: {
    binding: "ASSETS", config: { htmlHandling: "none", notFoundHandling: "single-page-application", runWorkerFirst: ["/api", "/api/*"] },
  } } });
  expect((await loadWorkerProjectBundle(loaded, "production")).upload).toMatchObject({
    bundle: { assets: { config: { notFoundHandling: "404-page" } } },
  });
  // No cached import: changing the native config changes the immutable artifact.
  writeFileSync(join(loaded.rootDir, loaded.config.wrangler), JSON.stringify({
    compatibility_date: "2026-09-10",
    assets: { directory: "../client", binding: "ASSETS", not_found_handling: "none", run_worker_first: false },
  }));
  const changed = await loadWorkerProjectBundle(loaded, "preview");
  expect(changed.upload).toMatchObject({ bundle: { assets: { config: { notFoundHandling: "none", runWorkerFirst: false } } } });
  expect(changed.contentSha256).not.toBe(first.contentSha256);
});

test("uses Wrangler assets when omitted from xAPI and preserves explicit xAPI overrides", async () => {
  const loaded = project(false, false);
  for (const directory of ["native-client", "custom-client"]) {
    mkdirSync(join(loaded.rootDir, directory));
    writeFileSync(join(loaded.rootDir, directory, "index.html"), directory);
  }
  writeFileSync(join(loaded.rootDir, loaded.config.wrangler), JSON.stringify({
    compatibility_date: "2026-09-10",
    assets: { directory: "native-client", binding: "NATIVE_ASSETS", html_handling: "force-trailing-slash",
      not_found_handling: "single-page-application", run_worker_first: true },
  }));
  const inherited = await loadWorkerProjectBundle(loaded, "preview");
  expect(inherited.upload).toMatchObject({ bundle: { assets: { binding: "NATIVE_ASSETS", files: [{ path: "/index.html" }] } } });
  loaded.config.assets = { directory: "custom-client", binding: "CUSTOM_ASSETS", htmlHandling: "none", notFoundHandling: "none", runWorkerFirst: false };
  const custom = await loadWorkerProjectBundle(loaded, "preview");
  expect(custom.upload).toMatchObject({ bundle: { assets: {
    binding: "CUSTOM_ASSETS", config: { htmlHandling: "none", notFoundHandling: "none", runWorkerFirst: false },
    files: [{ content: Buffer.from("custom-client").toString("base64") }],
  } } });
  expect(loaded.config.assets.runWorkerFirst).toBe(false);
  expect(custom.contentSha256).not.toBe(inherited.contentSha256);
  loaded.config.assets = undefined;
  writeFileSync(join(loaded.rootDir, loaded.config.wrangler), JSON.stringify({
    compatibility_date: "2026-09-10", assets: { directory: "native-client", binding: "NATIVE_ASSETS" },
    vars: { NATIVE_ASSETS: "collision" },
  }));
  await expect(loadWorkerProjectBundle(loaded, "preview")).rejects.toThrow("Duplicate Worker binding: NATIVE_ASSETS");
});

test("does not publish a static adapter when its first build produces a real native Worker", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-first-build-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "latest", vite: "latest" } }));
  initWorkerProject({ cwd: root, target: ".", slug: "native-first-build" });
  const loaded = loadWorkerProject(root);
  await expect(prepareWorkerProjectBundle(loaded, "preview", async () => {
    mkdirSync(join(root, "dist/server"), { recursive: true });
    mkdirSync(join(root, ".wrangler/deploy"), { recursive: true });
    writeFileSync(join(root, ".wrangler/deploy/config.json"), JSON.stringify({ configPath: "../../dist/server/wrangler.json" }));
    writeFileSync(join(root, "dist/server/wrangler.json"), JSON.stringify({ main: "index.js", assets: { directory: "../client" } }));
    writeFileSync(join(root, "dist/server/index.js"), 'export default { fetch() { return new Response("SSR page"); } };');
  })).rejects.toMatchObject({
    message: expect.stringContaining("xapi workers init --from-wrangler dist/server/wrangler.json --force"),
    recovery: { remoteChangesApplied: false, generatedWrangler: "dist/server/wrangler.json" },
  });
});

test("a generated assets-only configuration does not reject an ordinary SPA", async () => {
  const root = mkdtempSync(join(tmpdir(), "static-first-build-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "latest", vite: "latest" } }));
  initWorkerProject({ cwd: root, target: ".", slug: "static-first-build" });
  const loaded = loadWorkerProject(root);
  const artifact = await prepareWorkerProjectBundle(loaded, "preview", async () => {
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, ".wrangler/deploy"), { recursive: true });
    writeFileSync(join(root, "dist/index.html"), '<div id="root">SPA</div>');
    writeFileSync(join(root, "dist/wrangler.json"), JSON.stringify({ assets: { directory: "." } }));
    writeFileSync(join(root, ".wrangler/deploy/config.json"), JSON.stringify({ configPath: "../../dist/wrangler.json" }));
  });
  expect(artifact.upload).toMatchObject({ bundle: { assets: { config: { notFoundHandling: "single-page-application" } } } });
});
