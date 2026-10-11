import { createHash } from "node:crypto";
import { nativeDeploymentPlan, applyNativeDeploymentPhase, type NativeDeploymentClient } from "./workers-native-deployment.ts";
import type { WorkersClientOptions } from './workers-client.ts';
import type { LoadedWorkerProject } from './workers-project.ts';
import { WorkerProjectConfigError } from './workers-project.ts';
import { readWranglerNativeEvents } from './workers-wrangler-import.ts';

type Row = Record<string, unknown>;
export interface NativeEventClient {
  listWorkerResources(options: WorkersClientOptions, workerId: string, environment: string): Promise<unknown>;
  configureWorkerQueueConsumer?(options: WorkersClientOptions, workerId: string, environment: string, resourceId: string, input: Row): Promise<unknown>;
  listWorkerSchedules?(options: WorkersClientOptions, workerId: string): Promise<unknown>;
  createWorkerSchedule?(options: WorkersClientOptions, workerId: string, input: Row): Promise<unknown>;
}
export type NativeEventChange = {
  operation: 'CREATE' | 'UPDATE' | 'NO_CHANGE' | 'MANUAL';
  key: string;
  message: string;
  desired?: Row;
  current?: Row;
};
function rows(value: unknown): Row[] {
  const values = Array.isArray(value) ? value : (value as Row | null)?.items;
  if (!Array.isArray(values) || values.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new WorkerProjectConfigError('worker_event_invalid_response', 'Native event state must be a list');
  }
  return values;
}
function object(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
}
function consumerBody(consumer: ReturnType<typeof readWranglerNativeEvents>['queueConsumers'][number]): Row {
  const { bindingName, ...input } = consumer;
  return input;
}

export async function planWorkerNativeEvents(
  project: LoadedWorkerProject,
  environment: 'preview' | 'production',
  resources: Row[],
  client: NativeEventClient,
  options: WorkersClientOptions,
): Promise<NativeEventChange[]> {
  const desired = readWranglerNativeEvents(project, environment);
  const intent = nativeDeploymentPlan(project, environment);
  const changes: NativeEventChange[] = [];
  for (const consumer of desired.queueConsumers) {
    const resource = resources.find(row => row.type === 'QUEUE' && row.bindingName === consumer.bindingName);
    const current = object(object(resource?.config).nativeConsumer);
    const input = consumerBody(consumer);
    // Worker is the native default when type is omitted. Other removed
    // parameters still restore the provider default and remain real changes.
    const same = [...new Set([...Object.keys(input), ...Object.keys(current)])]
      .every(key => key === 'type'
        ? (input[key] ?? 'worker') === (current[key] ?? 'worker')
        : input[key] === current[key]);
    changes.push({
      operation: same ? 'NO_CHANGE' : resource ? 'UPDATE' : 'CREATE',
      key: `queue:${consumer.bindingName}`,
      message: same ? 'Native Queue consumer settings match' : 'Configure the owned Queue consumer after its Worker deployment is ACTIVE',
      desired: input,
      current,
    });
  }
  const requested = new Set(desired.queueConsumers.map(consumer => consumer.bindingName));
  for (const resource of resources) {
    if (object(resource.config).nativeConsumer && !requested.has(String(resource.bindingName))) {
      changes.push({
        operation: 'MANUAL', key: `queue:${resource.bindingName}`,
        message: 'Remote native Queue consumer is preserved; removing its declaration does not stop deliveries automatically',
      });
    }
  }
  if (desired.crons.length || (project.config.workerId && client.listWorkerSchedules)) {
    if (project.config.workerId && !client.listWorkerSchedules) {
      throw new WorkerProjectConfigError('worker_event_client_incomplete', 'The client must read tracked schedules to review native cron changes');
    }
    const schedules = project.config.workerId ? rows(await client.listWorkerSchedules!(options, project.config.workerId)) : [];
    for (const cron of desired.crons) {
      const cronName = "Wrangler cron " + createHash("sha256").update(cron).digest("hex").slice(0,16);
      const current = schedules.find(schedule => schedule.name === cronName && schedule.handler === 'scheduled' &&
        String(schedule.environment).toLowerCase() === environment && schedule.cron === cron && schedule.timezone === 'UTC');
      changes.push({
        operation: current?.enabled === true ? 'NO_CHANGE' : current ? 'UPDATE' : 'CREATE',
        key: `cron:${cron}`,
        message: 'UTC scheduled handler uses the backend scheduler and tracked run receipts',
        desired: { cron, handler: 'scheduled', timezone: 'UTC' },
        ...(current ? { current } : {}),
      });
    }
    for (const schedule of schedules) {
      if (schedule.handler === 'scheduled' && String(schedule.environment).toLowerCase() === environment &&
        schedule.enabled === true && !desired.crons.includes(String(schedule.cron))) {
        const owned = /^Wrangler cron [a-f0-9]{16}$/.test(String(schedule.name));
        changes.push({
          operation: intent.cronsConfigured && owned ? 'UPDATE' : 'MANUAL', key: `cron:${schedule.cron}`,
          message: intent.cronsConfigured && owned
            ? 'Disable this owned Wrangler trigger omitted from the explicit Cron array'
            : 'Remote scheduled handler is preserved because its trigger intent is absent or it is managed separately',
          ...(intent.cronsConfigured && owned ? {desired:{enabled:false}} : {}), current: schedule,
        });
      }
    }
  }
  return changes;
}

/** Called only after confirmed activation. Configuration receipts do not attest delivery. */
export async function applyWorkerNativeEvents(
  project: LoadedWorkerProject,
  environment: 'preview' | 'production',
  workerId: string,
  client: NativeEventClient,
  options: WorkersClientOptions,
): Promise<{ queueConsumers: string[]; crons: string[] }> {
  const plan = nativeDeploymentPlan(project, environment);
  await applyNativeDeploymentPhase(client as NativeDeploymentClient, options, workerId, environment, plan, "AFTER_CODE");
  return {queueConsumers: plan.consumers.map(item => item.bindingName), crons: plan.crons};
}
