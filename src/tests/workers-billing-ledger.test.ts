import { describe, expect, it } from "bun:test";
import { collectWorkerBillingLedger } from "../workers-billing-ledger.ts";
import type { WorkerBillingQuery } from "../workers-client.ts";

const snapshotTime = "2026-09-11T12:38:46.837Z";
const page = (id: string, hasMore = false, nextCursor: string | null = null) => ({
  workerId: "worker", environment: "preview", snapshotTime, dataQuality: "PARTIAL",
  data: { entries: [{ id, amountUsd: "-0.00000001" }], hasMore, nextCursor },
});

describe("complete billing ledger", () => {
  it("pins the first snapshot, preserves filters and exact amounts without upgrading quality", async () => {
    const calls: WorkerBillingQuery[] = [];
    const result = await collectWorkerBillingLedger(async query => {
      calls.push(query);
      return calls.length === 1 ? page("one", true, "opaque+/=") : page("two");
    }, { metric: "WORKER_CPU_MS", resourceId: "resource" });
    expect(calls).toEqual([
      { metric: "WORKER_CPU_MS", resourceId: "resource", limit: "100", snapshotTime: undefined, cursor: undefined },
      { metric: "WORKER_CPU_MS", resourceId: "resource", limit: "100", snapshotTime, cursor: "opaque+/=" },
    ]);
    expect(result.data.entries.map((e: any) => e.amountUsd)).toEqual(["-0.00000001", "-0.00000001"]);
    expect(result.data.hasMore).toBe(false);
    expect(result.pagination).toEqual({ pages: 2, entries: 2, complete: true, pageSnapshotIds: [null, null] });
    expect(result.dataQuality).toBe("PARTIAL");
  });

  it("accepts equivalent ISO timestamp representations and pins the returned form", async () => {
    const result = await collectWorkerBillingLedger(async () => page("one"), { snapshotTime: "2026-09-11T20:38:46.837+08:00" });
    expect(result.snapshotTime).toBe(snapshotTime);
  });

  it("handles an empty first page", async () => {
    const result = await collectWorkerBillingLedger(async () => ({ ...page(""), data: { entries: [], hasMore: false, nextCursor: null } }));
    expect(result.pagination.entries).toBe(0);
  });

  it.each([
    ["snapshot changed", { ...page("two"), snapshotTime: "2026-09-12T00:00:00Z" }, "snapshot changed"],
    ["scope changed", { ...page("two"), environment: "production" }, "scope changed"],
    ["duplicate entry", page("one"), "duplicate ledger entry"],
    ["missing cursor", page("two", true), "Missing or repeated ledger cursor"],
    ["repeated cursor", page("two", true, "cursor"), "Missing or repeated ledger cursor"],
    ["invalid page", {}, "Invalid ledger page"],
  ])("rejects %s instead of emitting partial success", async (_label, second, error) => {
    let calls = 0;
    await expect(collectWorkerBillingLedger(async () => ++calls === 1 ? page("one", true, "cursor") : second)).rejects.toThrow(error as string);
  });

  it("bounds pages and propagates API failures", async () => {
    await expect(collectWorkerBillingLedger(async () => page("one", true, "cursor"), {}, 1)).rejects.toThrow("exceeds 1 pages");
    await expect(collectWorkerBillingLedger(async () => { throw new Error("HTTP 503"); })).rejects.toThrow("HTTP 503");
  });

  it("rejects a starting cursor and mismatching explicit snapshot", async () => {
    await expect(collectWorkerBillingLedger(async () => page("one"), { cursor: "cursor" })).rejects.toThrow("cannot be combined");
    await expect(collectWorkerBillingLedger(async () => page("one"), { snapshotTime: "other" })).rejects.toThrow("snapshot changed");
  });
});
