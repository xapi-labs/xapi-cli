import { describe, expect, it } from "bun:test";
import { formatWorkerBillingOutput } from "../workers-billing-output.ts";
import { formatWorkerInspection } from "../workers-inspect-output.ts";
import type { WorkerInspection } from "../workers-inspect.ts";
import {
  formatWorkerRetentionGuidance,
  reportedDomainHttpsUrl,
  reportedHttpsUrl,
  workerLifecycleGuidance,
  workerReadOnlyFollowups,
} from "../workers-operation-guidance.ts";

const target = { workerId: "worker-1", environment: "preview" };

describe("lifecycle observation guidance", () => {
  it("keeps an accepted delete pending through recorded progress", () => {
    const accepted = formatWorkerRetentionGuidance({
      ...target, action: "delete", response: { state: "ACCEPTED" },
    });
    expect(accepted).toContain("Request acceptance is not proof of lifecycle completion");
    expect(accepted).toContain("work is pending");
    for (const state of ["REQUESTED", "PENDING_DELETION", "DELETING"]) {
      const response = {
        ...target, dataQuality: "PARTIAL", completeThrough: null,
        data: {
          state, phase: "COMPLETED", completedSteps: 3, totalSteps: 3,
          nextStep: null, blockerCodes: [],
        },
      };
      const human = formatWorkerBillingOutput("lifecycle", response, "human");
      expect(human).toContain("3 / 3");
      expect(human).toContain("work is pending");
      expect(human).toContain("not an exhaustive plan");
      expect(human).toContain("does not prove the whole operation is done");
      expect(human).toContain("xapi workers billing lifecycle worker-1 --env preview");
      expect(JSON.parse(formatWorkerBillingOutput("lifecycle", response, "json"))).toEqual(response);
    }
  });

  it("preserves unknown lifecycle and collector freshness even with COMPLETE quality", () => {
    const response = {
      ...target, dataQuality: "COMPLETE", completeThrough: null,
      data: { state: null, phase: null, completedSteps: 0, totalSteps: 0, retentionCostUsd: null },
    };
    const human = formatWorkerBillingOutput("lifecycle", response, "human");
    expect(human).toContain("Lifecycle completion is unknown");
    expect(human).toContain("Collector freshness is unknown");
    expect(human).toContain("not zero usage or zero cost");
    expect(human).toContain("Retention cost          —");
    expect(human).not.toContain("$0");
    for (const data of [null, {}, { state: "FUTURE_STATE" }]) {
      expect(workerLifecycleGuidance(data).join("\n")).toContain("completion is unknown");
    }
  });

  it("exposes failed-step evidence without replaying changes or promising rollback", () => {
    const response = {
      ...target, data: {
        state: "DELETING", phase: "DELETE", completedSteps: 1, totalSteps: 2,
        nextStep: "delete_r2", blockerCodes: ["R2_NOT_EMPTY", "FINAL_METERING_PENDING"],
      },
    };
    const human = formatWorkerBillingOutput("lifecycle", response, "human");
    expect(human).toContain("Next recorded unfinished step: delete_r2");
    expect(human).toContain("Reported blockers: R2_NOT_EMPTY, FINAL_METERING_PENDING");
    expect(human).toContain("repeating a mutation is not a status check");
    expect(human).not.toContain("xapi workers retention delete");
    for (const state of ["FAILED", "TIMED_OUT"]) {
      expect(workerLifecycleGuidance({ state }).join("\n")).toContain("failure does not prove rollback");
    }
  });

  it("distinguishes paused storage and reported deletion from a refund", () => {
    for (const action of ["show", "pause", "keep-paused"] as const) {
      const response = Object.freeze({ lifecycle: Object.freeze({ state: "SUSPENDED_GRACE" }) });
      const human = formatWorkerRetentionGuidance({ ...target, action, response });
      expect(human).toContain("Retained storage is not deleted or refunded by pausing");
      expect(human).toContain("retention charges may continue");
      expect(human).toContain("xapi workers retention show worker-1 --env preview");
      expect(response.lifecycle.state).toBe("SUSPENDED_GRACE");
    }
    expect(workerLifecycleGuidance({ state: "DELETED" }).join("\n"))
      .toContain("this state alone is not refund evidence");
  });

  it("makes bounded observation explicit only when polling actually ended", () => {
    const options = { ...target, action: "resume" as const, response: { state: "RESUMING" } };
    expect(formatWorkerRetentionGuidance(options)).not.toContain("Local polling ended");
    const ended = formatWorkerRetentionGuidance({ ...options, pollingEnded: true });
    expect(ended).toContain("does not cancel the backend operation");
    expect(ended).toContain("xapi workers inspect worker-1 --env preview");
  });

  it("does not turn an ACTIVE resume response or a quote into completion evidence", () => {
    expect(formatWorkerRetentionGuidance({ ...target, action: "resume", response: { state: "ACTIVE" } }))
      .toContain("does not verify public availability or completion");
    expect(formatWorkerRetentionGuidance({ ...target, action: "quote", response: { freezeUsd: "2" } }))
      .toContain("estimate, not a lifecycle completion or refund receipt");
    expect(formatWorkerRetentionGuidance({ ...target, action: "show", response: { enabled: false } }))
      .toContain("does not establish deletion, a refund or zero storage usage");
    expect(formatWorkerRetentionGuidance({ ...target, action: "show", response: { lifecycle: null } }))
      .toContain("completion is unknown");
  });

  it("keeps followups read-only and targeted without inventing missing context", () => {
    expect(workerReadOnlyFollowups({ ...target, environment: "PRODUCTION" })).toEqual([
      "xapi workers billing lifecycle worker-1 --env production",
      "xapi workers retention show worker-1 --env production",
      "xapi workers inspect worker-1 --env production",
    ]);
    expect(workerReadOnlyFollowups({ workerId: "worker-1" })).toEqual([]);
    expect(workerReadOnlyFollowups({ environment: "preview" })).toEqual([]);
    expect(workerReadOnlyFollowups({ ...target, environment: "preview; echo bad" })).toEqual([]);
    expect(workerReadOnlyFollowups({ ...target, workerId: "worker'$(echo bad)" })[0])
      .toBe("xapi workers billing lifecycle 'worker'\\''$(echo bad)' --env preview");
  });
});

function inspection(): WorkerInspection {
  return {
    schemaVersion: 1, mode: "READ_ONLY", controlPlane: "api.example.com",
    worker: { id: "worker-1", status: "ACTIVE" },
    environment: {
      name: "preview", status: "ACTIVE", publicUrl: "https://canonical.example.com",
      dispatchUrl: "https://platform.example.com", webAppReady: false,
    },
    deployment: { id: "deploy-1", status: "ACTIVE" },
    resources: { status: "UNKNOWN", items: [] },
    secrets: { status: "UNKNOWN", items: [] },
    domains: { status: "AVAILABLE", items: [
      { status: "ACTIVE", url: "https://custom.example.com" },
      { status: "ACTIVE", url: "https://custom.example.com" },
      { status: "PENDING", url: "https://pending.example.com" },
      { status: "ACTIVE", hostname: "hostname-only.example.com" },
      { status: "ACTIVE", url: "http://insecure.example.com" },
      { status: "ACTIVE", url: "https://user:password@credential.example.com" },
      { status: "ACTIVE", url: "https://" },
    ] },
    billing: { status: "UNKNOWN" }, diagnostics: [], nextSteps: [],
  };
}

describe("metadata-only inspection output", () => {
  it("shows ACTIVE domain URLs separately without changing canonical URL or readiness", () => {
    const report = inspection();
    const before = JSON.stringify(report);
    const human = formatWorkerInspection(report);
    expect(human).toContain("Public URL             https://canonical.example.com");
    expect(human).toContain("Platform URL           https://platform.example.com");
    expect(human).toContain("Active domain URL      https://custom.example.com");
    expect(human.match(/https:\/\/custom\.example\.com/g)).toHaveLength(1);
    expect(human).not.toContain("pending.example.com");
    expect(human).toContain("Active domain URL      https://hostname-only.example.com");
    expect(human).not.toContain("Active custom URL");
    expect(human).not.toContain("insecure.example.com");
    expect(human).not.toContain("password");
    expect(human).toContain("Web app ready          false");
    expect(human).toContain("unverified (metadata only; no reachability probe)");
    expect(human).toContain("does not verify public availability");
    expect(human).toContain("Collector freshness is unknown");
    expect(JSON.stringify(report)).toBe(before);
  });

  it("does not claim known freshness or show stale domain items when unavailable", () => {
    const report = inspection();
    report.domains.status = "UNKNOWN";
    report.billing = { status: "AVAILABLE", summary: { dataQuality: "COMPLETE", completeThrough: null } };
    report.environment.publicUrl = "javascript:alert(1)";
    report.environment.dispatchUrl = "http://platform.example.com";
    const human = formatWorkerInspection(report);
    expect(human).toContain("Collector freshness is unknown");
    expect(human).not.toContain("https://custom.example.com");
    expect(human).not.toContain("javascript:");
    expect(human).not.toContain("http://platform.example.com");
  });

  it("only accepts explicit HTTPS URLs without credentials or control characters", () => {
    for (const input of [null, 1, "example.com", "//example.com", "https://", "https:///example.com", "https://example.com\n", "https://foo\\bar", "https://user@example.com", "https://example.com:99999"]) {
      expect(reportedHttpsUrl(input)).toBeUndefined();
    }
    expect(reportedHttpsUrl("https://example.com/app?q=1")).toBe("https://example.com/app?q=1");
  });

  it("derives hostname-only URLs without accepting paths, credentials or parser tricks", () => {
    expect(reportedDomainHttpsUrl({ hostname: "Native.Example.com" })).toBe("https://Native.Example.com");
    for (const hostname of ["example.com/path", "user@example.com", "example.com:443", "example.com?query", "example.com#hash", "example.com\n", "-bad.example.com", "a..example.com", "127.1", "foo\\bar.com", `${"a".repeat(64)}.com`]) {
      expect(reportedDomainHttpsUrl({ hostname })).toBeUndefined();
    }
    expect(reportedDomainHttpsUrl({ hostname: "safe.example.com", url: "http://unsafe.example.com" })).toBeUndefined();
  });
});
