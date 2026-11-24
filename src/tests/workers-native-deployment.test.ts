import { test, expect } from "bun:test";
import { applyD1Migrations } from "../workers-d1-migrations.ts";
import { applyNativeDeploymentPhase } from "../workers-native-deployment.ts";
const options = {
  apiKey: "test-key",
  apiBaseUrl: "https://api.xapi.to",
} as any;
const plan = {
  d1Migrations: [],
  migrations: [
    {
      bindingName: "DB",
      table: "d1_migrations",
      name: "0001.sql",
      sql: "CREATE TABLE example(id);",
      sha256: "hash",
    },
    {
      bindingName: "DB",
      table: "d1_migrations",
      name: "0002.sql",
      sql: "ALTER TABLE example ADD name;",
      sha256: "hash2",
    },
  ],
  consumers: [
    {
      bindingName: "JOBS",
      configuration: { queue: "logical-jobs", max_batch_size: 1 },
    },
  ],
  crons: ["0 * * * *"],
  cronsConfigured: true,
};
const resources = [
  { id: "db-id", bindingName: "DB", type: "D1_DATABASE", status: "ACTIVE" },
  { id: "queue-id", bindingName: "JOBS", type: "QUEUE", status: "ACTIVE" },
];
test("remote migrations are ordered and failures stop subsequent files", async () => {
  const seen: string[] = [];
  const api = {
    async listWorkerResources() {
      return resources;
    },
    async applyWorkerD1Migration(
      _o: any,
      _w: any,
      _e: any,
      id: any,
      input: any,
    ) {
      expect(id).toBe("db-id");
      seen.push(input.name);
      throw new Error("remote SQL rejected");
    },
  };
  await expect(
    applyD1Migrations(
      api, options, "worker",
      { environment: "preview", bindingName: "DB", migrations: plan.migrations },
    ),
  ).rejects.toThrow("remote SQL rejected");
  expect(seen).toEqual(["0001.sql"]);
});
test("does not accept local/missing receipts as remote completion", async () => {
  const api = {
    async listWorkerResources() {
      return resources;
    },
    async applyWorkerD1Migration() {
      return { status: "APPLIED" };
    },
  };
  await expect(
    applyD1Migrations(
      api, options, "worker",
      { environment: "preview", bindingName: "DB", migrations: plan.migrations },
    ),
  ).rejects.toThrow("Remote migration receipt missing");
});
test("configures consumer and scheduled handler after code, reuses existing schedule", async () => {
  const seen: any[] = [];
  const api = {
    async listWorkerResources() {
      return resources;
    },
    async configureWorkerQueueConsumer(...args: any[]) {
      seen.push(args);
      return { status: "CONFIGURED" };
    },
    async listWorkerSchedules(): Promise<any[]> {
      return [];
    },
    async createWorkerSchedule(_o: any, _id: any, input: any) {
      seen.push(input);
      return {id:"schedule",...input};
    },
    async updateWorkerSchedule() {
      throw new Error("unexpected update");
    },
  };
  await applyNativeDeploymentPhase(
    api,
    options,
    "worker",
    "preview",
    plan,
    "AFTER_CODE",
  );
  expect(seen[0][3]).toBe("queue-id");
  expect(seen[0][4]).toEqual(plan.consumers[0].configuration);
  expect(seen[1]).toMatchObject({
    handler: "scheduled",
    cron: "0 * * * *",
    timezone: "UTC",
  });
  api.listWorkerSchedules = async () => [
    { ...seen[1], id: "schedule", enabled: true },
  ];
  await applyNativeDeploymentPhase(
    api,
    options,
    "worker",
    "preview",
    plan,
    "AFTER_CODE",
  );
  expect(seen).toHaveLength(3);
});

test("AFTER_CODE preserves paused Queue configuration receipts without automatic resume", async () => {
  const calls: string[] = [];
  const desired = { ...plan, crons: [], cronsConfigured: false,
    consumers: [{ ...plan.consumers[0], configuration: { queue: "logical-jobs", max_batch_size: 7 } }] };
  const receipt = { status: "CONFIGURED", activation: "ON_RESUME", paused: true };
  const api = {
    async listWorkerResources() { calls.push("resources"); return resources; },
    async configureWorkerQueueConsumer(_o: unknown, _w: string, env: string, id: string, input: unknown) {
      calls.push("configure");
      expect(env).toBe("preview"); expect(id).toBe("queue-id");
      expect(input).toEqual(desired.consumers[0].configuration);
      return receipt;
    },
    async workerRetention() { throw new Error("must not resume"); },
  };
  expect(await applyNativeDeploymentPhase(api, options, "worker", "preview", desired, "AFTER_CODE"))
    .toEqual([{ bindingName: "JOBS", ...receipt }]);
  expect(calls).toEqual(["resources", "configure"]);
});

test("preserves completed remote migration receipts when the next file fails", async () => {
  const receipt = { status: "APPLIED", remote: true, name: "0001.sql" };
  let count = 0;
  const api = {
    async listWorkerResources() {
      return resources;
    },
    async applyWorkerD1Migration() {
      if (count++) throw new Error("second SQL failed");
      return receipt;
    },
  };
  try {
    await applyD1Migrations(
      api, options, "worker",
      { environment: "production", bindingName: "DB", migrations: plan.migrations },
    );
    throw new Error("expected failure");
  } catch (error: any) {
    expect(error.failedMigration).toBe("0002.sql");
    expect(error.completed).toEqual([receipt]);
    expect(error.message).toBe("second SQL failed");
  }
});

test("an explicit empty Cron list disables only CLI-managed schedules in this environment", async () => {
  const updates: any[] = [];
  const schedule = {
    environment: "PREVIEW",
    handler: "scheduled",
    name: "Wrangler cron 1234567890123456",
    enabled: true,
  };
  const api = {
    async listWorkerResources() {
      return [];
    },
    async listWorkerSchedules() {
      return [
        { ...schedule, id: "owned" },
        { ...schedule, id: "production", environment: "PRODUCTION" },
        { ...schedule, id: "manual", name: "User task" },
        { ...schedule, id: "http-manual", handler:"http" },
      ];
    },
    async createWorkerSchedule() {
      throw new Error("unexpected");
    },
    async updateWorkerSchedule(...args: any[]) {
      updates.push(args);
      return { id: args[2], enabled: false };
    },
  };
  const empty = {
    d1Migrations: [],
    consumers: [],
    crons: [],
    cronsConfigured: false,
  };
  await applyNativeDeploymentPhase(
    api,
    options,
    "worker",
    "preview",
    empty,
    "AFTER_CODE",
  );
  expect(updates).toEqual([]);
  await applyNativeDeploymentPhase(
    api,
    options,
    "worker",
    "preview",
    { ...empty, cronsConfigured: true },
    "AFTER_CODE",
  );
  expect(updates.map((args) => args.slice(2))).toEqual([
    ["owned", { enabled: false }],
  ]);
});

test("omitting a Queue consumer declaration preserves native and manual consumers", async () => {
  const calls: string[] = [];
  const remote = [
    { id: "old", type: "QUEUE", bindingName: "OLD", status: "ACTIVE", config: { nativeConsumerHash: "hash" } },
    { id: "manual", type: "QUEUE", bindingName: "MANUAL", status: "ACTIVE", config: {} },
    { id: "current", type: "QUEUE", bindingName: "JOBS", status: "ACTIVE", config: { nativeConsumerHash: "hash2" } },
  ];
  const api = {
    async listWorkerResources() { return remote; },
    async disableWorkerQueueConsumer(_o: any, _w: any, env: string, id: string) {
      expect(env).toBe("preview");
      calls.push(`disable:${id}`);
      remote.find(row => row.id === id)!.config = {} as any;
      return { status: "DISABLED" };
    },
    async configureWorkerQueueConsumer(_o: any, _w: any, _env: any, id: string) {
      calls.push(`configure:${id}`);
      return { status: "UNCHANGED" };
    },
  };
  const desired = { d1Migrations: [], consumers: [plan.consumers[0]], crons: [], cronsConfigured: false };
  await applyNativeDeploymentPhase(api, options, "worker", "preview", desired, "AFTER_CODE");
  await applyNativeDeploymentPhase(api, options, "worker", "preview", desired, "AFTER_CODE");
  expect(calls).toEqual(["configure:current", "configure:current"]);
  expect(remote.find(row=>row.id==="old")?.config).toEqual({nativeConsumerHash:"hash"});
  expect(remote.find(row => row.id === "manual")?.config).toEqual({});
});

test("omitting all consumer declarations does not remove an existing native consumer", async () => {
  const disabled: string[] = [];
  await applyNativeDeploymentPhase({
    async listWorkerResources() { return [{ id: "old", type: "QUEUE", bindingName: "OLD", status: "ACTIVE", config: { nativeConsumerHash: "hash" } }]; },
    async disableWorkerQueueConsumer(_o, _w, _e, id) { disabled.push(id); return { status: "DISABLED" }; },
  }, options, "worker", "preview", { d1Migrations: [], consumers: [], crons: [], cronsConfigured: false }, "AFTER_CODE");
  expect(disabled).toEqual([]);
});

import { validNativeCron } from "../workers-native-deployment.ts";
test("retains numeric Cron prediction helper without using it as native deployment admission", () => {
  for (const cron of ["*/5 * * * *", "0 12 * * 1", "0 0 1-31/2 * 7"])
    expect(validNativeCron(cron)).toBe(true);
  for (const cron of [
    "60 * * * *",
    "0 24 * * *",
    "0 0 0 * *",
    "0 0 * 13 *",
    "0 0 * * 0",
    "*/0 * * * *",
    "5/2 * * * *",
    "0 * * * MON",
    "0 0 L * *",
    "- * * * *",
  ])
    expect(validNativeCron(cron)).toBe(false);
});

test("backend Cron rejection is returned without altering its expression or replaying the mutation",async()=>{
 const sent: string[]=[];
 const api={listWorkerResources:async()=>[],listWorkerSchedules:async()=>[],
  createWorkerSchedule:async(_o:any,_id:string,input:any)=>{sent.push(input.cron);throw Error('CF cron invalid expression');},
  updateWorkerSchedule:async()=>{throw Error('unexpected update');}};
 await expect(applyNativeDeploymentPhase(api,options,'worker','preview',{
  d1Migrations:[],consumers:[],crons:['0 18 * * MON#2'],cronsConfigured:true,
 },'AFTER_CODE')).rejects.toThrow('CF cron invalid expression');
 expect(sent).toEqual(['0 18 * * MON#2']);
});
