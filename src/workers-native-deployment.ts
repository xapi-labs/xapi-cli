import { validNativeCron } from "./workers-cron.ts";
export { validNativeCron } from "./workers-cron.ts";
import { createHash } from "node:crypto";
import type { LoadedWorkerProject } from "./workers-project.ts";
import {
  readWranglerNativeEvents,
  readWranglerEventConfig,
} from "./workers-wrangler-import.ts";
import type { WorkersClientOptions } from "./workers-client.ts";

export function nativeDeploymentPlan(project: LoadedWorkerProject, environment: "preview" | "production") {
  const source = readWranglerEventConfig(project, environment);
  const desired = readWranglerNativeEvents(project, environment);
  return {
    d1Migrations: project.config.environments[environment].resources
      .filter(resource => resource.type === "d1_database")
      .map(resource => ({bindingName: resource.bindingName, execution: "EXPLICIT_COMMAND" as const,
        command: `xapi workers d1 migrations plan --binding ${resource.bindingName} --env ${environment}`})),
    consumers: desired.queueConsumers.map(({bindingName, ...configuration}) => ({bindingName, configuration})),
    crons: desired.crons,
    cronsConfigured: source.crons !== undefined || project.config.environments[environment].crons !== undefined,
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
    // Omitting a Queue consumer declaration does not remove its native consumer.
    // Explicit consumer configure/disable is the user's separate mutation.
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
        const receipt = schedule
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
              });
        if (!receipt || typeof receipt.id !== "string" || !receipt.id.length)
          throw new Error(`Scheduled handler receipt missing: ${cron}`);
        receipts.push(receipt);
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
