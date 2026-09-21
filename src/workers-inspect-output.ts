import type { WorkerInspection } from "./workers-inspect.ts";

const RULE = "─".repeat(72);

function value(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  return Array.isArray(value) ? value.join(", ") || "—" : String(value);
}

function row(label: string, item: unknown): string {
  return `  ${label.padEnd(22)} ${value(item)}`;
}

export function formatWorkerInspection(report: WorkerInspection): string {
  const lines = [
    "xAPI Worker Inspection · READ ONLY",
    RULE,
    row("Control plane", report.controlPlane),
    row("Worker", `${value(report.worker.name)} (${value(report.worker.id)})`),
    row("Worker status", report.worker.status),
    row("Environment", report.environment.name),
    row("Environment status", report.environment.status),
    row("Public URL", report.environment.publicUrl),
    row("Routing mode", report.environment.routingMode),
    row("Web app ready", report.environment.webAppReady),
    row("Active deployment", report.deployment?.id),
    row("Artifact", report.artifact?.id),
    row(
      "Resources",
      report.resources.status === "AVAILABLE"
        ? report.resources.items.length
        : "unknown",
    ),
    row(
      "Secrets configured",
      report.secrets.status === "AVAILABLE"
        ? report.secrets.items.length
        : "unknown",
    ),
    row(
      "Domains",
      report.domains.status === "AVAILABLE" ? report.domains.items.length : "unknown",
    ),
    row("Billing quality", report.billing.summary?.dataQuality),
    row("Billing through", report.billing.summary?.completeThrough),
    "",
    "Diagnostics",
    ...report.diagnostics.map(
      (item) => `  ${item.status.padEnd(7)} ${item.check.padEnd(20)} ${item.message}`,
    ),
    "",
    "Next steps",
    ...report.nextSteps.map((command) => `  ${command}`),
    RULE,
  ];
  return lines.join("\n");
}

export function useHumanWorkerInspectionOutput(options: {
  flagFormat?: string;
  envFormat?: string;
  stdoutIsTTY?: boolean;
}): boolean {
  const explicit = options.flagFormat || options.envFormat;
  return explicit === "table" || explicit === "pretty" || (!explicit && options.stdoutIsTTY === true);
}

