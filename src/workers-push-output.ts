import type { WorkerPushResult } from "./workers-push.ts";

const RULE = "─".repeat(72);

function metadata(label: string, value: string): string {
  return `  ${label.padEnd(13)}${value}`;
}

function short(value: string): string {
  return value.length > 18 ? `${value.slice(0, 12)}…` : value;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KiB`;
}

/** Human success receipt; the full JSON result remains the CI contract. */
export function formatWorkerPushResult(result: WorkerPushResult): string {
  const resources = [
    result.resources.created.length
      ? `${result.resources.created.length} created (${result.resources.created.join(", ")})`
      : undefined,
    result.resources.unchanged.length
      ? `${result.resources.unchanged.length} reused`
      : undefined,
  ].filter(Boolean);
  const lines = [
    "xAPI Worker Push",
    RULE,
    metadata("Status", result.paused ? "ACTIVE — deployment succeeded; environment remains owner-paused" : "ACTIVE — public health check passed"),
    metadata("Project", result.initialPlan.project.slug),
    metadata("Environment", result.initialPlan.environment),
    metadata("Worker", result.worker.id),
    metadata("URL", result.publicUrl),
    metadata("Deployment", result.paused ? result.deployment.id : short(result.deployment.id)),
    metadata(
      "Artifact",
      `${short(result.artifact.contentSha256)} · ${bytes(result.artifact.sizeBytes)}`,
    ),
    metadata(
      "Health",
      `HTTP ${result.health.status} · ${result.health.attempts} attempt${result.health.attempts === 1 ? "" : "s"}`,
    ),
    metadata("Resources", resources.join(" · ") || "No managed resources"),
    ...(result.nativeReceipts.length ? [metadata("Native steps", `${result.nativeReceipts.length} deployment receipts; event execution still needs verification`)] : []),
    ...(result.deployment.containerRollout ? [metadata("Containers",
      result.deployment.containerRollout.status === "PENDING" ? "Rollout pending native confirmation"
        : result.deployment.containerRollout.status === "COMPLETE" ? "Configuration accepted; check application health"
          : "Native configuration unconfirmed")] : []),
    "",
    "Next steps",
    ...(result.paused ? [
      "  Public access is closed; health is not ready. Do not republish to retry health.",
      `  Inspect: ${result.commands.inspect}`,
      `  Resume: ${result.commands.resume}`,
      `  After resuming, check health: ${result.health.url}`,
      `  Then verify business access: ${result.publicUrl}`,
    ] : [
      `  1. Open: ${result.publicUrl}`,
      `  2. Inspect: ${result.commands.inspect}`,
      `  3. Logs: ${result.commands.logs}`,
      `  4. Production: ${result.commands.promote}`,
    ]),
    RULE,
  ];
  return lines.join("\n");
}

export function useHumanWorkerPushOutput(options: {
  flagFormat?: string;
  envFormat?: string;
  stdoutIsTTY?: boolean;
}): boolean {
  const explicit = options.flagFormat || options.envFormat;
  return explicit === "table" || (!explicit && options.stdoutIsTTY === true);
}
