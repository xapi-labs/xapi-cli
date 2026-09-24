import type {
  WorkerDeploymentPlan,
  WorkerPlanAction,
} from "./workers-plan.ts";

const RULE = "─".repeat(72);

const KIND_LABEL: Record<WorkerPlanAction["kind"], string> = {
  worker: "Worker",
  budget: "Budget",
  placement: "Placement",
  resource: "Resource",
  secret: "Secret",
  routing: "Routing",
  artifact: "Artifact",
  deployment: "Deployment",
};

const RESOURCE_LABEL: Record<string, string> = {
  kv_namespace: "KV namespace",
  d1_database: "D1 database",
  r2_bucket: "R2 bucket",
  durable_object: "Durable Object",
  queue: "Queue",
  workflow: "Workflow",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function shortHash(value: unknown): string | undefined {
  const hash = text(value);
  return hash ? `${hash.slice(0, 12)}…` : undefined;
}

function size(value: unknown): string | undefined {
  const bytes = number(value);
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function actionName(action: WorkerPlanAction): string {
  if (action.kind === "artifact") return "local bundle";
  if (action.kind === "deployment" && /^[a-f0-9]{24,}$/i.test(action.key)) {
    return `${action.key.slice(0, 12)}…`;
  }
  return action.key.length > 22 ? `${action.key.slice(0, 21)}…` : action.key;
}

function actionDetail(action: WorkerPlanAction): string {
  if (action.operation === "MANUAL") return action.message;
  const desired = record(action.desired);
  const current = record(action.current);
  if (action.operation === "BLOCKED") {
    if (action.kind === "secret") return "Value not set";
    if (action.kind === "deployment") return "Waiting for prerequisites";
    return action.message;
  }
  if (action.kind === "worker") {
    const template = text(desired.template);
    return template ? `${template} template` : action.message;
  }
  if (action.kind === "budget") {
    const daily = number(desired.dailyBudgetUsd);
    const prior = number(current.dailyBudgetUsd);
    if (daily === undefined) return action.message;
    return prior === undefined
      ? `$${daily.toFixed(2)}/day`
      : `$${prior.toFixed(2)} → $${daily.toFixed(2)}/day`;
  }
  if (action.kind === "resource") {
    const type = text(desired.type) || text(current.type) || "resource";
    const parts = [RESOURCE_LABEL[type] || type];
    const className = text(desired.className) || text(current.className);
    if (className) parts.push(`class ${className}`);
    const location =
      text(desired.location) ||
      text(current.requestedLocation) ||
      text(current.effectiveLocation);
    if (location) parts.push(`location ${location.toUpperCase()}`);
    const readReplication =
      text(desired.readReplication) || text(current.readReplication);
    if (readReplication) parts.push(`read replication ${readReplication}`);
    if (action.operation === "CREATE") parts.push("managed by xAPI");
    return parts.join(" · ");
  }
  if (action.kind === "secret") {
    return action.operation === "NO_CHANGE"
      ? "Configured (value remains hidden)"
      : action.message;
  }
  if (action.kind === "artifact") {
    const parts = [size(desired.sizeBytes), shortHash(desired.sha256)].filter(
      Boolean,
    );
    return parts.length ? parts.join(" · sha256 ") : action.message;
  }
  return action.message;
}

function actionRow(action: WorkerPlanAction): string {
  const marker =
    action.operation === "CREATE"
      ? "+"
      : action.operation === "UPDATE"
        ? "~"
        : action.operation === "MANUAL"
          ? "?"
          : action.operation === "BLOCKED"
            ? "!"
            : "=";
  return `  ${marker} ${KIND_LABEL[action.kind].padEnd(12)}${actionName(action).padEnd(24)}${actionDetail(action)}`;
}

function metadataRow(label: string, value: string): string {
  return `  ${label.padEnd(13)}${value}`;
}

function nextSteps(plan: WorkerDeploymentPlan): string[] {
  const command =
    plan.environment === "preview"
      ? "xapi workers push --env preview"
      : "xapi workers promote --to production";
  const blockers = plan.actions.filter(
    (action) => action.operation === "BLOCKED",
  );
  const manual = plan.actions.filter(
    (action) => action.operation === "MANUAL",
  );
  const missingSecrets = blockers
    .filter((action) => action.kind === "secret")
    .map((action) => action.key);
  const rootBlockers = blockers.filter(
    (action) => action.kind !== "deployment" && action.kind !== "secret",
  );
  const changes = plan.actions.filter(
    (action) => action.operation === "CREATE" || action.operation === "UPDATE",
  );

  if (!blockers.length && manual.length) {
    const remoteResources = manual.filter(
      (action) => action.kind === "resource",
    );
    const deleteCommands = remoteResources
      .map(
        (action) =>
          `     xapi workers resources destroy --env ${plan.environment} --binding ${action.key} --yes`,
      );
    return [
      "  1. Resolve the MANUAL items before treating this environment as synchronized.",
      ...(remoteResources.length
        ? [
            `  2. Keep remote-only resources: xapi workers resources pull --env ${plan.environment}`,
            "     Or back up and destroy resources that should no longer exist:",
            ...deleteCommands,
            `  3. Re-run: xapi workers plan --env ${plan.environment}`,
          ]
        : [`  2. Re-run: xapi workers plan --env ${plan.environment}`]),
    ];
  }
  if (!blockers.length) {
    if (!changes.length) {
      return [
        "  1. No deployment changes are required.",
        "  2. Run workers push only when you want to rebuild and repeat health verification.",
      ];
    }
    return [`  1. Apply this plan: ${command}`];
  }
  if (!plan.remote.linked && missingSecrets.length && !rootBlockers.length) {
    return [
      `  1. Run ${command} to create the Worker and managed resources.`,
      "     Deployment will pause safely before any missing Secret is needed.",
      `  2. Set the required Secrets when the CLI prints the new workerId: ${missingSecrets.join(", ")}`,
      `  3. Run ${command} again to build, deploy, and verify health.`,
    ];
  }
  if (missingSecrets.length && !rootBlockers.length) {
    const workerId = plan.project.workerId || "<worker-id>";
    return [
      `  1. Set the required Secrets: ${missingSecrets.join(", ")}`,
      ...missingSecrets.map(
        (name) =>
          `     xapi workers secrets set ${workerId} ${name} --env ${plan.environment} --from-env ${name}`,
      ),
      `  2. Re-run: xapi workers plan --env ${plan.environment}`,
      `  3. Apply: ${command}`,
    ];
  }
  return [
    "  1. Resolve the BLOCKED items shown above.",
    `  2. Re-run: xapi workers plan --env ${plan.environment}`,
  ];
}

/** Human review view for a Worker plan. JSON output remains the CI contract. */
export function formatWorkerPlan(plan: WorkerDeploymentPlan): string {
  const planned = plan.actions.filter(
    (action) => action.operation === "CREATE" || action.operation === "UPDATE",
  );
  const manual = plan.actions.filter(
    (action) => action.operation === "MANUAL",
  );
  const blocked = plan.actions.filter(
    (action) => action.operation === "BLOCKED",
  );
  const unchanged = plan.actions.filter(
    (action) => action.operation === "NO_CHANGE",
  );
  const rootBlocked = blocked.filter(
    (action) => action.kind !== "deployment",
  ).length;
  const result = blocked.length
    ? `BLOCKED — ${rootBlocked || blocked.length} prerequisite${(rootBlocked || blocked.length) === 1 ? "" : "s"} ${(rootBlocked || blocked.length) === 1 ? "needs" : "need"} attention`
    : manual.length
      ? `REVIEW — ${manual.length} manual item${manual.length === 1 ? "" : "s"} must be reconciled`
      : "READY — safe to apply";
  const remote = plan.remote.linked
    ? `Linked · ${plan.remote.workerId || plan.project.workerId || "existing Worker"}`
    : "Not linked · a new Worker will be created";
  const budget = plan.costImpact;
  const budgetChange =
    budget.currentDailyBudgetUsd === undefined
      ? `$${budget.desiredDailyBudgetUsd.toFixed(2)}/day target`
      : `$${budget.currentDailyBudgetUsd.toFixed(2)} → $${budget.desiredDailyBudgetUsd.toFixed(2)}/day (${budget.dailyBudgetDeltaUsd! >= 0 ? "+" : "-"}$${Math.abs(budget.dailyBudgetDeltaUsd!).toFixed(2)})`;
  const priceBook = budget.priceBook
    ? `${budget.priceBook.version || "active version"} · ${budget.priceBook.rateCount} rates`
    : "Unavailable — verify before production promotion";

  const lines = [
    "xAPI Worker Plan",
    RULE,
    metadataRow("Project", plan.project.slug),
    metadataRow("Environment", plan.environment),
    metadataRow("Remote", remote),
    metadataRow("Result", result),
    metadataRow("Config", plan.project.configPath),
    metadataRow(
      "Build",
      `${plan.project.build.command} → ${plan.project.build.output}${plan.project.build.main ? ` (main: ${plan.project.build.main})` : ""}`,
    ),
    "  Plan built and validated this exact bundle; push applies the reviewed result.",
    "",
    "Summary",
    metadataRow("Create", String(plan.summary.CREATE)),
    metadataRow("Update", String(plan.summary.UPDATE)),
    metadataRow("Unchanged", String(plan.summary.NO_CHANGE)),
    metadataRow("Manual", String(plan.summary.MANUAL)),
    metadataRow("Blocked", String(plan.summary.BLOCKED)),
    "",
    "Cost impact",
    metadataRow("Daily budget", budgetChange),
    metadataRow("Price book", priceBook),
    metadataRow(
      "Metered changes",
      budget.meteredChanges.length
        ? `${budget.meteredChanges.length} usage-dependent item${budget.meteredChanges.length === 1 ? "" : "s"}`
        : "No new metered resource declarations",
    ),
    ...budget.notes.map((note) => `  · ${note}`),
    "",
    "Planned changes",
    ...(planned.length ? planned.map(actionRow) : ["  No changes required."]),
  ];

  if (manual.length) {
    lines.push("", "Manual review", ...manual.map(actionRow));
  }
  if (blocked.length) {
    lines.push("", "Blocked", ...blocked.map(actionRow));
  }
  if (unchanged.length) {
    lines.push("", "Existing state (reused)", ...unchanged.map(actionRow));
  }
  lines.push("", "Next steps", ...nextSteps(plan), RULE);
  return lines.join("\n");
}

export function useHumanWorkerPlanOutput(options: {
  flagFormat?: string;
  envFormat?: string;
  stdoutIsTTY?: boolean;
}): boolean {
  const explicit = options.flagFormat || options.envFormat;
  return explicit === "table" || (!explicit && options.stdoutIsTTY === true);
}
