import { describe, expect, spyOn, test } from "bun:test";
import { checkWorkerHealth, WorkerPushError } from "../workers-push.ts";

const code = "workers_postpaid_state_unavailable";
const unavailable = () => Response.json({ error: { code } }, { status: 503 });

function harness(reply: (attempt: number, init: RequestInit) => Response | Promise<Response>) {
  let time = 0;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  const worker = { id: "worker-id", environments: [
    { id: "preview-id", name: "PREVIEW", publicUrl: "https://example.test/w/ref/preview/" },
    { id: "production-id", name: "PRODUCTION", publicUrl: "https://example.test/w/ref/production" },
  ] };
  const fetchPublic = (async (input, init) => {
    requests.push({ url: String(input), init: init! });
    return reply(requests.length, init!);
  }) as typeof fetch;
  return {
    worker, requests, sleeps,
    advance: (ms: number) => { time += ms; },
    run: (environment: "preview" | "production" = "production", path = "/health?check=1") =>
      checkWorkerHealth(worker, environment, path, fetchPublic, async ms => {
        sleeps.push(ms);
        time += ms;
      }, () => time),
  };
}

async function failure(promise: Promise<unknown>): Promise<WorkerPushError> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(WorkerPushError);
    return error as WorkerPushError;
  }
  throw new Error("Expected health check to fail");
}

describe("Worker public health readiness", () => {
  for (const environment of ["preview", "production"] as const) {
    test(`${environment}: initial authorization can recover after 65 seconds, without changing the URL or credentials`, async () => {
      const h = harness(attempt => attempt <= 65 ? unavailable() : Response.json({ ok: true }));
      expect(await h.run(environment)).toEqual({
        url: `https://example.test/w/ref/${environment}/health?check=1`, status: 200, attempts: 66,
      });
      expect(h.sleeps.reduce((a, b) => a + b, 0)).toBe(65_000);
      for (const request of h.requests) {
        expect(request.url).toBe(`https://example.test/w/ref/${environment}/health?check=1`);
        expect(request.init.method).toBe("GET");
        expect(request.init.redirect).toBe("manual");
        expect([...new Headers(request.init.headers)]).toEqual([["accept", "application/json"]]);
      }
    });
  }

  test("persistent platform failure has a finite ceiling and truthful recovery diagnostics", async () => {
    const h = harness(unavailable);
    const error = await failure(h.run());
    expect(h.requests).toHaveLength(75);
    expect(h.sleeps).toHaveLength(74);
    expect(error.message).toContain("public access authorization is not yet ready");
    expect(error.recovery).toMatchObject({
      deploymentStatus: "ACTIVE", healthReady: false, lastStatus: 503, lastErrorCode: code,
      attempts: 75, elapsedMs: 74_000,
      publicUrl: "https://example.test/w/ref/production",
      healthUrl: "https://example.test/w/ref/production/health?check=1",
    });
    expect(error.recovery.recovery).toContain("read-only GET");
    expect(error.recovery.recovery).toContain("do not republish");
  });

  test("request time consumes the same 75 second budget", async () => {
    const h = harness(attempt => { h.advance(attempt < 8 ? 9_000 : 5_000); return unavailable(); });
    const error = await failure(h.run());
    expect(h.requests).toHaveLength(8);
    expect(error.recovery.elapsedMs).toBe(75_000);
    expect(h.sleeps).toHaveLength(7);
  });

  const ordinary: Array<[string, () => Response]> = [
    ["application 503", () => Response.json({ error: { code: "app_unavailable" } }, { status: 503 })],
    ["code in message", () => Response.json({ error: { message: code } }, { status: 503 })],
    ["wrong envelope", () => Response.json({ code }, { status: 503 })],
    ["wrong code type", () => Response.json({ error: { code: [code] } }, { status: 503 })],
    ["HTML", () => new Response(`<html>${code}</html>`, { status: 503 })],
    ["malformed JSON", () => new Response('{"error":', { status: 503 })],
    ["empty body", () => new Response(null, { status: 503 })],
    ["null JSON", () => Response.json(null, { status: 503 })],
    ["oversized body", () => Response.json({ error: { code }, padding: "x".repeat(8192) }, { status: 503 })],
    ["500 with platform code", () => Response.json({ error: { code } }, { status: 500 })],
    ["404", () => Response.json({ error: { code } }, { status: 404 })],
    ["paused", () => Response.json({ error: { code: "worker_manually_paused" } }, { status: 403 })],
    ["403 with platform code", () => Response.json({ error: { code } }, { status: 403 })],
    ["configuration invalid", () => Response.json({ error: { code: "workers_postpaid_config_invalid" } }, { status: 503 })],
    ["redirect", () => new Response(null, { status: 302, headers: { Location: "https://other.test" } })],
    ["network failure", () => { throw new Error("private transport detail"); }],
  ];
  for (const [label, reply] of ordinary) {
    test(`${label} retains the ordinary 10-attempt limit`, async () => {
      const h = harness(reply);
      const error = await failure(h.run());
      expect(h.requests).toHaveLength(10);
      expect(h.sleeps).toHaveLength(9);
      expect(error.message).toBe("Deployment is ACTIVE but its health check failed");
      expect(error.recovery.lastErrorCode).toBeUndefined();
      expect(error.recovery.healthReady).toBe(false);
      expect(JSON.stringify(error.recovery)).not.toContain("private transport detail");
    });
  }

  test("a later application error does not inherit the platform extension or diagnosis", async () => {
    const h = harness(attempt => attempt <= 12 ? unavailable() : new Response("app failed", { status: 503 }));
    const error = await failure(h.run());
    expect(h.requests).toHaveLength(13);
    expect(error.recovery.lastErrorCode).toBeUndefined();
    expect(error.message).toContain("health check failed");
  });

  test("ordinary transient failure can still recover", async () => {
    const h = harness(attempt => new Response(null, { status: attempt < 3 ? 500 : 204 }));
    expect((await h.run()).attempts).toBe(3);
  });

  test("absolute health paths cannot change the public origin or its routing prefix", async () => {
    const h = harness(() => new Response(null, { status: 204 }));
    expect((await h.run("preview", "https://other.test/health?q=2")).url)
      .toBe("https://example.test/w/ref/preview/health?q=2");
  });

  test("invalid, insecure and missing public URLs fail before fetch", async () => {
    for (const url of ["bad-url", "http://example.test", ""]) {
      const h = harness(unavailable);
      h.worker.environments[1].publicUrl = url;
      await failure(h.run());
      expect(h.requests).toHaveLength(0);
    }
  });

  test("streams are bounded and cancelled, including successful and non-503 bodies", async () => {
    for (const status of [200, 500, 503]) {
      let cancellations = 0;
      let reads = 0;
      const h = harness(() => new Response(new ReadableStream({
        pull(controller) { reads++; controller.enqueue(new Uint8Array(8193)); },
        cancel() { cancellations++; return new Promise(() => {}); },
      }), { status }));
      if (status === 200) await h.run();
      else await failure(h.run());
      expect(cancellations).toBe(h.requests.length);
      expect(reads).toBeLessThanOrEqual(h.requests.length * 2);
    }
  });

  for (const stalled of ["headers", "body"]) {
    test(`stalled ${stalled} is aborted, with the last request clipped to the total deadline`, async () => {
      let cancelled = 0;
      const deadlines: number[] = [];
      const h = harness((_attempt, init) => stalled === "headers"
        ? new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => {
          cancelled++;
          reject(new Error("aborted"));
        }, { once: true }))
        : new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 }));
      const realTimeout = globalThis.setTimeout;
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms: number) => {
        deadlines.push(ms);
        return realTimeout(() => { h.advance(ms); callback(); }, 1);
      }) as typeof setTimeout);
      try {
        const error = await failure(h.run());
        expect(error.recovery.elapsedMs).toBe(75_000);
        expect(h.requests).toHaveLength(7);
        expect(cancelled).toBe(7);
        expect(deadlines).toEqual([10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 9_000]);
        expect(error.recovery.lastStatus).toBe(stalled === "headers" ? 0 : 503);
        expect(error.recovery.lastErrorCode).toBeUndefined();
      } finally { timer.mockRestore(); }
    });
  }
});
