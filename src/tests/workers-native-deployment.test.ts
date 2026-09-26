import { test, expect } from "bun:test";
import { applyNativeDeploymentPhase } from "../workers-native-deployment.ts";
const options = {
  apiKey: "test-key",
  apiBaseUrl: "https://api.xapi.to",
} as any;
const plan = {
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
    applyNativeDeploymentPhase(
      api,
      options,
      "worker",
      "preview",
      plan,
      "BEFORE_CODE",
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
    applyNativeDeploymentPhase(
      api,
      options,
      "worker",
      "preview",
      plan,
      "BEFORE_CODE",
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
      return input;
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
    await applyNativeDeploymentPhase(
      api,
      options,
      "worker",
      "production",
      plan,
      "BEFORE_CODE",
    );
    throw new Error("expected failure");
  } catch (error: any) {
    expect(error.phase).toBe("BEFORE_CODE");
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
    migrations: [],
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

test("removed native Queue consumer is disabled once; the Queue and manual consumers remain", async () => {
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
  const desired = { migrations: [], consumers: [plan.consumers[0]], crons: [], cronsConfigured: false };
  await applyNativeDeploymentPhase(api, options, "worker", "preview", desired, "AFTER_CODE");
  await applyNativeDeploymentPhase(api, options, "worker", "preview", desired, "AFTER_CODE");
  expect(calls).toEqual(["disable:old", "configure:current", "configure:current"]);
  expect(remote.find(row => row.id === "manual")?.config).toEqual({});
});

test("removing all consumer declarations reconciles a previously managed consumer", async () => {
  const disabled: string[] = [];
  await applyNativeDeploymentPhase({
    async listWorkerResources() { return [{ id: "old", type: "QUEUE", bindingName: "OLD", status: "ACTIVE", config: { nativeConsumerHash: "hash" } }]; },
    async disableWorkerQueueConsumer(_o, _w, _e, id) { disabled.push(id); return { status: "DISABLED" }; },
  }, options, "worker", "preview", { migrations: [], consumers: [], crons: [], cronsConfigured: false }, "AFTER_CODE");
  expect(disabled).toEqual(["old"]);
});

import { validNativeCron } from "../workers-native-deployment.ts";
test("validates CF numeric Cron ranges before any remote deployment phase", () => {
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
