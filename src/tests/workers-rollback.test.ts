import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestTimeoutError } from "../client.ts";
import {
  type RollbackClient,
  createWorkerRollbackPlan,
  rollbackWorkerProject,
} from "../workers-rollback.ts";
import { WORKER_PROJECT_SCHEMA_URL } from "../workers-project.ts";

const roots: string[] = [];
const workerId = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "xapi-rollback-")));
  roots.push(root);
  writeFileSync(
    join(root, "wrangler.jsonc"),
    JSON.stringify({
      name: "rollback-agent",
      main: "src/index.ts",
      compatibility_date: "2026-08-26",
    }),
  );
  writeFileSync(
    join(root, "xapi.worker.json"),
    JSON.stringify(
      {
        $schema: WORKER_PROJECT_SCHEMA_URL,
        version: 1,
        workerId,
        worker: {
          name: "Rollback Agent",
          slug: "rollback-agent",
          template: "agent",
        },
        wrangler: "wrangler.jsonc",
        build: { command: "never-run", output: "dist/worker.mjs" },
        environments: {
          preview: {
            dailyBudgetUsd: 0.25,
            healthCheck: "/health",
            resources: [],
            secrets: [],
          },
          production: {
            dailyBudgetUsd: 2,
            healthCheck: "/health?final=true",
            resources: [],
            secrets: [],
          },
        },
      },
      null,
      2,
    ),
  );
  return root;
}

function fakePlatform(options: { failOnce?: boolean } = {}) {
  let activeDeploymentId = "production-current";
  let failOnce = !!options.failOnce;
  let rollbackReads = 0;
  let pendingRollbackId: string | undefined;
  const calls = { rollback: 0, health: 0 };
  const rollbackInputs: Array<Record<string, unknown>> = [];
  const deployments: Array<Record<string, unknown>> = [
    {
      id: "production-current",
      artifactId: "artifact-current",
      environmentId: "env-production",
      status: "ACTIVE",
      deployedAt: "2026-08-26T12:00:00.000Z",
    },
    {
      id: "production-previous",
      artifactId: "artifact-previous",
      environmentId: "env-production",
      status: "ACTIVE",
      deployedAt: "2026-08-25T12:00:00.000Z",
    },
    {
      id: "production-same-artifact",
      providerResult: { containerOverrides: [{ name: "app", instanceType: "lite" }] },
      artifactId: "artifact-current",
      environmentId: "env-production",
      status: "ACTIVE",
      deployedAt: "2026-08-24T12:00:00.000Z",
    },
    {
      id: "preview-previous",
      artifactId: "artifact-preview",
      environmentId: "env-preview",
      status: "ACTIVE",
      deployedAt: "2026-08-25T13:00:00.000Z",
    },
  ];
  const snapshot = () => {
    const rollback = deployments.find(
      (item) => item.id === pendingRollbackId && item.status === "DEPLOYING",
    );
    if (rollback) {
      rollbackReads += 1;
      if (rollbackReads >= 2) {
        rollback.status = "ACTIVE";
        activeDeploymentId = String(rollback.id);
        pendingRollbackId = undefined;
      }
    }
    return {
      id: workerId,
      environments: [
        {
          id: "env-preview",
          name: "PREVIEW",
          activeDeploymentId: "preview-previous",
          publicUrl: "https://agent.example.test/w/ref/preview",
        },
        {
          id: "env-production",
          name: "PRODUCTION",
          activeDeploymentId,
          publicUrl: "https://agent.example.test/w/ref/production",
        },
      ],
      deployments,
    };
  };
  const client: RollbackClient = {
    getWorker: async () => snapshot(),
    rollbackWorker: async (_api, _id, environment, input) => {
      calls.rollback += 1;
      rollbackInputs.push(input);
      expect(environment).toBe("production");
      const existing = deployments.find(
        (item) => item.idempotencyKey === `rollback:${input.idempotencyKey}`,
      );
      if (existing) return existing;
      const target = deployments.find(
        (item) => item.id === input.deploymentId,
      )!;
      const created = {
        id: calls.rollback === 1 ? "production-rollback" : `production-rollback-${calls.rollback}`,
        artifactId: target.artifactId,
        environmentId: "env-production",
        idempotencyKey: `rollback:${input.idempotencyKey}`,
        status: "DEPLOYING",
        deployedAt: "2026-08-26T13:00:00.000Z",
      };
      deployments.unshift(created);
      pendingRollbackId = created.id; rollbackReads = 0;
      if (failOnce) {
        failOnce = false;
        throw new RequestTimeoutError(60_000);
      }
      return created;
    },
  };
  return { client, calls, rollbackInputs, deployments, activate(id: string) { activeDeploymentId = id; } };
}

describe("workers rollback", () => {
  test("selects the latest different ACTIVE version, reconciles a timeout, and health-checks without credentials", async () => {
    const root = fixture();
    const platform = fakePlatform({ failOnce: true });
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fetchPublic = (async (input, init) => {
      platform.calls.health += 1;
      requests.push({
        url: String(input),
        headers: new Headers(init?.headers),
      });
      return Response.json({ ok: true });
    }) as typeof fetch;
    const plans: unknown[] = [];

    const result = await rollbackWorkerProject({
      cwd: root,
      environment: "production",
      to: "previous",
      clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
      client: platform.client,
      confirm: async () => true,
      onPlan: (plan) => plans.push(plan),
      fetchPublic,
      sleep: async () => undefined,
    });

    expect(result.status).toBe("ACTIVE");
    expect(result.plan.target).toEqual({
      deploymentId: "production-previous",
      artifactId: "artifact-previous",
    });
    expect(result.plan.codeOnly).toBe(true);
    expect(result.plan.dataAndSecretsRolledBack).toBe(false);
    expect(result.plan.warning).toContain("D1, R2, KV");
    expect(result.deployment.artifactId).toBe("artifact-previous");
    expect(platform.calls.rollback).toBe(1);
    expect(platform.rollbackInputs[0].idempotencyKey).toMatch(
      /^rollback-[0-9a-f]{32}$/,
    );
    expect(result.health.url).toBe(
      "https://agent.example.test/w/ref/production/health?final=true",
    );
    expect(requests[0].headers.has("XAPI-KEY")).toBe(false);
    expect(requests[0].headers.has("Authorization")).toBe(false);
    expect(plans).toHaveLength(1);
  });

  test("refuses a visible explicit target from another environment", async () => {
    const root = fixture();
    const platform = fakePlatform();
    await expect(
      createWorkerRollbackPlan({
        cwd: root,
        environment: "production",
        deploymentId: "preview-previous",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
      }),
    ).rejects.toThrow("not an ACTIVE deployment in the selected environment");
    expect(platform.calls.rollback).toBe(0);
  });

  test("cancels production before mutation and requires exactly one target selector", async () => {
    const root = fixture();
    const platform = fakePlatform();
    await expect(
      rollbackWorkerProject({
        cwd: root,
        environment: "production",
        to: "previous",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
        confirm: async () => false,
      }),
    ).rejects.toThrow("cancelled");
    expect(platform.calls.rollback).toBe(0);

    await expect(
      createWorkerRollbackPlan({
        cwd: root,
        environment: "production",
        clientOptions: { apiHost: "localhost:3003", apiKey: "test-key" },
        client: platform.client,
      }),
    ).rejects.toThrow("Choose exactly one rollback target");
  });
});


test('explicit rollback accepts a prior deployment with the same Artifact',async()=>{
  const root=fixture(),platform=fakePlatform();
  const plan=await createWorkerRollbackPlan({cwd:root,environment:'production',deploymentId:'production-same-artifact',clientOptions:{apiHost:'localhost:3003',apiKey:'test-key'},client:platform.client});
  expect(plan.plan.target).toEqual({deploymentId:'production-same-artifact',artifactId:'artifact-current'});
  expect(plan.plan.codeOnly).toBe(false);
});

 test('lost rollback response with no visible receipt never dispatches a second write',async()=>{
  const root=fixture(),platform=fakePlatform();
  platform.client.rollbackWorker=async()=>{platform.calls.rollback++;throw new RequestTimeoutError(60_000);};
  await expect(rollbackWorkerProject({cwd:root,clientOptions:{apiHost:'test.xapi.to',apiKey:'key'},
    environment:'production',to:'previous',nonInteractive:true,client:platform.client,sleep:async()=>{}}))
    .rejects.toThrow();
  expect(platform.calls.rollback).toBe(1);
 });

 test('a later rollback to the same target creates a new operation after an intervening deployment',async()=>{
  const root=fixture(), platform=fakePlatform();
  const options={cwd:root,environment:'production' as const,deploymentId:'production-previous',
    clientOptions:{apiHost:'test.xapi.to',apiKey:'key'},client:platform.client,nonInteractive:true,
    fetchPublic:(async()=>Response.json({ok:true})) as unknown as typeof fetch,sleep:async()=>undefined};
  const first=await rollbackWorkerProject(options);
  platform.deployments.unshift({id:'production-new-v2',environmentId:'env-production',artifactId:'artifact-new-v2',status:'ACTIVE'});
  platform.activate('production-new-v2');
  const second=await rollbackWorkerProject(options);
  expect(platform.calls.rollback).toBe(2);
  expect(platform.rollbackInputs[0].idempotencyKey).not.toBe(platform.rollbackInputs[1].idempotencyKey);
  expect(second.deployment.id).not.toBe(first.deployment.id);
  expect(second.deployment.artifactId).toBe('artifact-previous');
 });
