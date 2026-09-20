const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
// Public resource labels still must not inject terminal control sequences.
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number"
    ? String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ") : "—";
const labels: Record<string, string> = {
  PENDING: "Awaiting collection",
  MISSING: "Source has no sample (not zero usage)",
  OBSERVED: "Samples observed (not final coverage)",
  ERROR: "Collection failed; retry pending",
  EXPIRED_GAP: "Historical gap archived (not settled)",
  ARCHIVED_OBSERVATIONS: "Samples archived (not final coverage)",
};

export function formatWorkerMetering(response: unknown): string {
  const data = record(response), collection = record(data.storageCollection);
  const lines = [
    "Worker metering sources",
    `Worker: ${text(data.workerId)} · Environment: ${text(data.environment)}`,
    "Missing samples are not zero usage. Observed samples do not prove complete coverage or final settlement.",
    "This is an independent source read, not a pinned billing snapshot.",
  ];
  if (!Array.isArray(collection.items)) {
    lines.push("Storage collection status unavailable; no cost conclusion can be drawn.");
    return lines.join("\n");
  }
  if (collection.truncated) lines.push("WARNING: Environment list truncated at 500 windows; history is incomplete.");
  if (!collection.items.length) lines.push("No collection windows returned. Collection may be disabled, pending or unsupported; this does not mean free storage.");
  for (const raw of collection.items) {
    const item = record(raw);
    const status = typeof item.status === "string" ? labels[item.status] : undefined;
    lines.push("", `Resource: ${text(item.resourceId)} · ${text(item.dataset)}`,
      `  Window [start, end): ${text(item.windowStart)} → ${text(item.windowEnd)}`,
      `  Status: ${status || "Unknown collection status"}`,
      `  Samples: ${text(item.observedSamples)} · Last sample: ${text(item.lastSampleAt)}`,
      `  Last attempt: ${text(item.lastAttemptAt)} · Next attempt: ${text(item.nextAttemptAt)}`,
      `  Reason: ${text(item.errorCode)}`);
  }
  return lines.join("\n");
}
