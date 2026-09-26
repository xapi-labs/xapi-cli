import { validNativeCron } from "./workers-cron.ts";
export { validNativeCron } from "./workers-cron.ts";
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
import {
  type LoadedWorkerProject,
  resolveWorkerProjectPath,
} from "./workers-project.ts";
import {
  queueBinding,
  readWranglerEventConfig,
} from "./workers-wrangler-import.ts";
import type { WorkersClientOptions } from "./workers-client.ts";

const consumerSchema = z
  .object({
    queue: z.string().regex(/^[a-zA-Z0-9_-]{1,63}$/),
    max_batch_size: z.number().int().min(1).max(100).optional(),
    max_batch_timeout: z.number().int().min(0).max(60).optional(),
    max_retries: z.number().int().min(0).max(100).optional(),
    retry_delay: z.number().int().min(0).max(43200).optional(),
    max_concurrency: z.number().int().min(1).max(250).optional(),
    dead_letter_queue: z.string().optional(),
  })
  .strict();

export function nativeDeploymentPlan(
  project: LoadedWorkerProject,
  environment: "preview" | "production",
) {
  const source = readWranglerEventConfig(project, environment);
  const migrations: Array<{
    bindingName: string;
    table: string;
    name: string;
    sql: string;
    sha256: string;
  }> = [];
  for (const database of source.databases) {
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
  const consumers = source.consumers.map((raw) => {
    const { dead_letter_queue, ...consumer } = consumerSchema.parse(raw);
    return {
      bindingName: queueBinding(source.config, consumer.queue),
      configuration: {
        ...consumer,
        ...(dead_letter_queue
          ? {
              deadLetterBinding: queueBinding(source.config, dead_letter_queue),
            }
          : {}),
      },
    };
  });
  const crons = [
    ...new Set(z.array(z.string().min(1).max(100)).parse(source.crons ?? [])),
  ];
  for (const cron of crons) {
    if (!validNativeCron(cron))
      throw new Error(
        "The platform scheduled adapter currently supports numeric five-field UTC Cron; Quartz extensions must not be silently converted",
      );
  }
  for (const item of [...migrations, ...consumers]) {
    const expectedType = "sql" in item ? "d1_database" : "queue";
    if (
      !project.config.environments[environment].resources.some(
        (resource) =>
          resource.bindingName === item.bindingName &&
          resource.type === expectedType,
      )
    )
      throw new Error(
        `Missing managed ${expectedType} binding ${item.bindingName}; re-import Wrangler before deploying`,
      );
  }
  return {
    migrations,
    consumers,
    crons,
    cronsConfigured: source.crons !== undefined,
  };
}
export type NativeDeploymentPlan = ReturnType<typeof nativeDeploymentPlan>;
export function publicNativeDeploymentPlan(plan: NativeDeploymentPlan) {
  return {
    ...plan,
    migrations: plan.migrations.map(({ sql: _sql, ...migration }) => migration),
  };
}
export class NativeDeploymentError extends Error {
  constructor(
    message: string,
    public readonly phase: string,
    public readonly completed: unknown[],
  ) {
    super(message);
  }
}

export interface NativeDeploymentClient {
  listWorkerResources(
    options: WorkersClientOptions,
    id: string,
    environment: string,
  ): Promise<unknown>;
  applyWorkerD1Migration?(
    options: WorkersClientOptions,
    id: string,
    environment: string,
    resourceId: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  configureWorkerQueueConsumer?(
    options: WorkersClientOptions,
    id: string,
    environment: string,
    resourceId: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  disableWorkerQueueConsumer?(
    options: WorkersClientOptions,
    id: string,
    environment: string,
    resourceId: string,
  ): Promise<unknown>;
  listWorkerSchedules?(
    options: WorkersClientOptions,
    id: string,
  ): Promise<unknown>;
  createWorkerSchedule?(
    options: WorkersClientOptions,
    id: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  updateWorkerSchedule?(
    options: WorkersClientOptions,
    id: string,
    scheduleId: string,
    input: Record<string, unknown>,
  ): Promise<unknown>;
}
const rows = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  throw new Error("Invalid resource/schedule list response");
};
export async function applyNativeDeploymentPhase(
  api: NativeDeploymentClient,
  options: WorkersClientOptions,
  workerId: string,
  environment: "preview" | "production",
  plan: NativeDeploymentPlan,
  phase: "BEFORE_CODE" | "AFTER_CODE",
) {
  const receipts: unknown[] = [];
  try {
    const resources =
      phase === "AFTER_CODE" || plan.migrations.length
        ? rows(await api.listWorkerResources(options, workerId, environment))
        : [];
    const resourceId = (binding: string, type: string) => {
      const resource = resources.find(
        (resource) =>
          resource.bindingName === binding &&
          String(resource.type).toLowerCase() === type &&
          resource.status === "ACTIVE",
      );
      if (!resource?.id)
        throw new Error(`Active ${type} binding ${binding} is required`);
      return resource.id as string;
    };
    if (phase === "BEFORE_CODE") {
      for (const migration of plan.migrations) {
        if (!api.applyWorkerD1Migration)
          throw new Error("Client does not support remote D1 migrations");
        const result: any = await api.applyWorkerD1Migration(
          options,
          workerId,
          environment,
          resourceId(migration.bindingName, "d1_database"),
          { table: migration.table, name: migration.name, sql: migration.sql },
        );
        if (
          !["APPLIED", "ALREADY_APPLIED"].includes(result?.status) ||
          result.remote !== true
        )
          throw new Error(
            `Remote migration receipt missing: ${migration.name}`,
          );
        receipts.push(result);
      }
      return receipts;
    }
    const desiredBindings = new Set(plan.consumers.map(item => item.bindingName));
    for (const resource of resources) {
      if (
        resource.type !== "QUEUE" || resource.status !== "ACTIVE" ||
        !resource.config?.nativeConsumerHash ||
        desiredBindings.has(resource.bindingName)
      ) continue;
      if (!api.disableWorkerQueueConsumer)
        throw new Error("Client does not support stopping removed Queue consumers");
      const result: any = await api.disableWorkerQueueConsumer(
        options, workerId, environment, resource.id,
      );
      if (!["DISABLED", "UNCHANGED"].includes(result?.status))
        throw new Error(`Queue consumer disable receipt missing: ${resource.bindingName}`);
      receipts.push({ bindingName: resource.bindingName, ...result });
    }
    for (const consumer of plan.consumers) {
      if (!api.configureWorkerQueueConsumer)
        throw new Error("Client does not support Queue event configuration");
      const result: any = await api.configureWorkerQueueConsumer(
        options,
        workerId,
        environment,
        resourceId(consumer.bindingName, "queue"),
        consumer.configuration,
      );
      if (!["CONFIGURED", "UNCHANGED"].includes(result?.status))
        throw new Error(
          `Queue consumer receipt missing: ${consumer.bindingName}`,
        );
      receipts.push({ bindingName: consumer.bindingName, ...result });
    }
    if (plan.crons.length || plan.cronsConfigured) {
      if (
        !api.listWorkerSchedules ||
        !api.createWorkerSchedule ||
        !api.updateWorkerSchedule
      )
        throw new Error("Client does not support scheduled handlers");
      const existing = rows(await api.listWorkerSchedules(options, workerId));
      const names = new Set(
        plan.crons.map(
          (cron) =>
            "Wrangler cron " +
            createHash("sha256").update(cron).digest("hex").slice(0, 16),
        ),
      );
      for (const schedule of existing) {
        if (
          schedule.environment.toLowerCase() === environment &&
          schedule.handler === "scheduled" &&
          /^Wrangler cron [a-f0-9]{16}$/.test(schedule.name) &&
          schedule.enabled &&
          !names.has(schedule.name)
        )
          receipts.push(
            await api.updateWorkerSchedule(options, workerId, schedule.id, {
              enabled: false,
            }),
          );
      }
      for (const cron of plan.crons) {
        const name =
          "Wrangler cron " +
          createHash("sha256").update(cron).digest("hex").slice(0, 16);
        const schedule = existing.find(
          (row) =>
            row.environment.toLowerCase() === environment &&
            row.handler === "scheduled" &&
            row.name === name &&
            row.cron === cron &&
            row.timezone === "UTC",
        );
        receipts.push(
          schedule
            ? schedule.enabled
              ? schedule
              : await api.updateWorkerSchedule(options, workerId, schedule.id, {
                  enabled: true,
                })
            : await api.createWorkerSchedule(options, workerId, {
                name,
                handler: "scheduled",
                environment,
                cron,
                timezone: "UTC",
                path: "/",
                method: "POST",
                enabled: true,
              }),
        );
      }
    }
    return receipts;
  } catch (error) {
    throw new NativeDeploymentError(
      error instanceof Error ? error.message : "Native deployment step failed",
      phase,
      receipts,
    );
  }
}
