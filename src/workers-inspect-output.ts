import type { WorkerInspection } from "./workers-inspect.ts";
import { reportedDomainHttpsUrl, reportedHttpsUrl } from "./workers-operation-guidance.ts";

const RULE = "─".repeat(72);

function value(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  return Array.isArray(value) ? value.join(", ") || "—" : String(value);
}

function row(label: string, item: unknown): string {
  return `  ${label.padEnd(22)} ${value(item)}`;
}

export function formatWorkerInspection(report: WorkerInspection): string {
  // Domain target selection belongs to inspectWorker; do not broaden it here.
  const domainUrls = report.domains.status === "AVAILABLE"
    ? [...new Set(report.domains.items
        .filter(domain => domain.status === "ACTIVE")
        .map(reportedDomainHttpsUrl)
        .filter((url): url is string => !!url))]
    : [];
  const lines = [
    "xAPI Worker Inspection · READ ONLY",
    RULE,
    row("Control plane", report.controlPlane),
    row("Worker", `${value(report.worker.name)} (${value(report.worker.id)})`),
    row("Worker status", report.worker.status),
    row("Environment", report.environment.name),
    row("Environment status", report.environment.status),
    row("Lifecycle state", report.billing.summary?.lifecycleState),
    row("Public URL", reportedHttpsUrl(report.environment.publicUrl)),
    row("Platform URL", reportedHttpsUrl(report.environment.dispatchUrl)),
    ...domainUrls.map(url => row("Active domain URL", url)),
    row("Routing mode", report.environment.routingMode),
    row("Web app ready", report.environment.webAppReady),
    row("Active deployment", report.deployment?.id),
    row("Deployment status", report.deployment?.status),
    row("Public access", "unverified (metadata only; no reachability probe)"),
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
    "  ACTIVE deployment or domain status does not verify public availability. Check the reported URL and application behavior separately.",
    ...(report.billing.status === "UNKNOWN" || !report.billing.summary?.completeThrough
      ? ["  Collector freshness is unknown; missing metering is not zero usage or zero cost."]
      : []),
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
