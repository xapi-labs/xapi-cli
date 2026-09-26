type RecordValue = Record<string, unknown>;

export interface WorkerGuidanceTarget {
  workerId?: unknown;
  environment?: unknown;
}

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function shellArgument(value: string): string {
  return /^[a-zA-Z0-9_.:/-]+$/.test(value) && !value.startsWith("-")
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}

/** Never guess a target when the response does not identify it. */
export function workerReadOnlyFollowups(target: WorkerGuidanceTarget): string[] {
  const workerId = text(target.workerId);
  const environment = text(target.environment)?.toLowerCase();
  if (!workerId || !["preview", "production"].includes(environment || "")) {
    return [];
  }
  const args = `${shellArgument(workerId)} --env ${environment}`;
  return [
    `xapi workers billing lifecycle ${args}`,
    `xapi workers retention show ${args}`,
    `xapi workers inspect ${args}`,
  ];
}

/** Interpret lifecycle evidence, never infer overall completion from receipts. */
export function workerLifecycleGuidance(dataValue: unknown): string[] {
  const data = record(dataValue);
  const state = text(data.state)?.toUpperCase();
  const lines: string[] = [];
  switch (state) {
    case "ACCEPTED":
    case "REQUESTED":
    case "PENDING":
    case "SUSPENDING":
    case "RESUMING":
    case "PENDING_DELETION":
    case "DELETING":
      lines.push(`Lifecycle ${state}: work is pending; the requested outcome is not confirmed complete.`);
      break;
    case "SUSPENDED":
    case "SUSPENDED_GRACE":
    case "PAUSED":
      lines.push("Execution is paused. Retained storage is not deleted or refunded by pausing; retention charges may continue. Check the retention policy, reserve and deadlines.");
      break;
    case "ACTIVE":
    case "LOW_BALANCE":
      lines.push(`Lifecycle ${state} is reported. This does not verify public availability or completion of a recently requested action.`);
      if (state === "LOW_BALANCE") lines.push("Review the available balance and retention reserve before choosing a recovery action.");
      break;
    case "DELETED":
      lines.push("Lifecycle reports DELETED. Verify resource cleanup, final metering and reserve release separately; this state alone is not refund evidence.");
      break;
    case "FAILED":
    case "TIMED_OUT":
      lines.push(`Lifecycle ${state}: the requested outcome is not confirmed. Inspect blockers and current resources before deciding on recovery; failure does not prove rollback.`);
      break;
    default:
      lines.push("Lifecycle completion is unknown. Read the current lifecycle and retention evidence before choosing an action.");
  }

  if (data.phase != null || data.completedSteps != null || data.totalSteps != null) {
    lines.push("Phase and progress describe recorded step receipts, not an exhaustive plan. Even all recorded steps completed or a completed phase does not prove the whole operation is done.");
  }
  if (text(data.nextStep)) {
    lines.push(`Next recorded unfinished step: ${data.nextStep}. Read lifecycle again to check its outcome.`);
  }
  const blockers = Array.isArray(data.blockerCodes)
    ? data.blockerCodes.filter((code): code is string => !!text(code))
    : [];
  if (blockers.length) {
    lines.push(`Reported blockers: ${blockers.join(", ")}. Inspect these prerequisites before choosing another action; repeating a mutation is not a status check.`);
  }
  return lines;
}

export interface WorkerRetentionGuidanceOptions extends WorkerGuidanceTarget {
  action: "show" | "quote" | "accept" | "pause" | "resume" | "keep-paused" | "delete";
  response: unknown;
  /** Set only when an optional client-side polling session actually ended. */
  pollingEnded?: boolean;
}

/** Append to human retention output only; leaves the original API payload intact. */
export function formatWorkerRetentionGuidance(options: WorkerRetentionGuidanceOptions): string {
  const response = record(options.response);
  const lifecycle = Object.hasOwn(response, "lifecycle")
    ? record(response.lifecycle)
    : response;
  const lines: string[] = [];
  if (!["show", "quote"].includes(options.action)) {
    lines.push(`The ${options.action} request returned a response. Request acceptance is not proof of lifecycle completion; use the reported state and follow-up reads.`);
  }
  if (options.action === "quote") {
    lines.push("This quote is an estimate, not a lifecycle completion or refund receipt.");
  } else if (response.enabled === false) {
    lines.push("Retention is reported disabled. This does not establish deletion, a refund or zero storage usage.");
  } else {
    lines.push(...workerLifecycleGuidance(lifecycle));
  }
  if (options.pollingEnded) {
    lines.push("Local polling ended. Stopping observation does not cancel the backend operation; read its state again when needed.");
  }
  const commands = workerReadOnlyFollowups(options);
  if (commands.length) lines.push("Read-only follow-up:", ...commands.map(command => `  ${command}`));
  return lines.join("\n");
}

/** Display only explicitly reported HTTPS URLs, never construct one from a hostname. */
export function reportedHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https:\/\/[^/]/i.test(value) || /[\s\\\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** A missing URL may be derived from an explicitly reported DNS hostname only. */
export function reportedDomainHttpsUrl(domain: RecordValue): string | undefined {
  if (domain.url != null && domain.url !== "") return reportedHttpsUrl(domain.url);
  const hostname = text(domain.hostname);
  if (!hostname || hostname.length > 253 || !hostname.includes(".")) return undefined;
  const labels = hostname.split(".");
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return undefined;
  const result = reportedHttpsUrl(`https://${hostname}`);
  // Reject URL parser reinterpretation (e.g. numeric IPv4 shorthand).
  return result && new URL(result).hostname === hostname.toLowerCase() ? result : undefined;
}
