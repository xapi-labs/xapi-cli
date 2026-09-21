import { describe, expect, test } from "bun:test";
import type { WorkerDeploymentPlan } from "../workers-plan.ts";
import {
  formatWorkerPlan,
  useHumanWorkerPlanOutput,
} from "../workers-plan-output.ts";

test("manual resource drift shows the binding and ongoing-charge warning", () => {
  const warning = "Remote resource remains bound and may keep accruing charges; explicitly delete it, then deploy again";
  const rendered = formatWorkerPlan({ ...plan, actions: [{ operation: "MANUAL", kind: "resource", key: "OLD_DB", message: warning, current: { type: "d1_database" } }] });
  expect(rendered).toContain(warning);
  expect(rendered).toContain("REVIEW — 1 manual item must be reconciled");
  expect(rendered).toContain("resources pull --env preview");
  expect(rendered).not.toContain("No deployment changes are required");
});

const plan: WorkerDeploymentPlan = {
  schemaVersion: 1,
  project: {
    rootDir: "/tmp/my-agent",
    configPath: "/tmp/my-agent/xapi.worker.json",
    slug: "my-agent",
    build: { command: "npm run build", output: "dist/worker.mjs" },
  },
  environment: "preview",
  remote: { linked: false },
  costImpact: {
    status: "UNKNOWN",
    desiredDailyBudgetUsd: 0.25,
    meteredChanges: [
      {
        kind: "worker",
        key: "my-agent",
        effect: "USAGE_DEPENDENT",
      },
      {
        kind: "resource",
        key: "AGENT_STATE",
        type: "durable_object",
        effect: "USAGE_DEPENDENT",
      },
    ],
    notes: ["The daily budget is a spending cap, not a predicted charge."],
  },
  canApply: false,
  summary: {
    CREATE: 4,
    UPDATE: 0,
    NO_CHANGE: 0,
    MANUAL: 0,
    BLOCKED: 2,
  },
  actions: [
    {
      operation: "CREATE",
      kind: "worker",
      key: "my-agent",
      message: "Create Worker",
      desired: { template: "agent" },
    },
    {
      operation: "CREATE",
      kind: "budget",
      key: "preview",
      message: "Set budget",
      desired: { dailyBudgetUsd: 0.25 },
    },
    {
      operation: "CREATE",
      kind: "resource",
      key: "AGENT_STATE",
      message: "Create managed resource",
      desired: {
        type: "durable_object",
        bindingName: "AGENT_STATE",
        className: "AgentState",
      },
    },
    {
      operation: "CREATE",
      kind: "artifact",
      key: "6e0699058ebac0800a155a1f8b450b1b",
      message: "Upload bundle",
      desired: {
        sha256: "6e0699058ebac0800a155a1f8b450b1b",
        sizeBytes: 7566,
      },
    },
    {
      operation: "BLOCKED",
      kind: "secret",
      key: "MODEL_KEY",
      message: "Secret value is missing",
      desired: { bindingName: "MODEL_KEY" },
    },
    {
      operation: "BLOCKED",
      kind: "deployment",
      key: "current",
      message: "Deployment is blocked",
    },
  ],
};

describe("Worker plan terminal output", () => {
  test("renders a structured review view with actionable next steps", () => {
    const rendered = formatWorkerPlan(plan);
    expect(rendered).toContain("xAPI Worker Plan");
    expect(rendered).toContain("BLOCKED — 1 prerequisite needs attention");
    expect(rendered).toContain("Durable Object · class AgentState · managed by xAPI");
    expect(rendered).toContain("MODEL_KEY");
    expect(rendered).toContain("npm run build → dist/worker.mjs");
    expect(rendered).toContain("push applies the reviewed result");
    expect(rendered).toContain("$0.25/day target");
    expect(rendered).toContain("2 usage-dependent items");
    expect(rendered).toContain("xapi workers push --env preview");
    expect(rendered).not.toContain('"schemaVersion"');
    expect(rendered).not.toContain(
      "6e0699058ebac0800a155a1f8b450b1bCreate",
    );
  });

  test("does not tell users to apply an already converged plan", () => {
    const converged: WorkerDeploymentPlan = {
      ...plan,
      canApply: true,
      summary: {
        CREATE: 0,
        UPDATE: 0,
        NO_CHANGE: 2,
        MANUAL: 0,
        BLOCKED: 0,
      },
      actions: [
        { ...plan.actions[0], operation: "NO_CHANGE" },
        { ...plan.actions[3], operation: "NO_CHANGE" },
      ],
    };
    const rendered = formatWorkerPlan(converged);
    expect(rendered).toContain("No deployment changes are required");
    expect(rendered).toContain("Existing state (reused)");
    expect(rendered).toContain("= Worker");
    expect(rendered).not.toContain("Apply this plan");
  });

  test("uses the review view for a TTY or explicit table format", () => {
    expect(useHumanWorkerPlanOutput({ stdoutIsTTY: true })).toBe(true);
    expect(
      useHumanWorkerPlanOutput({
        flagFormat: "json",
        envFormat: "json",
        stdoutIsTTY: true,
      }),
    ).toBe(false);
    expect(
      useHumanWorkerPlanOutput({ envFormat: "table", stdoutIsTTY: false }),
    ).toBe(true);
    expect(useHumanWorkerPlanOutput({ stdoutIsTTY: false })).toBe(false);
  });
});
