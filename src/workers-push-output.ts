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
    metadata("Status", "ACTIVE — public health check passed"),
    metadata("Project", result.initialPlan.project.slug),
    metadata("Environment", result.initialPlan.environment),
    metadata("Worker", result.worker.id),
    metadata("URL", result.publicUrl),
    metadata("Deployment", short(result.deployment.id)),
    metadata(
      "Artifact",
      `${short(result.artifact.contentSha256)} · ${bytes(result.artifact.sizeBytes)}`,
    ),
    metadata(
      "Health",
      `HTTP ${result.health.status} · ${result.health.attempts} attempt${result.health.attempts === 1 ? "" : "s"}`,
    ),
    metadata("Resources", resources.join(" · ") || "No managed resources"),
    "",
    "Next steps",
    `  1. Open: ${result.publicUrl}`,
    `  2. Logs: ${result.commands.logs}`,
    `  3. Production: ${result.commands.promote}`,
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
