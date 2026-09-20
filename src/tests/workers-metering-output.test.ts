import { describe, expect, it } from "bun:test";
import { formatWorkerMetering } from "../workers-metering-output.ts";
describe("worker metering output", () => {
  it("does not present absent schema or empty windows as zero cost", () => {
    expect(formatWorkerMetering({})).toContain("status unavailable");
    expect(formatWorkerMetering({ storageCollection: { items: [] } })).toContain("does not mean free storage");
  });
  it("keeps missing sample times unknown and explains observed coverage", () => {
    const formatted = formatWorkerMetering({ workerId: "w", environment: "preview", storageCollection: { items: [
      { resourceId: "r1", status: "MISSING", observedSamples: 0, lastSampleAt: null },
      { resourceId: "r2", status: "OBSERVED", observedSamples: 2, lastSampleAt: "2026-09-08T00:00:00Z" },
    ] } });
    expect(formatted).toContain("no sample (not zero usage)");
    expect(formatted).toContain("Samples: 0 · Last sample: —");
    expect(formatted).toContain("Samples observed (not final coverage)");
    expect(formatted).toContain("2026-09-08T00:00:00Z");
    expect(formatted).not.toContain("$0");
  });
  it("shows truncation, unknown state and removes terminal control characters", () => {
    const formatted = formatWorkerMetering({ storageCollection: { truncated: true, items: [{ resourceId: "r\u001b[2J", status: "NEW", errorCode: "error\nline" }] } });
    expect(formatted).toContain("history is incomplete");
    expect(formatted).toContain("Unknown collection status");
    expect(formatted).not.toContain("\u001b");
    expect(formatted).toContain("error line");
  });
});
