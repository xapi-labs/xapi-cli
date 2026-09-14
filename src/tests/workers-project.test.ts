import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
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
