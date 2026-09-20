import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importWranglerProject } from "../workers-wrangler-import.ts";
import { loadWorkerProject } from "../workers-project.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xapi-wrangler-")));
  roots.push(root);
  return root;
}

describe("Wrangler project import", () => {
  test('imports a prebuilt native Container application and its Durable Object link', () => {
    const root = workspace();
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({
      name: 'container-worker',
      main: 'src/index.ts',
      compatibility_date: '2026-09-21',
      durable_objects: {
        bindings: [{ name: 'TRADER', class_name: 'TraderContainer' }],
      },
      containers: [{
        name: 'trader',
        class_name: 'TraderContainer',
        image: 'docker.io/example/trader:v1',
        instance_type: 'lite',
        max_instances: 3,
        constraints: { regions: ['APAC'] },
      }],
    }, null, 2));
    const result = importWranglerProject({ cwd: root, wranglerPath: 'wrangler.jsonc' });
    expect(result.wrote).toBe(true);
    expect(result.report.entries).toContainEqual(expect.objectContaining({
      category: 'MANAGED', path: 'containers[0]',
    }));
    expect(loadWorkerProject(root).config.containers).toEqual([expect.objectContaining({
      name: 'trader', className: 'TraderContainer', instanceType: 'lite', maxInstances: 3,
    })]);
  });

  test('does not silently import a local Dockerfile as a remotely deployable image', () => {
    const root = workspace();
    writeFileSync(join(root, 'wrangler.jsonc'), JSON.stringify({
      name: 'container-worker', main: 'src/index.ts',
      durable_objects: { bindings: [{ name: 'APP', class_name: 'AppContainer' }] },
      containers: [{ name: 'app', class_name: 'AppContainer', image: './Dockerfile' }],
    }));
    const result = importWranglerProject({ cwd: root, wranglerPath: 'wrangler.jsonc' });
    expect(result.wrote).toBe(false);
    expect(result.report.entries).toContainEqual(expect.objectContaining({
      category: 'UNSUPPORTED', path: 'containers[0]',
    }));
  });

  test("reports every JSONC compatibility decision and blocks unsupported input", () => {
    const root = workspace();
    const path = join(root, "wrangler.jsonc");
    const original = `{
      // Existing provider-owned deployment settings must not be copied.
      "name": "existing-worker",
      "main": "src/index.ts",
      "compatibility_date": "2026-08-26",
      "compatibility_flags": ["nodejs_compat"],
      "assets": {
        "directory": "dist/client",
        "binding": "ASSETS",
        "html_handling": "auto-trailing-slash",
        "not_found_handling": "single-page-application",
        "run_worker_first": ["/api/*"]
      },
      "account_id": "provider-account-id",
      "routes": ["old.example/*"],
      "kv_namespaces": [{ "binding": "STATE", "id": "physical-kv-id" }],
      "d1_databases": [{ "binding": "DB", "database_id": "physical-d1-id" }],
      "r2_buckets": [{ "binding": "FILES", "bucket_name": "physical-r2" }],
      "durable_objects": {
        "bindings": [{ "name": "AGENT", "class_name": "AgentState", "script_name": "old-script" }]
      },
      "queues": {
        "producers": [{ "binding": "EVENTS", "queue": "physical-queue" }]
      },
      "workflows": [{ "binding": "FLOW", "name": "physical-workflow", "class_name": "OldFlow" }],
      "vars": { "MODEL_KEY": "must-not-be-copied" },
      "hyperdrive": [{ "binding": "CACHE", "id": "physical-hyperdrive" }],
    }`;
    writeFileSync(path, original);

    const blocked = importWranglerProject({
      cwd: root,
      wranglerPath: "wrangler.jsonc",
    });
    expect(blocked.wrote).toBe(false);
    expect(existsSync(join(root, "xapi.worker.json"))).toBe(false);
    expect(blocked.report.compatible).toBe(false);
    expect(blocked.report.entries).toContainEqual(
      expect.objectContaining({ category: "UNSUPPORTED", path: "hyperdrive" }),
    );
    expect(blocked.report.entries).toContainEqual(
      expect.objectContaining({ category: "IGNORED", path: "account_id" }),
    );
    expect(blocked.report.entries).toContainEqual(
      expect.objectContaining({
        category: "REENTER",
        bindingName: "MODEL_KEY",
      }),
    );
    expect(blocked.report.summary.MANAGED).toBe(12);
    expect(JSON.stringify(blocked.report)).not.toContain("physical-");
    expect(JSON.stringify(blocked.report)).not.toContain("must-not-be-copied");
    expect(readFileSync(path, "utf8")).toBe(original);

    const accepted = importWranglerProject({
      cwd: root,
      wranglerPath: "wrangler.jsonc",
      acceptPartial: true,
    });
    expect(accepted.wrote).toBe(true);
    const project = loadWorkerProject(root);
    expect(
      project.config.environments.preview.resources.map(
        (resource) => resource.bindingName,
      ),
    ).toEqual(["AGENT", "DB", "EVENTS", "FILES", "FLOW", "STATE"]);
    expect(project.config.environments.preview.secrets).toEqual(["MODEL_KEY"]);
    expect(project.config.assets).toEqual({
      directory: "dist/client",
      binding: "ASSETS",
      htmlHandling: "auto-trailing-slash",
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    });
    const generated = readFileSync(join(root, "xapi.worker.json"), "utf8");
    expect(generated).not.toContain("provider-account-id");
    expect(generated).not.toContain("physical-");
    expect(generated).not.toContain("must-not-be-copied");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("imports TOML base and environment bindings without copying physical IDs", () => {
    const root = workspace();
    const path = join(root, "wrangler.toml");
    const original = `name = "toml-agent"
main = "src/index.ts"
compatibility_date = "2026-08-26"
compatibility_flags = ["nodejs_compat"]
workers_dev = true

[[kv_namespaces]]
binding = "STATE"
id = "old-kv-id"

[env.preview.vars]
MODEL_KEY = "never-copy-this"

[[env.production.d1_databases]]
binding = "DB"
database_id = "old-d1-id"
`;
    writeFileSync(path, original);
    const result = importWranglerProject({
      cwd: root,
      wranglerPath: "wrangler.toml",
    });
    expect(result.wrote).toBe(true);
    expect(result.report.format).toBe("toml");
    const project = loadWorkerProject(root);
    expect(project.config.wrangler).toBe("wrangler.toml");
    expect(project.config.environments.preview.resources).toEqual([
      { type: "kv_namespace", bindingName: "STATE" },
    ]);
    expect(project.config.environments.preview.secrets).toEqual(["MODEL_KEY"]);
    expect(
      project.config.environments.production.resources.map(
        (resource) => resource.bindingName,
      ),
    ).toEqual(["DB", "STATE"]);
    const generated = readFileSync(join(root, "xapi.worker.json"), "utf8");
    expect(generated).not.toContain("old-kv-id");
    expect(generated).not.toContain("old-d1-id");
    expect(generated).not.toContain("never-copy-this");
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("requires force to replace only an existing xAPI project config", () => {
    const root = workspace();
    const path = join(root, "wrangler.jsonc");
    writeFileSync(path, '{ "name": "safe", "main": "src/index.ts" }');
    importWranglerProject({ cwd: root, wranglerPath: path });
    expect(() =>
      importWranglerProject({ cwd: root, wranglerPath: path }),
    ).toThrow("already exists");
    expect(
      importWranglerProject({ cwd: root, wranglerPath: path, force: true })
        .wrote,
    ).toBe(true);
  });

  test("reports unsupported environment fields and malformed input", () => {
    const root = workspace();
    const path = join(root, "wrangler.jsonc");
    writeFileSync(
      path,
      `{
        "name": "safe",
        "main": "src/index.ts",
        "env": { "preview": { "hyperdrive": [{ "binding": "CACHE" }] } }
      }`,
    );
    const report = importWranglerProject({ cwd: root, wranglerPath: path });
    expect(report.wrote).toBe(false);
    expect(report.report.entries).toContainEqual(
      expect.objectContaining({
        category: "UNSUPPORTED",
        path: "env.preview.hyperdrive",
      }),
    );
    writeFileSync(path, "{ invalid jsonc");
    expect(() =>
      importWranglerProject({ cwd: root, wranglerPath: path }),
    ).toThrow("Invalid Wrangler JSONC");
  });

  test("imports a generated framework Wrangler config from a nested build directory", () => {
    const root = workspace();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "framework-app", scripts: { build: "vinext build" } }),
    );
    const serverDir = join(root, "dist", "server");
    const clientDir = join(root, "dist", "client");
    mkdirSync(serverDir, { recursive: true });
    mkdirSync(clientDir, { recursive: true });
    const path = join(serverDir, "wrangler.json");
    writeFileSync(
      path,
      JSON.stringify({
        topLevelName: "framework-app",
        name: "framework-app",
        main: "index.js",
        compatibility_date: "2026-09-10",
        compatibility_flags: ["nodejs_compat"],
        assets: { directory: "../client" },
        durable_objects: { bindings: [] },
        queues: { producers: [], consumers: [] },
        workflows: [],
        services: [],
        exports: {},
        migrations: [],
        jsx_factory: "React.createElement",
        jsx_fragment: "React.Fragment",
        python_modules: { exclude: ["**/*.pyc"] },
      }),
    );

    const result = importWranglerProject({
      cwd: root,
      wranglerPath: "dist/server/wrangler.json",
    });

    expect(result.wrote).toBe(true);
    expect(result.rootDir).toBe(root);
    expect(result.report.summary.UNSUPPORTED).toBe(0);
    const project = loadWorkerProject(root);
    expect(project.config.wrangler).toBe("dist/server/wrangler.json");
    expect(project.config.assets).toEqual({ directory: "dist/client" });
    expect(existsSync(join(serverDir, "xapi.worker.json"))).toBe(false);
  });
});
