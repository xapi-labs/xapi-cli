import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { bindXdomainWorker } from "../workers-domain-bind.ts";

let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => fetchSpy?.mockRestore());

describe("xdomain + Workers binding", () => {
  it("gets every action schema, proves ownership, attaches, and cleans the TXT", async () => {
    const actionIds: string[] = [];
    const calls: string[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async (target: string | URL | Request, init?: RequestInit) => {
        const url = String(target);
        calls.push(url);
        if (url.includes("/v1/actions/") && (!init?.method || init.method === "GET")) {
          actionIds.push(decodeURIComponent(url.split("/").pop() || ""));
          return new Response(JSON.stringify([{ id: actionIds.at(-1) }]), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/v1/actions/execute")) {
          const body = JSON.parse(String(init?.body));
          if (body.action_id === "domain.get") {
            return Response.json({ data: { domainName: "example.com" } });
          }
          if (body.action_id === "dns.upsert") {
            return Response.json({
              data: {
                records: [
                  {
                    record_id: "txt-1",
                    modified_on: "2026-09-20T00:00:00Z",
                    type: "TXT",
                    subdomain: "_xapi-worker-challenge.kanby",
                    value: "xapi-worker-domain=signed.challenge",
                  },
                ],
              },
            });
          }
          if (body.action_id === "dns.delete") {
            return Response.json({ data: { deleted_record_id: "txt-1" } });
          }
        }
        if (url.endsWith("/api/v1/workers/worker-1/domains/challenges")) {
          return Response.json({
            challengeToken: "signed.challenge",
            expiresAt: "2026-09-20T00:10:00Z",
            hostname: "kanby.example.com",
            environment: "preview",
            dns: {
              type: "TXT",
              name: "_xapi-worker-challenge.kanby.example.com",
              value: "xapi-worker-domain=signed.challenge",
              ttl: 60,
            },
          });
        }
        if (url.endsWith("/api/v1/workers/worker-1/domains")) {
          return Response.json({ id: "worker-domain-1", status: "PROVISIONING" });
        }
        return new Response("unexpected", { status: 500 });
      }) as any,
    );

    const result = await bindXdomainWorker({
      workerOptions: { apiHost: "api.test.xapi.to", apiKey: "sk-test" },
      actionOptions: { actionHost: "action.xapi.to", apiKey: "sk-test" },
      workerId: "worker-1",
      environment: "preview",
      domainId: "domain-1",
      subdomain: "kanby",
      waitMs: 1_000,
    });

    expect(actionIds).toEqual([
      "domain.get",
      "dns.upsert",
      "dns.delete",
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        hostname: "kanby.example.com",
        url: "https://kanby.example.com",
        challengeCleanup: { deleted: true, recordId: "txt-1" },
      }),
    );
    expect(calls.some((url) => url.includes("api.test.xapi.to"))).toBe(true);
    expect(calls.some((url) => url.includes("action.xapi.to"))).toBe(true);
  });

  it("removes the temporary ownership TXT when attach fails", async () => {
    const actions: string[] = [];
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async (target: string | URL | Request, init?: RequestInit) => {
        const url = String(target);
        if (url.includes("/v1/actions/") && (!init?.method || init.method === "GET")) {
          return Response.json([{ id: decodeURIComponent(url.split("/").pop() || "") }]);
        }
        if (url.endsWith("/v1/actions/execute")) {
          const body = JSON.parse(String(init?.body));
          actions.push(body.action_id);
          if (body.action_id === "domain.get") {
            return Response.json({ data: { domainName: "example.com" } });
          }
          if (body.action_id === "dns.upsert") {
            return Response.json({
              data: {
                records: [
                  {
                    record_id: "txt-failed-attach",
                    type: "TXT",
                    subdomain: "_xapi-worker-challenge.kanby",
                    value: "xapi-worker-domain=signed.challenge",
                  },
                ],
              },
            });
          }
          if (body.action_id === "dns.delete") {
            return Response.json({ data: { deleted_record_id: "txt-failed-attach" } });
          }
        }
        if (url.endsWith("/api/v1/workers/worker-1/domains/challenges")) {
          return Response.json({
            challengeToken: "signed.challenge",
            dns: { value: "xapi-worker-domain=signed.challenge" },
          });
        }
        if (url.endsWith("/api/v1/workers/worker-1/domains")) {
          return Response.json(
            { message: "domain is already attached" },
            { status: 409 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }) as any,
    );

    await expect(
      bindXdomainWorker({
        workerOptions: { apiHost: "api.test.xapi.to", apiKey: "sk-test" },
        actionOptions: { actionHost: "action.xapi.to", apiKey: "sk-test" },
        workerId: "worker-1",
        environment: "preview",
        domainId: "domain-1",
        subdomain: "kanby",
        waitMs: 0,
      }),
    ).rejects.toThrow();
    expect(actions).toEqual(["domain.get", "dns.upsert", "dns.delete"]);
  });
});
