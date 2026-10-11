import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  planD1Migrations,
  publicD1MigrationPlan,
  applyD1Migrations,
  D1MigrationError,
} from "../workers-d1-migrations.ts";
import { nativeDeploymentPlan } from "../workers-native-deployment.ts";
import { importWranglerProject } from "../workers-wrangler-import.ts";
import { loadWorkerProject } from "../workers-project.ts";
import { HttpError } from "../client.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(extra: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xapi-d1-explicit-")));
  roots.push(root);
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({
      name: "d1-explicit",
      main: "worker.js",
      d1_databases: [
        { binding: "DB", migrations_dir: "preview-sql", ...extra },
      ],
      env: {
        production: {
          d1_databases: [
            {
              binding: "DB",
              migrations_dir: "production-sql",
              migrations_table: "prod_migrations",
            },
          ],
        },
      },
    }),
  );
  writeFileSync(
    join(root, "worker.js"),
    "export default {fetch(){return new Response('ok')}}",
  );
  const imported = importWranglerProject({
    cwd: root,
    wranglerPath: "wrangler.jsonc",
  });
  expect(imported.wrote).toBe(true);
  return { root, project: loadWorkerProject(root) };
}
function sql(root: string, directory: string, name: string, content: string) {
  mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, directory, name), content);
}

test("deployment planning ignores missing SQL directories and unsupported migration patterns", () => {
  const { project } = fixture({ migrations_pattern: "**/*.sql" });
  expect(nativeDeploymentPlan(project, "preview").d1Migrations).toEqual([
    {
      bindingName: "DB",
      execution: "EXPLICIT_COMMAND",
      command: "xapi workers d1 migrations plan --binding DB --env preview",
    },
  ]);
  expect(() => planD1Migrations(project, "preview", "DB")).toThrow(
    "migrations_pattern",
  );
});

test("explicit plans scope files to binding/environment, freeze SQL hashes, and omit SQL publicly", () => {
  const { root, project } = fixture();
  sql(root, "preview-sql", "0002.sql", "SELECT 2;");
  sql(root, "preview-sql", "0001.sql", "SELECT 1;");
  sql(root, "production-sql", "0003.sql", "SELECT 3;");
  const preview = planD1Migrations(project, "preview", "DB");
  expect(preview.migrations.map((item) => item.name)).toEqual([
    "0001.sql",
    "0002.sql",
  ]);
  expect(preview.migrations[0].sha256).toBe(
    createHash("sha256").update("SELECT 1;").digest("hex"),
  );
  expect(publicD1MigrationPlan(preview).remoteStatus).toBe("NOT_CHECKED");
  expect(publicD1MigrationPlan(preview).migrations[0]).not.toHaveProperty(
    "sql",
  );
  expect(planD1Migrations(project, "production", "DB").migrations).toEqual([
    expect.objectContaining({
      name: "0003.sql",
      table: "prod_migrations",
      sql: "SELECT 3;",
    }),
  ]);
  expect(() => planD1Migrations(project, "preview", "OTHER")).toThrow(
    "Expected one Wrangler D1 binding",
  );
});

test("explicit plan validates SQL paths, but normal deployment does not parse SQL", () => {
  const { root, project } = fixture();
  sql(root, "preview-sql", "0001.sql", "");
  expect(() => nativeDeploymentPlan(project, "preview")).not.toThrow();
  expect(() => planD1Migrations(project, "preview", "DB")).toThrow(
    "Empty D1 migration",
  );
  rmSync(join(root, "preview-sql", "0001.sql"));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "xapi-d1-outside-")));
  roots.push(outside);
  writeFileSync(join(outside, "0001.sql"), "SELECT 1;");
  symlinkSync(join(outside, "0001.sql"), join(root, "preview-sql", "0001.sql"));
  expect(() => planD1Migrations(project, "preview", "DB")).toThrow();
});

test("apply keeps remote receipts and original HTTP status, stops without retrying uncertain SQL", async () => {
  const { root, project } = fixture();
  sql(root, "production-sql", "0001.sql", "SELECT 1;");
  sql(root, "production-sql", "0002.sql", "SELECT 2;");
  const calls: string[] = [];
  const first = { status: "ALREADY_APPLIED", remote: true, sha256: null };
  const failure = new HttpError(409, "d1_migration_result_unconfirmed");
  try {
    await applyD1Migrations(
      {
        async listWorkerResources(_options, worker, env) {
          expect(worker).toBe("worker");
          expect(env).toBe("production");
          return [
            {
              id: "prod-db",
              type: "D1_DATABASE",
              bindingName: "DB",
              status: "ACTIVE",
            },
          ];
        },
        async applyWorkerD1Migration(_options, _worker, env, id, input) {
          expect(env).toBe("production");
          expect(id).toBe("prod-db");
          calls.push(String(input.name));
          if (calls.length === 2) throw failure;
          return first;
        },
      },
      { apiHost: "api.test.xapi.to", apiKey: "test" },
      "worker",
      planD1Migrations(project, "production", "DB"),
    );
    throw new Error("expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(D1MigrationError);
    const migrationError = error as D1MigrationError;
    expect(migrationError.cause).toBe(failure);
    expect(migrationError.details).toMatchObject({
      httpStatus: 409,
      failedMigration: "0002.sql",
      completed: [first],
    });
  }
  expect(calls).toEqual(["0001.sql", "0002.sql"]);
});

test("CLI local plan works without credentials, Worker ID, build, or API access", () => {
  const { root } = fixture();
  sql(root, "preview-sql", "0001.sql", "SELECT 1;");
  const config = readFileSync(join(root, "xapi.worker.json"), "utf8");
  writeFileSync(join(root, "custom.worker.json"), config);
  rmSync(join(root, "xapi.worker.json"));
  const entry = join(import.meta.dir, "..", "index.ts");
  const result = spawnSync(
    process.execPath,
    [
      entry,
      "workers",
      "d1",
      "migrations",
      "plan",
      "--binding",
      "DB",
      "--env",
      "preview",
      "--config",
      "custom.worker.json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        XAPI_KEY: "",
        XAPI_API_KEY: "",
        XAPI_API_HOST: "127.0.0.1:1",
        HOME: root,
      },
    },
  );
  expect(result.status).toBe(0);
  const plan = JSON.parse(result.stdout);
  expect(plan.remoteStatus).toBe("NOT_CHECKED");
  expect(plan.migrations).toHaveLength(1);
  expect(readFileSync(join(root, "custom.worker.json"), "utf8")).not.toContain(
    "workerId",
  );
});

test("apply refuses absent, initializing, or ambiguous bindings without sending SQL", async () => {
  const { root, project } = fixture();
  sql(root, "preview-sql", "0001.sql", "SELECT 1;");
  const plan = planD1Migrations(project, "preview", "DB");
  const resource = {
    id: "db",
    bindingName: "DB",
    type: "D1_DATABASE",
    status: "ACTIVE",
  };
  let writes = 0;
  for (const resources of [
    [],
    [{ ...resource, status: "PROVISIONING" }],
    [resource, { ...resource, id: "other" }],
  ]) {
    await expect(
      applyD1Migrations(
        {
          async listWorkerResources() {
            return resources;
          },
          async applyWorkerD1Migration() {
            writes++;
          },
        },
        { apiHost: "api.test.xapi.to", apiKey: "test" },
        "worker",
        plan,
      ),
    ).rejects.toThrow("Exactly one ACTIVE D1 binding");
  }
  expect(writes).toBe(0);
});

test("apply returns remote receipts in order using the frozen SQL snapshot", async () => {
  const { root, project } = fixture();
  sql(root, "preview-sql", "0001.sql", "SELECT 1;");
  sql(root, "preview-sql", "0002.sql", "SELECT 2;");
  const plan = planD1Migrations(project, "preview", "DB");
  sql(root, "preview-sql", "0001.sql", "SELECT 999;");
  const statements: unknown[] = [];
  const receipts = [
    { status: "ALREADY_APPLIED", remote: true },
    { status: "APPLIED", remote: true },
  ];
  const result = await applyD1Migrations(
    {
      async listWorkerResources() {
        return [
          {
            id: "db",
            bindingName: "DB",
            type: "D1_DATABASE",
            status: "ACTIVE",
          },
        ];
      },
      async applyWorkerD1Migration(_o, _w, _e, _r, input) {
        statements.push(input.sql);
        return receipts[statements.length - 1];
      },
    },
    { apiHost: "api.test.xapi.to", apiKey: "test" },
    "worker",
    plan,
  );
  expect(statements).toEqual(["SELECT 1;", "SELECT 2;"]);
  expect(result.completed).toEqual(receipts);
});
