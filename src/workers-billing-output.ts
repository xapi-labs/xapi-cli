import type { WorkerBillingQueryKind } from "./workers-client.ts";

type RecordValue = Record<string, unknown>;
export type WorkerBillingOutputMode = "human" | "json";

const RULE = "─".repeat(88);

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function value(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value))
    return value.length ? value.map(String).join(", ") : "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function usd(valueToFormat: unknown): string {
  const exact = value(valueToFormat);
  return exact === "—" ? exact : `$${exact}`;
}

function row(label: string, item: unknown): string {
  return `  ${label.padEnd(24)}${value(item)}`;
}

function table(headers: string[], rows: string[][]): string[] {
  if (!rows.length) return ["  (empty)"];
  const widths = headers.map((header, index) =>
    Math.min(
      38,
      Math.max(header.length, ...rows.map((item) => item[index]?.length || 0)),
    ),
  );
  const cell = (item: string, width: number) =>
    item.length <= width
      ? item.padEnd(width)
      : `${item.slice(0, Math.max(0, width - 1))}…`;
  return [
    `  ${headers.map((header, index) => cell(header, widths[index])).join("  ")}`,
    `  ${widths.map((width) => "─".repeat(width)).join("  ")}`,
    ...rows.map(
      (items) =>
        `  ${items.map((item, index) => cell(item, widths[index])).join("  ")}`,
    ),
  ];
}

function qualityLines(response: RecordValue): string[] {
  const quality = value(response.dataQuality);
  const completeThrough = value(response.completeThrough);
  const warning =
    quality === "COMPLETE"
      ? []
      : [
          `  ! ${quality}: provider data may be delayed or incomplete; unknown values remain —.`,
        ];
  return [
    row("Data quality", quality),
    row("Complete through", completeThrough),
    ...warning,
  ];
}

function prices(data: RecordValue): string[] {
  const rates = array(data.rates).map((item) => {
    const rate = record(item);
    return [
      value(rate.metric),
      `${value(rate.unitSize)} ${value(rate.unit)}`,
      usd(rate.providerUnitPriceUsd),
      usd(rate.retailUnitPriceUsd),
    ];
  });
  return [
    row("Price book", data.version),
    row("Effective from", data.effectiveFrom),
    "",
    "Rates",
    ...table(["Metric", "Unit", "Provider USD", "Retail USD"], rates),
  ];
}

function overview(data: RecordValue): string[] {
  const customer = Object.hasOwn(data, "customerAccruedUsd");
  const resourceTotals = array(data.resourceTotals).map((item) => {
    const total = record(item);
    return [
      value(total.kind),
      value(total.resourceCount),
      usd(customer ? total.customerAccruedUsd : total.settledUsd),
      usd(total.reservedUsd),
      usd(total.estimatedUsd),
      usd(total.exposureUsd),
      value(total.dataQuality),
      value(total.reasonCodes),
    ];
  });
  return [
    row("Lifecycle", data.lifecycleState),
    row("Daily budget", usd(data.dailyBudgetUsd)),
    row("Budget remaining", usd(data.budgetRemainingUsd)),
    row(
      customer ? "Customer accrued" : "Settled",
      usd(customer ? data.customerAccruedUsd : data.settledUsd),
    ),
    ...(customer
      ? [
          row("Platform funded", usd(data.platformRiskUsd)),
          row("Funding complete", data.fundingBreakdownComplete),
          row("Meaning", data.settlementMeaning),
        ]
      : []),
    row("Reserved", usd(data.reservedUsd)),
    row("Estimated", usd(data.estimatedUsd)),
    row("Exposure", usd(data.exposureUsd)),
    row("Safety reserve", usd(data.safetyReserveUsd)),
    row("Ledger net", usd(data.ledgerNetUsd)),
    row("Ledger entries", data.ledgerEntries),
    row("Provider outage", data.providerOutage),
    row("Reasons", data.reasonCodes),
    "",
    "Resource totals",
    ...table(
      [
        "Resource",
        "Count",
        customer ? "Accrued" : "Settled",
        "Reserved",
        "Estimated",
        "Exposure",
        "Quality",
        "Reasons",
      ],
      resourceTotals,
    ),
  ];
}

function usage(data: RecordValue): string[] {
  const buckets = array(data.buckets).map((item) => {
    const bucket = record(item);
    const facts = array(bucket.facts).map((factValue) => {
      const fact = record(factValue);
      return `${value(fact.metric)}=${value(fact.quantity)}`;
    });
    const status = value(bucket.status);
    return [
      value(bucket.start),
      status === "GAP" || status === "MISSING" ? `! ${status}` : status,
      facts.length ? facts.join(", ") : "—",
    ];
  });
  return [
    row("Range", `${value(data.from)} → ${value(data.to)}`),
    row("Buckets", data.bucketCount),
    row("Gaps", data.gapCount),
    row("Partial", data.partialCount),
    row("Metric", data.metric),
    row("Resource", data.resourceId),
    "",
    "Five-minute buckets",
    ...table(["Start", "Status", "Facts"], buckets),
  ];
}

function ledger(data: RecordValue): string[] {
  const entries = array(data.entries).map((item) => {
    const entry = record(item);
    return [
      value(entry.createdAt),
      value(entry.entryType),
      value(entry.metric),
      value(entry.quantity),
      usd(entry.amountUsd),
    ];
  });
  return [
    "Ledger entries",
    ...table(["Time", "Type", "Metric", "Quantity", "Amount"], entries),
    "",
    row("Has more", data.hasMore),
    row("Next cursor", data.nextCursor),
  ];
}

function forecast(data: RecordValue): string[] {
  return [
    row("Spendable", usd(data.spendableUsd)),
    row("Burn rate (1h)", usd(data.burnRate1hUsd)),
    row("Burn rate (24h)", usd(data.burnRate24hUsd)),
    row("Burn / hour", usd(data.burnRateUsdPerHour)),
    row("Time to zero (hours)", data.timeToZeroHours),
    row("Safety reserve", usd(data.safetyReserveUsd)),
    row("Provider delay reserve", usd(data.providerDelayReserveUsd)),
    row("Retention reserve", usd(data.retentionStorageReserveUsd)),
    row("Shutdown reserve", usd(data.asyncShutdownReserveUsd)),
    row("Provider outage", data.providerOutage),
  ];
}

function riskSection(title: string, input: unknown): string[] {
  if (input === null || input === undefined) return [title, "  —"];
  const fields = record(input);
  return [
    title,
    ...Object.entries(fields).map(([key, fieldValue]) =>
      row(key, key.endsWith("Usd") ? usd(fieldValue) : fieldValue),
    ),
  ];
}

function risk(data: RecordValue): string[] {
  return [
    ...riskSection("Account risk", data.accountRisk),
    "",
    ...riskSection("Environment exposure", data.environmentExposure),
    "",
    ...riskSection("API key exposure", data.apiKeyExposure),
  ];
}

function lifecycle(data: RecordValue): string[] {
  return [
    row("State", data.state),
    row("Reason", data.reasonCode),
    row("Phase", data.phase),
    row(
      "Progress",
      `${value(data.completedSteps)} / ${value(data.totalSteps)}`,
    ),
    row("Next step", data.nextStep),
    row("Blockers", data.blockerCodes),
    row("Suspended at", data.suspendedAt),
    row("Grace deadline", data.graceDeadlineAt),
    row("Deletion earliest", data.deletionEarliestAt),
    row("Deleted at", data.deletedAt),
    row("Retention cost", usd(data.retentionCostUsd)),
    row("Final metering", data.finalMeteringStatus),
    row("R2 disposition", data.r2DispositionStatus),
    row("Legal hold", data.legalHold),
    row("Payment in flight", data.paymentInFlight),
    row("Approval", data.approvalStatus),
    row("Available actions", data.availableActions),
  ];
}

const FORMATTERS: Record<
  WorkerBillingQueryKind,
  (data: RecordValue) => string[]
> = {
  prices,
  overview,
  usage,
  ledger,
  forecast,
  risk,
  lifecycle,
};

export function workerBillingOutputMode(
  flags: Record<string, string>,
): WorkerBillingOutputMode {
  if (Object.hasOwn(flags, "json")) {
    if (flags.json !== "true")
      throw new Error("--json does not accept a value");
    if (Object.hasOwn(flags, "format")) {
      throw new Error("--json cannot be combined with --format");
    }
    return "json";
  }
  if (flags.format === "json") return "json";
  return "human";
}

export function formatWorkerBillingResponse(
  kind: WorkerBillingQueryKind,
  responseValue: unknown,
): string {
  const response = record(responseValue);
  const data = record(response.data);
  return [
    `xAPI Worker Billing · ${kind[0].toUpperCase()}${kind.slice(1)}`,
    RULE,
    row("Worker", response.workerId),
    row("Environment", response.environment),
    row("Snapshot", response.snapshotId),
    row("Snapshot time", response.snapshotTime),
    ...qualityLines(response),
    "",
    ...FORMATTERS[kind](data),
    RULE,
  ].join("\n");
}

export function printWorkerBillingResponse(
  kind: WorkerBillingQueryKind,
  response: unknown,
  mode: WorkerBillingOutputMode,
): void {
  console.log(formatWorkerBillingOutput(kind, response, mode));
}

export function formatWorkerBillingOutput(
  kind: WorkerBillingQueryKind,
  response: unknown,
  mode: WorkerBillingOutputMode,
): string {
  return mode === "json"
    ? JSON.stringify(response)
    : formatWorkerBillingResponse(kind, response);
}
