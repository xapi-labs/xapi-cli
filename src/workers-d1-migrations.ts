import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { z } from "zod";
import { HttpError, RequestTimeoutError } from "./client.ts";
import {
  type LoadedWorkerProject,
  resolveWorkerProjectPath,
} from "./workers-project.ts";
import { readWranglerEventConfig } from "./workers-wrangler-import.ts";
import type { WorkersClientOptions } from "./workers-client.ts";

/** Parse SQL only for an explicit D1 command, never as part of Worker publication. */
export function planD1Migrations(
  project: LoadedWorkerProject,
  environment: "preview" | "production",
  bindingName: string,
) {
  const source = readWranglerEventConfig(project, environment);
  const databases = source.databases.filter(
    (database) => database.binding === bindingName,
  );
  if (databases.length !== 1)
    throw new Error(
      `Expected one Wrangler D1 binding ${bindingName} in ${environment}`,
    );
  if (
    !project.config.environments[environment].resources.some(
      (resource) =>
        resource.type === "d1_database" && resource.bindingName === bindingName,
    )
  )
    throw new Error(
      `Missing managed D1 binding ${bindingName} in ${environment}; update the project resource configuration`,
    );
  const migrations: Array<{
    bindingName: string;
    table: string;
    name: string;
    sql: string;
    sha256: string;
  }> = [];
  for (const database of databases) {
    if (database.migrations_pattern !== undefined)
      throw new Error(
        "migrations_pattern needs an explicit supported file-discovery mapping; no migration was executed",
      );
    const path = resolve(
      source.directory,
      String(database.migrations_dir ?? "migrations"),
    );
    if (!existsSync(path) && database.migrations_dir === undefined) continue;
    const directory = resolveWorkerProjectPath(
      project,
      relative(project.rootDir, path),
      "D1 migrations",
    );
    const realDirectory = realpathSync(directory);
    resolveWorkerProjectPath(
      project,
      relative(project.rootDir, realDirectory),
      "D1 migrations real path",
    );
    const table = z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)
      .parse(database.migrations_table ?? "d1_migrations");
    if (table.toLowerCase() === "__xapi_migration_hashes")
      throw new Error("Reserved D1 migration table");
    for (const name of readdirSync(directory)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const file = resolveWorkerProjectPath(
        project,
        relative(project.rootDir, resolve(directory, name)),
        "D1 migration file",
      );
      resolveWorkerProjectPath(
        project,
        relative(project.rootDir, realpathSync(file)),
        "D1 migration real path",
      );
      if (!statSync(file).isFile())
        throw new Error(`Migration is not a file: ${name}`);
      const sql = readFileSync(file, "utf8");
      if (!sql.trim()) throw new Error(`Empty D1 migration: ${name}`);
      migrations.push({
        bindingName: String(database.binding),
        table,
        name,
        sql,
        sha256: createHash("sha256").update(sql).digest("hex"),
      });
    }
  }
  return { environment, bindingName, migrations };
}

export type D1MigrationPlan = ReturnType<typeof planD1Migrations>;
export function publicD1MigrationPlan(plan: D1MigrationPlan) {
  return {
    ...plan,
    remoteStatus: "NOT_CHECKED" as const,
    migrations: plan.migrations.map(({ sql: _sql, ...migration }) => migration),
    note: "Local files only; apply checks the remote ledger. Code deployment and rollback do not execute or undo SQL.",
  };
}

export interface D1MigrationClient {
  listWorkerResources(
    options: WorkersClientOptions,
    id: string,
    environment: string,
  ): Promise<unknown>;
  applyWorkerD1Migration(
    options: WorkersClientOptions,
    id: string,
    environment: string,
    resourceId: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}

export class D1MigrationError extends Error {
  constructor(
    message: string,
    public readonly completed: unknown[],
    public readonly failedMigration: string | undefined,
    public readonly cause: unknown,
  ) {
    super(message);
    this.name = "D1MigrationError";
  }
  get details() {
    return {
      completed: this.completed,
      failedMigration: this.failedMigration,
      ...(this.cause instanceof HttpError
        ? { httpStatus: this.cause.status }
        : {}),
      ...(this.cause instanceof RequestTimeoutError
        ? { timeoutMs: this.cause.timeoutMs }
        : {}),
      next: "Inspect the error and remote migration ledger before retrying uncertain SQL. Completed files are not rolled back; Worker deployment remains a separate operation.",
    };
  }
}

export async function applyD1Migrations(
  api: D1MigrationClient,
  options: WorkersClientOptions,
  workerId: string,
  plan: D1MigrationPlan,
) {
  const completed: unknown[] = [];
  let failedMigration: string | undefined;
  try {
    const response: any = await api.listWorkerResources(
      options,
      workerId,
      plan.environment,
    );
    const resources: any[] = Array.isArray(response)
      ? response
      : response?.data;
    if (!Array.isArray(resources))
      throw new Error("Invalid resource list response");
    const matches = resources.filter(
      (resource) =>
        resource.bindingName === plan.bindingName &&
        String(resource.type).toLowerCase() === "d1_database" &&
        resource.status === "ACTIVE",
    );
    if (matches.length !== 1 || !matches[0].id)
      throw new Error(
        `Exactly one ACTIVE D1 binding ${plan.bindingName} is required in ${plan.environment}; inspect workers resources list and reuse the existing resource if present`,
      );
    for (const migration of plan.migrations) {
      failedMigration = migration.name;
      const result: any = await api.applyWorkerD1Migration(
        options,
        workerId,
        plan.environment,
        matches[0].id,
        { table: migration.table, name: migration.name, sql: migration.sql },
      );
      if (
        !["APPLIED", "ALREADY_APPLIED"].includes(result?.status) ||
        result.remote !== true
      )
        throw new Error(`Remote migration receipt missing: ${migration.name}`);
      completed.push(result);
    }
    return {
      workerId,
      environment: plan.environment,
      bindingName: plan.bindingName,
      completed,
    };
  } catch (error) {
    throw new D1MigrationError(
      error instanceof Error ? error.message : "D1 migration failed",
      completed,
      failedMigration,
      error,
    );
  }
}
