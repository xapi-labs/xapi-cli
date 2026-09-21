import { describe, expect, test } from "bun:test";
import {
  formatWorkerPushResult,
  useHumanWorkerPushOutput,
} from "../workers-push-output.ts";
import type { WorkerPushResult } from "../workers-push.ts";

const result: WorkerPushResult = {
  schemaVersion: 1,
  status: "ACTIVE",
  initialPlan: {
    schemaVersion: 1,
    project: {
      rootDir: "/tmp/my-agent",
      configPath: "/tmp/my-agent/xapi.worker.json",
      slug: "my-agent",
      build: { command: "npm run build", output: "dist/worker.mjs" },
    },
    environment: "preview",
    remote: { linked: true, workerId: "worker-id" },
    costImpact: {
      status: "AVAILABLE",
      desiredDailyBudgetUsd: 0.25,
      currentDailyBudgetUsd: 0.25,
      dailyBudgetDeltaUsd: 0,
      priceBook: { version: "workers-v1", rateCount: 12 },
      meteredChanges: [],
      notes: [],
    },
    canApply: true,
    summary: {
      CREATE: 2,
      UPDATE: 0,
      NO_CHANGE: 6,
      MANUAL: 0,
      BLOCKED: 0,
    },
    actions: [],
  },
  worker: { id: "worker-id", created: false, configLinked: true },
  resources: { created: [], unchanged: ["DB", "STATE"] },
  artifact: {
    id: "artifact-id",
    contentSha256:
      "75dba47691d9110adeb174df728bd18b2c0600834cf7832ae8df4a49f55c5e8f",
    sizeBytes: 16798,
  },
  deployment: {
    id: "9ce6b4af-92b6-46cb-9aec-f81a7cc84c3b",
    status: "ACTIVE",
    idempotencyKey: "key",
  },
  publicUrl: "https://my-agent.example.test",
  health: {
    url: "https://my-agent.example.test/health",
    status: 200,
    attempts: 1,
  },
  inspection: {
    schemaVersion: 1,
    mode: "READ_ONLY",
    controlPlane: "api.xapi.to",
    worker: { id: "worker-id", status: "ACTIVE" },
    environment: { name: "PREVIEW", status: "ACTIVE" },
    resources: { status: "AVAILABLE", items: [] },
    secrets: { status: "AVAILABLE", items: [] },
    domains: { status: "AVAILABLE", items: [] },
    billing: { status: "AVAILABLE", summary: { dataQuality: "COMPLETE" } },
    diagnostics: [],
    nextSteps: [],
  },
  commands: {
    inspect: "xapi workers inspect worker-id --env preview",
    logs: "xapi workers logs worker-id --env preview",
    promote: "xapi workers promote --to production",
  },
};

describe("Worker push terminal output", () => {
  test("renders a concise deployment receipt without dumping initialPlan JSON", () => {
    const rendered = formatWorkerPushResult(result);
    expect(rendered).toContain("ACTIVE — public health check passed");
    expect(rendered).toContain("https://my-agent.example.test");
    expect(rendered).toContain("HTTP 200 · 1 attempt");
    expect(rendered).toContain("2 reused");
    expect(rendered).toContain("xapi workers inspect worker-id --env preview");
    expect(rendered).toContain("xapi workers logs worker-id --env preview");
    expect(rendered).not.toContain('"initialPlan"');
  });

  test("uses human output for terminals and table while preserving explicit JSON", () => {
    expect(useHumanWorkerPushOutput({ stdoutIsTTY: true })).toBe(true);
    expect(
      useHumanWorkerPushOutput({
        flagFormat: "json",
        stdoutIsTTY: true,
      }),
    ).toBe(false);
    expect(
      useHumanWorkerPushOutput({
        envFormat: "table",
        stdoutIsTTY: false,
      }),
    ).toBe(true);
  });
});
