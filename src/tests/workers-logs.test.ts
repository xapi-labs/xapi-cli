import { describe, expect, test } from "bun:test";
import {
  type WorkerLogsClient,
  parseLogSince,
  readWorkerLogs,
  tailWorkerLogs,
} from "../workers-logs.ts";

const workerId = "55555555-5555-4555-8555-555555555555";
const clientOptions = { apiHost: "localhost:3003", apiKey: "test-key" };
const baseTime = Date.parse("2026-08-26T12:00:00.000Z");

function worker() {
  return {
    id: workerId,
    environments: [
      { id: "env-preview", name: "PREVIEW" },
      { id: "env-production", name: "PRODUCTION" },
    ],
    deployments: [
      {
        id: "deployment-v1",
        artifactId: "artifact-v1",
        environmentId: "env-production",
        status: "ACTIVE",
        deployedAt: "2026-08-26T10:00:00.000Z",
      },
      {
        id: "deployment-v2",
        artifactId: "artifact-v2",
        environmentId: "env-production",
        status: "ACTIVE",
        deployedAt: "2026-08-26T11:30:00.000Z",
      },
      {
        id: "preview-deployment",
        artifactId: "artifact-preview",
        environmentId: "env-preview",
        status: "ACTIVE",
        deployedAt: "2026-08-26T11:45:00.000Z",
      },
    ],
  };
}

function logs(items: Array<Record<string, unknown>>) {
  return {
    items,
    rows: items.length,
    sampled: false,
    contentPolicy: {
      requestBody: false,
      responseBody: false,
      consoleMessages: true,
    },
  };
}

describe("workers logs", () => {
  test("validates relative durations", () => {
    expect(parseLogSince("30s")).toBe(30_000);
    expect(parseLogSince("10m")).toBe(600_000);
    expect(parseLogSince("2h")).toBe(7_200_000);
    expect(() => parseLogSince("10 minutes")).toThrow(
      "positive duration using s, m, or h",
    );
    expect(() => parseLogSince("0m")).toThrow(
      "positive duration using s, m, or h",
    );
  });

  test("filters by time, level, request, and derived deployment without changing the server", async () => {
    const client: WorkerLogsClient = {
      getWorker: async () => worker(),
      workerRuntimeLogs: async () =>
        logs([
          {
            eventTimestamp: baseTime - 30_000,
            level: "error",
            requestId: "request-new",
            message: "new failure",
          },
          {
            eventTimestamp: baseTime - 40 * 60_000,
            level: "error",
            requestId: "request-old",
            message: "old failure",
          },
          {
            eventTimestamp: baseTime - 20_000,
            level: "info",
            requestId: "request-new",
            message: "new info",
          },
        ]),
    };

    const result = await readWorkerLogs({
      workerId,
      environment: "production",
      clientOptions,
      since: "10m",
      level: "error",
      requestId: "request-new",
      deploymentId: "deployment-v2",
      client,
      now: () => baseTime,
    });

    expect(result.items).toEqual([
      expect.objectContaining({
        message: "new failure",
        deploymentId: "deployment-v2",
      }),
    ]);
    expect(result.rows).toBe(1);
    expect(result.filters).toEqual({
      since: "10m",
      level: "error",
      requestId: "request-new",
      deploymentId: "deployment-v2",
    });
    expect(result.contentPolicy).toEqual(
      expect.objectContaining({ requestBody: false, responseBody: false }),
    );
  });

  test("rejects a deployment outside the selected environment", async () => {
    const client: WorkerLogsClient = {
      getWorker: async () => worker(),
      workerRuntimeLogs: async () => logs([]),
    };
    await expect(
      readWorkerLogs({
        workerId,
        environment: "production",
        deploymentId: "preview-deployment",
        clientOptions,
        client,
      }),
    ).rejects.toThrow(
      "not a visible deployment in the selected Worker environment",
    );
  });

  test("tails in chronological order, survives a transient read error, and suppresses repeated rows", async () => {
    let reads = 0;
    const first = {
      eventTimestamp: baseTime - 1_000,
      timestamp: "2026-08-26T11:59:59.000Z",
      level: "log",
      requestId: "request-1",
      message: "first",
    };
    const second = {
      eventTimestamp: baseTime,
      timestamp: "2026-08-26T12:00:00.000Z",
      level: "error",
      requestId: "request-2",
      message: "second",
    };
    const client: WorkerLogsClient = {
      getWorker: async () => worker(),
      workerRuntimeLogs: async () => {
        reads += 1;
        if (reads === 1) throw new TypeError("temporary network failure");
        return reads === 2 ? logs([first]) : logs([second, first]);
      },
    };
    const batches: string[][] = [];
    let warnings = 0;
    const summary = await tailWorkerLogs({
      workerId,
      environment: "production",
      clientOptions,
      client,
      maxPolls: 3,
      sleep: async () => undefined,
      onBatch: (batch) =>
        batches.push(batch.items.map((item) => String(item.message))),
      onTransientError: () => {
        warnings += 1;
      },
    });

    expect(batches).toEqual([["first"], ["second"]]);
    expect(warnings).toBe(1);
    expect(summary).toEqual({ polls: 3, emitted: 2, stopped: false });
  });
});
