const BASELINE_MS = 60_000;
const QUICK_ACTIONS = new Set([
  "content",
  "screenshot",
  "pdf",
  "markdown",
  "snapshot",
  "accessibility_tree",
  "scrape",
  "json",
  "links",
]);
const TIMED_EXTENSIONS = new Set([
  "session.exec",
  "code.create",
  "code.run",
  "git.checkout",
  "process.wait_for_port",
  "process.wait_for_log",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function legalMilliseconds(value: unknown, minimum = 0): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
  );
}

function positiveMilliseconds(value: unknown, field: string) {
  if (!legalMilliseconds(value, 1))
    throw new RangeError(
      `${field} must be a positive safe integer in milliseconds`,
    );
  return value;
}

function explicitMilliseconds(value: unknown): value is number {
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    !Number.isSafeInteger(value)
  )
    throw new RangeError(
      "Cloudflare explicit timeout exceeds safe integer milliseconds",
    );
  return legalMilliseconds(value);
}

export function safeCloudflareBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(
      "Cloudflare transport budget exceeds safe integer milliseconds",
    );
  return value;
}

/** Coverage for sequential native work, not a new deadline for a scenario. */
export function cloudflareExtensionExecutionMs(
  extensionId: string,
  input: Record<string, unknown>,
  upstreamMs = BASELINE_MS,
): number | undefined {
  const operation = extensionId.replace(/^cloudflare\./, "");
  if (operation === "browser.automate") {
    const perStep =
      input.timeoutMs === undefined
        ? 30_000
        : positiveMilliseconds(input.timeoutMs, "timeoutMs");
    const actions = Array.isArray(input.actions) ? input.actions : [];
    const extract = Array.isArray(input.extract) ? input.extract : [];
    let coverage = safeCloudflareBudget(
      perStep * (actions.length + extract.length + 3),
    );
    for (const rawAction of actions) {
      const action = record(rawAction);
      if (action.type === "wait" && explicitMilliseconds(action.milliseconds))
        coverage = safeCloudflareBudget(coverage + action.milliseconds);
    }
    return Math.max(BASELINE_MS, coverage);
  }
  if (
    operation.startsWith("browser.") &&
    QUICK_ACTIONS.has(operation.slice(8))
  ) {
    let coverage = safeCloudflareBudget(upstreamMs);
    for (const timeout of [
      record(input.gotoOptions).timeout,
      record(input.waitForSelector).timeout,
      input.actionTimeout,
      input.waitForTimeout,
      record(input.pdfOptions).timeout,
      record(input.screenshotOptions).timeout,
    ]) {
      // Keep native option validation, including zero, at the upstream API.
      if (explicitMilliseconds(timeout))
        coverage = safeCloudflareBudget(coverage + timeout);
    }
    return coverage;
  }
  // Match the pinned CF Git clone default; do not let a shorter transport
  // budget interrupt a healthy default clone.
  if (operation === "git.checkout" && input.timeoutMs === undefined) return 600_000;
  if (TIMED_EXTENSIONS.has(operation) && input.timeoutMs !== undefined)
    return positiveMilliseconds(input.timeoutMs, "timeoutMs");
  return undefined;
}

/** CLI defaults cover both Gateway hops, wake and the final client hop. */
export function sandboxExtensionTimeoutMs(
  extensionId: string,
  input: Record<string, unknown>,
): number {
  // Provider-specific extensions keep their own native timeout semantics.
  if (extensionId === 'vercel.command.get' && input.wait === true) {
    const nativeMs = input.timeoutMs === undefined ? 60_000 : positiveMilliseconds(input.timeoutMs, 'timeoutMs');
    // Native wait + Gateway/Adapter hop allowance + final client hop.
    return Math.max(180_000, safeCloudflareBudget(nativeMs + 60_000 + 10_000 + 30_000));
  }
  if (!extensionId.startsWith('cloudflare.')) return 180_000;
  const execution = cloudflareExtensionExecutionMs(extensionId, input);
  if (execution === undefined) return 180_000;
  return Math.max(180_000, safeCloudflareBudget(execution + 60_000 + 2 * 60_000 + 20_000 + 30_000));
}
