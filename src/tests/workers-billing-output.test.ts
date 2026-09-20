import { describe, expect, it } from "bun:test";
import {
  formatWorkerBillingOutput,
  formatWorkerBillingResponse,
  workerBillingOutputMode,
} from "../workers-billing-output.ts";

const envelope = {
  schemaVersion: 1,
  snapshotId: "snapshot-1",
  snapshotTime: "2026-09-02T12:00:00.000Z",
  completeThrough: "2026-09-02T11:55:00.000Z",
  dataQuality: "COMPLETE",
  workerId: "worker-1",
  environment: "production",
} as const;

describe("Worker billing output selection", () => {
  it("defaults to human output independently of TTY state", () => {
    expect(workerBillingOutputMode({})).toBe("human");
    expect(workerBillingOutputMode({ format: "table" })).toBe("human");
    expect(workerBillingOutputMode({ format: "pretty" })).toBe("human");
  });

  it("supports both explicit JSON forms and rejects conflicts deterministically", () => {
    expect(workerBillingOutputMode({ json: "true" })).toBe("json");
    expect(workerBillingOutputMode({ format: "json" })).toBe("json");
    expect(() =>
      workerBillingOutputMode({ json: "true", format: "table" }),
    ).toThrow("--json cannot be combined with --format");
    expect(() => workerBillingOutputMode({ json: "false" })).toThrow(
      "--json does not accept a value",
    );
  });

  it("emits the API object unchanged in JSON mode", () => {
    const fixture = {
      ...envelope,
      completeThrough: null,
      dataQuality: "PARTIAL",
      data: {
        currency: "USD",
        entries: [{ amountUsd: "-0.000000300000000001" }],
        hasMore: true,
        nextCursor: "opaque+/= cursor.do-not-decode",
      },
    };

    expect(
      JSON.parse(formatWorkerBillingOutput("ledger", fixture, "json")),
    ).toEqual(fixture);
  });
});

describe("Worker billing human output", () => {
  it("matches the overview golden without converting or recomputing money", () => {
    const rendered = formatWorkerBillingResponse("overview", {
      ...envelope,
      data: {
        lifecycleState: "LOW_BALANCE",
        dailyBudgetUsd: "10000000000000000000.00000001",
        budgetRemainingUsd: "9999999999999999998.750000309999999999",
        settledUsd: "1.25000000",
        reservedUsd: null,
        estimatedUsd: "-0.000000300000000001",
        exposureUsd: "1.249999700000000001",
        safetyReserveUsd: null,
        ledgerNetUsd: "1.25000000",
        ledgerEntries: 2,
        providerOutage: false,
        reasonCodes: ["LOW_BALANCE"],
        resourceTotals: [
          {
            kind: "worker_runtime",
            resourceCount: 1,
            metrics: ["WORKER_REQUEST"],
            settledLedgerEntries: 2,
            settledUsd: "1.25000000",
            reservedUsd: null,
            estimatedUsd: "0",
            exposureUsd: null,
            dataQuality: "INDETERMINATE",
            reasonCodes: ["ESTIMATED_TOTAL_UNKNOWN"],
          },
        ],
      },
    });

    expect(rendered).toBe(`xAPI Worker Billing · Overview
────────────────────────────────────────────────────────────────────────────────────────
  Worker                  worker-1
  Environment             production
  Snapshot                snapshot-1
  Snapshot time           2026-09-02T12:00:00.000Z
  Data quality            COMPLETE
  Complete through        2026-09-02T11:55:00.000Z

  Lifecycle               LOW_BALANCE
  Daily budget            $10000000000000000000.00000001
  Budget remaining        $9999999999999999998.750000309999999999
  Settled                 $1.25000000
  Reserved                —
  Estimated               $-0.000000300000000001
  Exposure                $1.249999700000000001
  Safety reserve          —
  Ledger net              $1.25000000
  Ledger entries          2
  Provider outage         false
  Reasons                 LOW_BALANCE

Resource totals
${'  Resource        Count  Settled      Reserved  Estimated  Exposure  Quality        Reasons'.padEnd(107)}
  ──────────────  ─────  ───────────  ────────  ─────────  ────────  ─────────────  ───────────────────────
  worker_runtime  1      $1.25000000  —         $0         —         INDETERMINATE  ESTIMATED_TOTAL_UNKNOWN
────────────────────────────────────────────────────────────────────────────────────────`);
    expect(rendered).not.toContain("1e+");
  });

  it("keeps unattributed managed-resource estimates unknown", () => {
    const rendered = formatWorkerBillingResponse("overview", {
      ...envelope,
      data: {
        budgetRemainingUsd: null,
        resourceTotals: [
          {
            kind: "kv",
            resourceCount: 1,
            settledUsd: "0.0002",
            reservedUsd: "0",
            estimatedUsd: null,
            exposureUsd: null,
            dataQuality: "INDETERMINATE",
            reasonCodes: ["ESTIMATED_ATTRIBUTION_NOT_PERSISTED"],
          },
        ],
      },
    });

    expect(rendered).toContain("Budget remaining        —");
    expect(rendered).toContain("$0.0002");
    expect(rendered).toContain("ESTIMATED_ATTRIBUTION_NOT_PERSISTED");
    expect(rendered).not.toContain("$null");
  });

  it("renders explicit gaps, nulls, and incomplete freshness prominently", () => {
    const rendered = formatWorkerBillingResponse("usage", {
      ...envelope,
      completeThrough: null,
      dataQuality: "PARTIAL",
      data: {
        from: "2026-09-02T11:00:00.000Z",
        to: "2026-09-02T12:00:00.000Z",
        bucketCount: 12,
        gapCount: 1,
        partialCount: 1,
        metric: null,
        resourceId: null,
        buckets: [
          {
            start: "2026-09-02T11:00:00.000Z",
            status: "COMPLETE",
            facts: [{ metric: "WORKER_REQUEST", quantity: "7" }],
          },
          {
            start: "2026-09-02T11:05:00.000Z",
            status: "GAP",
            facts: [],
          },
        ],
      },
    });

    expect(rendered).toContain("Data quality            PARTIAL");
    expect(rendered).toContain("Complete through        —");
    expect(rendered).toContain(
      "! PARTIAL: provider data may be delayed or incomplete",
    );
    expect(rendered).toContain("! GAP");
    expect(rendered).toContain("Metric                  —");
    expect(rendered).not.toContain("$0");
  });

  it("renders all eight persisted lifecycle states without assumptions", () => {
    for (const state of [
      "ACTIVE",
      "LOW_BALANCE",
      "SUSPENDING",
      "SUSPENDED_GRACE",
      "RESUMING",
      "PENDING_DELETION",
      "DELETING",
      "DELETED",
    ]) {
      const rendered = formatWorkerBillingResponse("lifecycle", {
        ...envelope,
        data: {
          state,
          reasonCode: null,
          phase: null,
          completedSteps: 0,
          totalSteps: 0,
          nextStep: null,
          blockerCodes: [],
          suspendedAt: null,
          graceDeadlineAt: null,
          deletionEarliestAt: null,
          deletedAt: null,
          retentionCostUsd: null,
          finalMeteringStatus: null,
          r2DispositionStatus: null,
          legalHold: false,
          paymentInFlight: false,
          approvalStatus: "NOT_REQUIRED",
          availableActions: [],
        },
      });
      expect(rendered).toContain(`State                   ${state}`);
      expect(rendered).toContain("Reason                  —");
      expect(rendered).toContain("Retention cost          —");
    }
  });

  it.each([
    ["prices", { version: null, effectiveFrom: null, rates: [] }],
    ["ledger", { entries: [], hasMore: false, nextCursor: null }],
    [
      "forecast",
      {
        spendableUsd: null,
        burnRate1hUsd: null,
        burnRate24hUsd: null,
        burnRateUsdPerHour: null,
        timeToZeroHours: null,
        safetyReserveUsd: null,
        providerDelayReserveUsd: null,
        retentionStorageReserveUsd: null,
        asyncShutdownReserveUsd: null,
        providerOutage: null,
      },
    ],
    [
      "risk",
      { accountRisk: null, environmentExposure: null, apiKeyExposure: null },
    ],
  ] as const)("renders the %s family safely", (kind, data) => {
    const rendered = formatWorkerBillingResponse(kind, { ...envelope, data });
    expect(rendered).toContain(`xAPI Worker Billing`);
    expect(rendered).toContain("Data quality            COMPLETE");
    expect(rendered).not.toContain("undefined");
  });
});

it("distinguishes current customer accrual from platform funding without interpreting legacy totals", () => {
  const rendered = formatWorkerBillingResponse("overview", { ...envelope, data: {
    customerAccruedUsd: "0.00060795", platformRiskUsd: "0.00000001",
    settledUsd: "0.00060796", fundingBreakdownComplete: true,
    settlementMeaning: "NET_ACCRUAL_NOT_FINAL_PROVIDER_INVOICE",
    resourceTotals: [{ kind: "r2", customerAccruedUsd: "0.00021096", settledUsd: "9.99" }],
  } });
  expect(rendered).toContain("Customer accrued        $0.00060795");
  expect(rendered).toContain("Platform funded         $0.00000001");
  expect(rendered).toContain("NET_ACCRUAL_NOT_FINAL_PROVIDER_INVOICE");
  expect(rendered).toContain("$0.00021096");
  expect(rendered).not.toContain("$9.99");
  const unknown = formatWorkerBillingResponse("overview", { ...envelope, data: {
    customerAccruedUsd: null, settledUsd: "9.99",
  } });
  expect(unknown).toContain("Customer accrued        —");
  expect(unknown).not.toContain("$9.99");
});
