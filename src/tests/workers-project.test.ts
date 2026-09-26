import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  workerManagedResourceSchema,
  workerProjectConfigSchema,
  WORKER_PROJECT_SCHEMA_URL,
  findWorkerProjectConfig,
  loadWorkerProject,
  resolveWorkerProjectPath,
  WorkerProjectConfigError,
} from "../workers-project.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(overrides: Record<string, unknown> = {}) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "xapi-worker-project-")),
  );
  roots.push(root);
  const config = {
    $schema: WORKER_PROJECT_SCHEMA_URL,
    version: 1,
    worker: { name: "My Agent", slug: "my-agent", template: "agent" },
    wrangler: "wrangler.jsonc",
    build: { command: "npm run build", output: "dist/worker.mjs" },
    environments: {
      preview: { dailyBudgetUsd: 0.25, healthCheck: "/health" },
      production: { dailyBudgetUsd: 2, healthCheck: "/health" },
    },
    ...overrides,
  };
  writeFileSync(
    join(root, "xapi.worker.json"),
    JSON.stringify(config, null, 2),
  );
  return root;
}

describe("Worker project configuration", () => {
  test("publishes placement fields in the packaged JSON Schema", () => {
    const schema = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../schemas/worker-project.v1.schema.json"),
        "utf8",
      ),
    );
    expect(schema.$defs.resource.properties.location.enum).toEqual([
      "wnam",
      "enam",
      "weur",
      "eeur",
      "apac",
      "oc",
    ]);
    expect(schema.$defs.resource.properties.readReplication.enum).toEqual([
      "auto",
      "disabled",
    ]);
    expect(schema.$defs.environment.properties.defaultResourceLocation.enum).toContain("apac");
    expect(schema.$defs.environment.properties.placementMode.enum).toEqual(["off", "smart"]);
  });

  test("discovers the project config from a nested directory", () => {
    const root = fixture();
    const nested = join(root, "src", "agent");
    mkdirSync(nested, { recursive: true });
    expect(findWorkerProjectConfig(nested)).toBe(
      join(root, "xapi.worker.json"),
    );
    const project = loadWorkerProject(nested);
    expect(project.config.worker.slug).toBe("my-agent");
    expect(project.config.worker.template).toBe("agent");
  });

  test("uses an explicit config instead of upward discovery", () => {
    const first = fixture({ worker: { name: "First", slug: "first" } });
    const second = fixture({ worker: { name: "Second", slug: "second" } });
    const project = loadWorkerProject(first, join(second, "xapi.worker.json"));
    expect(project.rootDir).toBe(second);
    expect(project.config.worker.slug).toBe("second");
  });

  test("reports invalid fields with their JSON path", () => {
    const root = fixture({
      environments: {
        preview: { dailyBudgetUsd: 0.01, healthCheck: "https://evil.example" },
        production: { dailyBudgetUsd: 2 },
      },
    });
    expect(() => loadWorkerProject(root)).toThrow(
      "environments.preview.dailyBudgetUsd",
    );
    expect(() => loadWorkerProject(root)).toThrow(
      "environments.preview.healthCheck",
    );
  });

  test("rejects unknown schema versions", () => {
    const root = fixture({ version: 2 });
    expect(() => loadWorkerProject(root)).toThrow("version");
  });

  test("rejects paths that can escape the project", () => {
    const root = fixture({
      build: { command: "npm run build", output: "../outside.mjs" },
    });
    expect(() => loadWorkerProject(root)).toThrow("build.output");
  });

  test("accepts Cloudflare-native static asset routing", () => {
    const root = fixture({
      assets: {
        directory: "dist/client",
        binding: "ASSETS",
        htmlHandling: "auto-trailing-slash",
        runWorkerFirst: ["/api/*", "!/api/docs/*"],
      },
    });
    expect(loadWorkerProject(root).config.assets).toEqual({
      directory: "dist/client",
      binding: "ASSETS",
      htmlHandling: "auto-trailing-slash",
      runWorkerFirst: ["/api/*", "!/api/docs/*"],
    });
  });

  test("accepts native environment data location and Smart Placement", () => {
    const root = fixture({
      environments: {
        preview: {
          dailyBudgetUsd: 0.25,
          defaultResourceLocation: "apac",
          placementMode: "smart",
        },
        production: { dailyBudgetUsd: 2, placementMode: "off" },
      },
    });
    expect(loadWorkerProject(root).config.environments.preview).toMatchObject({
      defaultResourceLocation: "apac",
      placementMode: "smart",
    });
  });

  test('requires every Container class to be a Durable Object in both environments', () => {
    const container = {
      name: 'trader', className: 'TraderContainer', image: 'docker.io/example/trader:v1',
    };
    const valid = fixture({
      containers: [container],
      environments: {
        preview: { dailyBudgetUsd: 0.25, resources: [{ type: 'durable_object', bindingName: 'TRADER', className: 'TraderContainer' }] },
        production: { dailyBudgetUsd: 2, resources: [{ type: 'durable_object', bindingName: 'TRADER', className: 'TraderContainer' }] },
      },
    });
    expect(loadWorkerProject(valid).config.containers?.[0].instanceType).toBe('lite');
    const invalid = fixture({ containers: [container] });
    expect(() => loadWorkerProject(invalid)).toThrow('must match exactly one durable_object class in preview');
  });

  test("accepts D1 and R2 placement and rejects it on unrelated resources", () => {
    const validRoot = fixture({
      environments: {
        preview: {
          dailyBudgetUsd: 0.25,
          resources: [
            {
              type: "d1_database",
              bindingName: "DB",
              location: "apac",
              readReplication: "auto",
            },
            { type: "r2_bucket", bindingName: "FILES", location: "apac" },
          ],
        },
        production: { dailyBudgetUsd: 2 },
      },
    });
    expect(
      loadWorkerProject(validRoot).config.environments.preview.resources,
    ).toEqual([
      {
        type: "d1_database",
        bindingName: "DB",
        location: "apac",
        readReplication: "auto",
      },
      { type: "r2_bucket", bindingName: "FILES", location: "apac" },
    ]);

    const invalidRoot = fixture({
      environments: {
        preview: {
          dailyBudgetUsd: 0.25,
          resources: [
            { type: "kv_namespace", bindingName: "CACHE", location: "apac" },
          ],
        },
        production: { dailyBudgetUsd: 2 },
      },
    });
    expect(() => loadWorkerProject(invalidRoot)).toThrow(
      "environments.preview.resources.0.location",
    );
  });

  test("rejects credential fields and credential-shaped values", () => {
    const fieldRoot = fixture({ apiKey: "placeholder" });
    expect(() => loadWorkerProject(fieldRoot)).toThrow(
      "must not contain credentials or Secret values",
    );
    const valueRoot = fixture({ description: `sk-${"a".repeat(40)}` });
    expect(() => loadWorkerProject(valueRoot)).toThrow(
      "must not contain credentials or Secret values",
    );
  });

  test("does not mistake a public xapi-prefixed Worker slug for a credential", () => {
    const root = fixture({
      worker: {
        name: "xAPI existing Vite demo",
        slug: "xapi-existing-vite-demo",
        template: "worker",
      },
    });
    expect(loadWorkerProject(root).config.worker.slug).toBe(
      "xapi-existing-vite-demo",
    );
  });

  test("accepts ordinary xapi-prefixed display names and project paths", () => {
    const root = fixture({
      worker: {
        name: "xapi-resource-debug",
        slug: "xapi-resource-debug",
        template: "worker",
      },
      wrangler: "xapi-worker/wrangler.jsonc",
      build: {
        command: "node xapi-worker/build.mjs",
        output: "xapi-worker/worker.mjs",
      },
      assets: { directory: "xapi-worker/public" },
    });
    expect(loadWorkerProject(root).config.build.output).toBe("xapi-worker/worker.mjs");
    expect(loadWorkerProject(root).config.worker.name).toBe("xapi-resource-debug");
  });

  test("still rejects recognized credentials in public identifiers and paths", () => {
    for (const credential of [
      `sk-${"a".repeat(48)}`,
      `cfat_${"a".repeat(32)}`,
      `xapi_${"a".repeat(32)}`,
    ]) {
      for (const override of [
        { worker: { name: credential, slug: "safe-worker", template: "worker" } },
        { build: { command: "npm run build", output: `dist/${credential}.mjs` } },
      ]) {
        expect(() => loadWorkerProject(fixture(override))).toThrow(
          "must not contain credentials or Secret values",
        );
      }
    }
    expect(() => loadWorkerProject(fixture({
      worker: {
        name: "Public name",
        slug: `sk-${"a".repeat(40)}`,
        template: "worker",
      },
    }))).toThrow("must not contain credentials or Secret values");
  });

  test("allows declared secret names but never credential-shaped values", () => {
    const namesRoot = fixture({
      environments: {
        preview: {
          dailyBudgetUsd: 0.25,
          secrets: ["MODEL_KEY", "WEBHOOK_TOKEN"],
        },
        production: { dailyBudgetUsd: 2, secrets: ["MODEL_KEY"] },
      },
    });
    expect(
      loadWorkerProject(namesRoot).config.environments.preview.secrets,
    ).toEqual(["MODEL_KEY", "WEBHOOK_TOKEN"]);
    const valueRoot = fixture({
      environments: {
        preview: {
          dailyBudgetUsd: 0.25,
          secrets: [`sk-${"a".repeat(40)}`],
        },
        production: { dailyBudgetUsd: 2 },
      },
    });
    expect(() => loadWorkerProject(valueRoot)).toThrow(
      "must not contain credentials or Secret values",
    );
  });

  test("works outside Git and resolves files inside the project", () => {
    const root = fixture();
    const project = loadWorkerProject(root);
    expect(
      resolveWorkerProjectPath(
        project,
        project.config.build.output,
        "build.output",
      ),
    ).toBe(join(root, "dist", "worker.mjs"));
  });

  test("accepts an explicit main module for directory build output", () => {
    const root = fixture({
      build: {
        command: "npm run build",
        output: "dist",
        main: "worker.js",
      },
    });
    expect(loadWorkerProject(root).config.build).toEqual({
      command: "npm run build",
      output: "dist",
      main: "worker.js",
    });
  });

  test("throws a stable error when no project exists", () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "xapi-worker-empty-")),
    );
    roots.push(root);
    try {
      findWorkerProjectConfig(root);
      throw new Error("expected discovery to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerProjectConfigError);
      expect((error as WorkerProjectConfigError).code).toBe(
        "worker_project_config_not_found",
      );
    }
  });
});

// The published schema and runtime admission must describe the same resource names.
test("resource and assets schemas preserve native case while keeping Secret names unchanged", () => {
  const schema = JSON.parse(readFileSync(new URL("../../schemas/worker-project.v1.schema.json", import.meta.url), "utf8"));
  const resourcePattern = new RegExp(schema.$defs.resource.properties.bindingName.pattern);
  const assetsPattern = new RegExp(schema.properties.assets.properties.binding.pattern);
  for (const name of ["Chat", "CHAT", "chat", "constructor", "prototype", "toString", "hasOwnProperty", "Room_2", "a".repeat(64)]) {
    expect(workerManagedResourceSchema.parse({ type: "durable_object", bindingName: name, className: "Chat" }).bindingName).toBe(name);
    expect(workerProjectConfigSchema.shape.assets.parse({ directory: "public", binding: name })?.binding).toBe(name);
    expect(resourcePattern.test(name)).toBe(true);
    expect(assetsPattern.test(name)).toBe(true);
  }
  for (const name of ["", "2Chat", "Chat-room", "Chat room", "../Chat", "Chat/room", "Chat\0", "éChat", "a".repeat(65), "__XAPI_INTERNAL", "$Chat"]) {
    expect(workerManagedResourceSchema.safeParse({ type: "kv_namespace", bindingName: name }).success).toBe(false);
    expect(workerProjectConfigSchema.shape.assets.safeParse({ directory: "public", binding: name }).success).toBe(false);
    expect(resourcePattern.test(name)).toBe(false);
    expect(assetsPattern.test(name)).toBe(false);
  }
  const env = workerProjectConfigSchema.shape.environments.shape.preview;
  expect(env.safeParse({ dailyBudgetUsd: 0.25, secrets: ["ApiKey"] }).success).toBe(false);
  expect(env.parse({ dailyBudgetUsd: 0.25, secrets: ["API_KEY"] }).secrets).toEqual(["API_KEY"]);
  expect(env.safeParse({ dailyBudgetUsd: 0.25, resources: [
    { type: "kv_namespace", bindingName: "Chat" }, { type: "kv_namespace", bindingName: "Chat" },
  ] }).success).toBe(false);
});
