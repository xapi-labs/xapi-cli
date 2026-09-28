import { validNativeCron } from "./workers-cron.ts";
export { validNativeCron } from "./workers-cron.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { LoadedWorkerProject } from "./workers-project.ts";
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
  const d1Migrations = project.config.environments[environment].resources
    .filter(resource => resource.type === "d1_database")
    .map(resource => ({
      bindingName: resource.bindingName,
      execution: "EXPLICIT_COMMAND" as const,
      command: `xapi workers d1 migrations plan --binding ${resource.bindingName} --env ${environment}`,
    }));
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
  for (const item of consumers) {
    const expectedType = "queue";
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
    d1Migrations,
    consumers,
    crons,
    cronsConfigured: source.crons !== undefined,
  };
}
export type NativeDeploymentPlan = ReturnType<typeof nativeDeploymentPlan>;
export function publicNativeDeploymentPlan(plan: NativeDeploymentPlan) {
  return plan;
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
  phase: "AFTER_CODE",
) {
  const receipts: unknown[] = [];
  try {
    const resources = rows(await api.listWorkerResources(options, workerId, environment));
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
