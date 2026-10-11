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

test("plan explains telemetry false/zero and private map count without source contents", () => {
  const rendered = formatWorkerPlan({ ...plan, actions: [{
    operation: "CREATE", kind: "artifact", key: "bundle", message: "Upload bundle",
    desired: { configuration: { observability: { logs: { enabled: true, head_sampling_rate: 0, persist: false } }, sourceMaps: ["index.js.map"] } },
  }] });
  expect(rendered).toContain('"head_sampling_rate":0');
  expect(rendered).toContain('"persist":false');
  expect(rendered).toContain("1 private upload attachment(s)");
  expect(rendered).not.toContain("sourcesContent");
});


test("public variable decisions show full names, type transitions and explanations without values", () => {
  const variables: NonNullable<WorkerDeploymentPlan["variables"]> = [
    { name: "PUBLIC_APPLICATION_ORIGIN_PREVIEW", decision: "SET", type: "plain_text", message: "Set the Artifact declaration." },
    { name: "REMOTE_FLAG", decision: "RETAIN", currentType: "json", type: "json", message: "Keep the omitted JSON binding." },
    { name: "OLD_LABEL", decision: "REMOVE", currentType: "plain_text", message: "Remove the omitted public variable." },
    { name: "JSON_STRING", decision: "REPLACE", currentType: "plain_text", type: "json", message: "Preserve the native JSON-string binding type." },
    { name: "DB", decision: "REPLACE", currentType: "json", message: "Explicit resource binding takes this name." },
  ];
  // Even unexpected extra response fields must not be dumped by the renderer.
  const withValues = variables.map(variable => ({ ...variable, value: "never-render-value", currentValue: "never-render-current" }));
  const input = { ...plan, variables: withValues };
  const before = JSON.stringify(input);
  const rendered = formatWorkerPlan(input);
  expect(rendered).toContain("Public variables");
  expect(rendered).toContain("SET      PUBLIC_APPLICATION_ORIGIN_PREVIEW · plain_text");
  expect(rendered).toContain("RETAIN   REMOTE_FLAG · json");
  expect(rendered).toContain("REMOVE   OLD_LABEL · plain_text → removed");
  expect(rendered).toContain("REPLACE  JSON_STRING · plain_text → json");
  expect(rendered).toContain("REPLACE  DB · json → explicit binding");
  for (const variable of variables) expect(rendered).toContain(variable.message);
  expect(rendered).toContain("Values are not displayed or compared");
  expect(rendered).toContain("Secrets are managed independently and kept");
  expect(rendered).not.toContain("never-render");
  expect(JSON.stringify(input)).toBe(before);
});

test("old plans omit unavailable variable decisions while explicit empty decisions remain visible", () => {
  expect(formatWorkerPlan(plan)).not.toContain("Public variables");
  const empty = formatWorkerPlan({ ...plan, variables: [] });
  expect(empty).toContain("Public variables");
  expect(empty).toContain("No public variable decisions.");
});

test("optional variable types do not invent defaults or print undefined", () => {
  const rendered = formatWorkerPlan({ ...plan, variables: [
    { name: "UNTYPED", decision: "SET", message: "Artifact supplies this variable." },
    { name: "REUSED", decision: "RETAIN", currentType: "plain_text", message: "Keep the current binding." },
  ] });
  expect(rendered).toContain("SET      UNTYPED\n");
  expect(rendered).toContain("RETAIN   REUSED · plain_text");
  expect(rendered).not.toContain("undefined");
  expect(rendered).not.toContain("UNTYPED · plain_text");
});
