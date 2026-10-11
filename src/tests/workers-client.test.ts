import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  createWorker,
  createWorkerBuild,
  createWorkerResource,
  createWorkerSchedule,
  deployWorker,
  putWorkerSecret,
  listWorkers,
  getWorkerVariableState,
  getWorkerArtifactVariableConfiguration,
  getWorkerArtifact,
  runWorkerScheduleNow,
  listWorkerDomains,
  createWorkerDomainChallenge,
  attachWorkerDomain,
  applyWorkerSecrets,
  deleteWorkerDomain,
  retryWorkerDomain,
  rollbackWorker,
  workerBillingStatus,
  workerBillingQuery,
  workerInvocationLogs,
  workerProviderCapabilities,
  workerSecretProviderStatus,
  workerRuntimeLogs,
  workerUsage,
  workerMeteredUsage,
  uploadWorkerArtifact,
  updateWorkerEnvironment,
  workerRetention,
  deleteWorker,
  WorkerWriteUnknownError,
} from "../workers-client.ts";
import { RequestTimeoutError } from "../client.ts";

const options = { apiHost: "test.xapi.to", apiKey: "sk-test-value" };
let fetchSpy: ReturnType<typeof spyOn> | undefined;

afterEach(() => fetchSpy?.mockRestore());

describe("workers client", () => {
  it("reads target variable state and immutable declarations through scoped endpoints", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => new Response("{}", {
      status: 200, headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch) as any;
    await getWorkerVariableState(options, "worker/1", "production");
    await getWorkerArtifactVariableConfiguration(options, "worker/1", "artifact/1");
    await getWorkerArtifact(options, "worker/1", "artifact/1");
    expect(fetchSpy.mock.calls.map((call: any[]) => call[0])).toEqual([
      "https://test.xapi.to/api/v1/workers/worker%2F1/environments/production/variables",
      "https://test.xapi.to/api/v1/workers/worker%2F1/artifacts/artifact%2F1/variable-configuration",
      "https://test.xapi.to/api/v1/workers/worker%2F1/artifacts/artifact%2F1",
    ]);
    for (const [, init] of fetchSpy.mock.calls as any[]) {
      expect(init.headers["XAPI-KEY"]).toBe(options.apiKey);
      expect(init.redirect).toBe("manual");
      expect(init.body).toBeUndefined();
    }
  });

  it("reports an unknown whole-Worker deletion without replaying the write", async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new RequestTimeoutError(120_000)) as any;
    await expect(deleteWorker(options, 'worker-1')).rejects.toThrow('Worker deletion result is UNKNOWN');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [target, init] = fetchSpy.mock.calls[0] as any[];
    expect(target).toEndWith('/worker-1');
    expect(init.method).toBe('DELETE');
  });
  for (const action of ['resume', 'delete', 'whole-worker-delete']) {
    for (const code of ['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'UND_ERR_HEADERS_OVERFLOW', 'FUTURE_TRANSPORT_FAILURE']) {
      it(`preserves ${code} and read-only recovery for ${action} without replay`, async () => {
        const cause = Object.assign(new Error('socket disconnected'), { code });
        const original = new TypeError('fetch failed', { cause });
        fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(original) as any;
        const pending = action === 'whole-worker-delete'
          ? deleteWorker(options, 'worker-1')
          : workerRetention(options, 'worker-1', 'preview', '/actions', { action });
        const error = await pending.catch(error => error);
        expect(error).toBeInstanceOf(WorkerWriteUnknownError);
        if (!(error instanceof WorkerWriteUnknownError)) throw error;
        expect(error.cause).toBe(original);
        expect((error.cause as Error).cause).toBe(cause);
        expect(error.code).toBe(code);
        expect(error.message).toContain(code);
        expect(error.message).toContain(action === 'whole-worker-delete'
          ? 'xapi workers get worker-1 --format json'
          : 'xapi workers retention show worker-1 --env preview --format json');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });
    }
  }
  for (const original of [
    new TypeError('invalid request option'),
    new TypeError('fetch failed', { cause: Object.assign(new Error('invalid onError method'), { code: 'UND_ERR_INVALID_ARG' }) }),
    Object.assign(new Error('application validation failed'), { code: 'CUSTOM_VALIDATION' }),
    new TypeError('fetch failed', { cause: Object.assign(new Error('invalid argument'), { code: 'ERR_INVALID_ARG_VALUE' }) }),
    new DOMException('cancelled', 'AbortError'),
    new SyntaxError('invalid JSON'),
  ]) {
    it(`preserves non-transport failure ${original.message}`, async () => {
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(original) as any;
      expect(await deleteWorker(options, 'worker-1').catch(error => error)).toBe(original);
      expect(await workerRetention(options, 'worker-1', 'preview', '/actions', { action: 'resume' }).catch(error => error)).toBe(original);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  }
  it('does not relabel a non-lifecycle retention write', async () => {
    const original = new TypeError('fetch failed');
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(original) as any;
    expect(await workerRetention(options, 'worker-1', 'preview', '/accept', {}).catch(error => error)).toBe(original);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("preserves upstream whole-Worker deletion conflicts", async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('upstream conflict', { status: 409 })) as any;
    await expect(deleteWorker(options, 'worker-1')).rejects.toThrow('HTTP 409: upstream conflict');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it("reports a lost lifecycle response as unknown and never replays the write", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new RequestTimeoutError(120_000)) as any;
    await expect(workerRetention(options, "worker-1", "preview", "/actions", { action: "delete" }))
      .rejects.toThrow("result is UNKNOWN");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [target, init] = fetchSpy.mock.calls[0] as any[];
    expect(target).toEndWith("/worker-1/environments/preview/retention/actions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ action: "delete" });
  });

  it("preserves explicit upstream lifecycle errors instead of calling them unknown", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("workflow is running", { status: 409 })) as any;
    await expect(workerRetention(options, "worker-1", "preview", "/actions", { action: "delete" }))
      .rejects.toThrow("HTTP 409: workflow is running");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it("applies secret mutations without retrying or exposing values in the URL", async () => {
    fetchSpy = spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({status:"ACTIVE"}),{status:200,headers:{"content-type":"application/json"}})) as any;
    await applyWorkerSecrets(options,"worker/1","preview",[{name:"MODEL_KEY",value:"private-value"},{name:"OLD_KEY",delete:true}]);
    const [target,init]=fetchSpy.mock.calls[0] as any[];
    expect(target).toBe("https://test.xapi.to/api/v1/workers/worker%2F1/environments/preview/secrets");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({secrets:[{name:"MODEL_KEY",value:"private-value"},{name:"OLD_KEY",delete:true}]});
    expect(target).not.toContain("private-value");
  });

  it("reads provider secret status without values", async () => {
    fetchSpy = spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({secrets:[{bindingName:"MODEL_KEY",providerPresent:true}]}),{status:200,headers:{"content-type":"application/json"}})) as any;
    await workerSecretProviderStatus(options,"worker/1","production");
    expect(fetchSpy.mock.calls[0][0]).toBe("https://test.xapi.to/api/v1/workers/worker%2F1/environments/production/secrets/provider-status");
  });
  it("reads scoped source windows with the original xAPI authentication", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ storageCollection: { items: [] } }), { status: 200, headers: { "content-type": "application/json" } })) as any;
    await workerMeteredUsage(options, "worker/1", "preview");
    const [url, init] = fetchSpy.mock.calls[0] as any[];
    expect(url).toBe("https://test.xapi.to/api/v1/workers/worker%2F1/environments/preview/metered-usage");
    expect(init.headers["XAPI-KEY"]).toBe("sk-test-value");
    expect(init.redirect).toBe("manual");
  });
  it("lists Workers through the versioned test API with the scoped key header", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([{ id: "worker-1" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;

    await expect(listWorkers(options)).resolves.toEqual([{ id: "worker-1" }]);
    const [url, init] = fetchSpy.mock.calls[0] as any[];
    expect(url).toBe("https://test.xapi.to/api/v1/workers");
    expect(init.headers["XAPI-KEY"]).toBe("sk-test-value");
    expect(init.redirect).toBe("manual");
  });

  it("sends create input as JSON without automatic write retries", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "worker-2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;
    const body = {
      name: "Agent",
      slug: "agent",
      previewDailyBudgetUsd: 0.25,
      productionDailyBudgetUsd: 2,
    };
    await createWorker(options, body);
    const [, init] = fetchSpy.mock.calls[0] as any[];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(body);
  });

  it("targets the requested Worker deployment endpoint", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ACTIVE" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;
    await deployWorker(options, "worker/id", {
      environment: "preview",
      artifactId: "artifact-1",
      idempotencyKey: "showcase-v1",
    });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://test.xapi.to/api/v1/workers/worker%2Fid/deployments",
    );
  });

  it("targets the environment-scoped rollback endpoint with a stable retry key", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "ACTIVE" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;
    await rollbackWorker(options, "worker/id", "production", {
      deploymentId: "deployment-1",
      idempotencyKey: "rollback-key-1",
    });
    const [target, init] = fetchSpy.mock.calls[0] as any[];
    expect(target).toBe(
      "https://test.xapi.to/api/v1/workers/worker%2Fid/environments/production/rollback",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      deploymentId: "deployment-1",
      idempotencyKey: "rollback-key-1",
    });
  });

  it("uploads a bundled module as an immutable artifact", async () => {
    let uploaded: any;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (target:any, init:any) => {
      if (String(target).endsWith('/artifact-provider/status')) return Response.json({directUpload:false});
      uploaded = await new Request(target, init).json();
      return Response.json({id:"artifact-1"});
    }) as any);
    await uploadWorkerArtifact(options, "worker/id", {
      moduleCode: "export default {}",
      idempotencyKey: "showcase-upload-v1",
    });
    const [target, init] = fetchSpy.mock.calls[1] as any[];
    expect(target).toBe(
      "https://test.xapi.to/api/v1/workers/worker%2Fid/artifacts",
    );
    expect(uploaded.idempotencyKey).toBe("showcase-upload-v1");
  });

  it("uploads a multi-module bundle in one immutable artifact request", async () => {
    let uploaded: any;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (target:any, init:any) => {
      if (String(target).endsWith('/artifact-provider/status')) return Response.json({directUpload:false});
      uploaded = await new Request(target, init).json();
      return Response.json({id:"artifact-2"});
    }) as any);
    const bundle = {
      version: 1 as const,
      mainModule: "worker.js",
      modules: [
        {
          path: "worker.js",
          content: 'import "./chunk.js"; export default {};',
          encoding: "utf8" as const,
          contentType: "application/javascript+module" as const,
        },
        {
          path: "chunk.js",
          content: "export {};",
          encoding: "utf8" as const,
          contentType: "application/javascript+module" as const,
        },
      ],
    };
    await uploadWorkerArtifact(options, "worker/id", {
      bundle,
      idempotencyKey: "showcase-bundle-v1",
    });
    expect(uploaded).toEqual({
      bundle,
      idempotencyKey: "showcase-bundle-v1",
    });
  });

  it("updates native environment placement without changing unspecified settings", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ placementMode: "smart" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;
    await updateWorkerEnvironment(options, "worker/id", "preview", {
      defaultResourceLocation: "apac",
      placementMode: "smart",
    });
    const [target, init] = fetchSpy.mock.calls[0] as any[];
    expect(target).toBe("https://test.xapi.to/api/v1/workers/worker%2Fid/environments/preview");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      defaultResourceLocation: "apac",
      placementMode: "smart",
    });
  });

  it("preserves explicit Artifact rejection and never retries on a legacy endpoint", async () => {
    let uploaded: any;
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (target: any, init: any) => {
      if (String(target).endsWith('/artifact-provider/status'))return Response.json({directUpload:false});
      uploaded = await new Request(target, init).json();
      return Response.json({message:'Cannot POST /artifacts'},{status:404});
    }) as typeof fetch) as any;
    const input = {bundle:{version:1 as const,mainModule:'worker.js',modules:[{
      path:'worker.js',content:'export default {};',encoding:'utf8' as const,contentType:'application/javascript+module' as const,
    }]},idempotencyKey:'explicit-rejection'};
    await expect(uploadWorkerArtifact(options,'worker/id',input)).rejects.toThrow('HTTP 404');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toEndWith('/artifact-provider/status');
    expect(fetchSpy.mock.calls[1][0]).toEndWith('/artifacts');
    expect(fetchSpy.mock.calls[1][1].method).toBe('POST');
    expect(uploaded).toEqual(input);
  });

  it("keeps a large bundle on its multipart channel without a legacy-size user gate", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (target: any,init:any) => {
      if(String(target).endsWith('/artifact-provider/status'))return Response.json({directUpload:false});
      expect(String(target)).toEndWith('/artifacts/bundle');
      expect(new Headers(init.headers).get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
      expect(init.body instanceof ReadableStream).toBe(true);
      return Response.json({message:'Cannot POST /artifacts/bundle'},{status:404});
    }) as typeof fetch) as any;
    const input={bundle:{version:1 as const,mainModule:'worker.js',modules:[{
      path:'worker.js',content:Buffer.alloc(14*1024*1024).toString('base64'),encoding:'base64' as const,contentType:'application/javascript+module' as const,
    }]},idempotencyKey:'large-upstream-rejection'};
    await expect(uploadWorkerArtifact(options,'worker/id',input)).rejects.toThrow('HTTP 404');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("uses the server-side build endpoint with an extended timeout", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "build-1", status: "SUCCEEDED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;
    await createWorkerBuild(options, "worker/id", {
      files: [
        {
          path: "src/index.ts",
          content: "export default {}",
          encoding: "utf8",
        },
      ],
      entrypoint: "src/index.ts",
      buildCommand: "npm run build",
      outputPath: "dist/index.mjs",
      idempotencyKey: "showcase-build-v1",
    });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://test.xapi.to/api/v1/workers/worker%2Fid/builds",
    );
  });

  it("creates an environment-isolated managed resource", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "resource-1", status: "ACTIVE" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;
    await createWorkerResource(options, "worker/id", "production", {
      type: "kv_namespace",
      bindingName: "STATE",
    });
    const [target, init] = fetchSpy.mock.calls[0] as any[];
    expect(target).toBe(
      "https://test.xapi.to/api/v1/workers/worker%2Fid/environments/production/resources",
    );
    expect(JSON.parse(init.body)).toEqual({
      type: "kv_namespace",
      bindingName: "STATE",
    });
  });

  it("sends a secret only in the JSON request body", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ bindingName: "MODEL_KEY", version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;
    await putWorkerSecret(
      options,
      "worker/id",
      "preview",
      "MODEL_KEY",
      "private-value",
    );
    const [target, init] = fetchSpy.mock.calls[0] as any[];
    expect(target).toBe(
      "https://test.xapi.to/api/v1/workers/worker%2Fid/environments/preview/secrets/MODEL_KEY",
    );
    expect(target).not.toContain("private-value");
    expect(JSON.parse(init.body)).toEqual({ value: "private-value" });
  });

  it("reads environment-isolated invocation metadata", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ items: [], contentCaptured: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as any;
    await workerInvocationLogs(options, "worker/id", "preview");
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://test.xapi.to/api/v1/workers/worker%2Fid/environments/preview/invocations",
    );
  });

  it("reads runtime telemetry, usage, domains, and provider capabilities", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as any,
    ) as any;

    await workerRuntimeLogs(options, "worker/id", "production");
    await workerUsage(options, "worker/id", "production");
    await workerUsage(options, "worker/id");
    await workerBillingStatus(options);
    await listWorkerDomains(options, "worker/id");
    await retryWorkerDomain(options, "worker/id", "domain/id");
    await workerProviderCapabilities(options);

    expect(fetchSpy.mock.calls.map((call: any[]) => call[0])).toEqual([
      "https://test.xapi.to/api/v1/workers/worker%2Fid/environments/production/runtime-logs",
      "https://test.xapi.to/api/v1/workers/worker%2Fid/environments/production/usage",
      "https://test.xapi.to/api/v1/workers/worker%2Fid/usage",
      "https://test.xapi.to/api/v1/workers/billing/status",
      "https://test.xapi.to/api/v1/workers/worker%2Fid/domains",
      "https://test.xapi.to/api/v1/workers/worker%2Fid/domains/domain%2Fid/retry",
      "https://test.xapi.to/api/v1/workers/provider/capabilities",
    ]);
    expect((fetchSpy.mock.calls[5][1] as RequestInit).method).toBe("POST");
  });

  it("creates, attaches, and removes a DNS-verified custom domain", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as any,
    ) as any;

    await createWorkerDomainChallenge(
      options,
      "worker/id",
      "preview",
      "kanby.example.com",
    );
    await attachWorkerDomain(options, "worker/id", "signed.challenge");
    await deleteWorkerDomain(options, "worker/id", "domain/id");

    expect(fetchSpy.mock.calls.map((call: any[]) => call[0])).toEqual([
      "https://test.xapi.to/api/v1/workers/worker%2Fid/domains/challenges",
      "https://test.xapi.to/api/v1/workers/worker%2Fid/domains",
      "https://test.xapi.to/api/v1/workers/worker%2Fid/domains/domain%2Fid",
    ]);
    expect(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      environment: "preview",
      hostname: "kanby.example.com",
    });
    expect((fetchSpy.mock.calls[2][1] as RequestInit).method).toBe("DELETE");
  });

  it("targets every environment billing family and preserves an opaque ledger cursor", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ schemaVersion: 1, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as any,
    ) as any;

    for (const kind of [
      "prices",
      "overview",
      "usage",
      "ledger",
      "forecast",
      "risk",
      "lifecycle",
    ] as const) {
      await workerBillingQuery(options, "worker/id", "production", kind);
    }
    await workerBillingQuery(options, "worker/id", "preview", "ledger", {
      snapshotTime: "2026-09-02T12:00:00.000Z",
      cursor: "opaque+/= cursor.do-not-decode",
      limit: "25",
      metric: "WORKER_REQUEST",
      resourceId: "resource/id",
    });

    expect(
      fetchSpy.mock.calls.slice(0, 7).map((call: any[]) => call[0]),
    ).toEqual(
      [
        "prices",
        "overview",
        "usage",
        "ledger",
        "forecast",
        "risk",
        "lifecycle",
      ].map(
        (kind) =>
          `https://test.xapi.to/api/v1/workers/worker%2Fid/environments/production/billing/${kind}`,
      ),
    );
    const ledgerUrl = new URL(fetchSpy.mock.calls[7][0] as string);
    expect(ledgerUrl.pathname).toBe(
      "/api/v1/workers/worker%2Fid/environments/preview/billing/ledger",
    );
    expect(Object.fromEntries(ledgerUrl.searchParams)).toEqual({
      snapshotTime: "2026-09-02T12:00:00.000Z",
      cursor: "opaque+/= cursor.do-not-decode",
      limit: "25",
      metric: "WORKER_REQUEST",
      resourceId: "resource/id",
    });
  });

  it("creates and immediately runs a persistent Worker schedule", async () => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify({ id: "run-1", status: "SUCCEEDED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    ) as any;
    await createWorkerSchedule(options, "worker/id", {
      name: "heartbeat",
      environment: "PREVIEW",
      cron: "*/15 * * * *",
      timezone: "UTC",
      method: "POST",
      path: "/cron",
    });
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://test.xapi.to/api/v1/workers/worker%2Fid/schedules",
    );
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("POST");

    await runWorkerScheduleNow(options, "worker/id", "schedule/id");
    expect(fetchSpy.mock.calls[1][0]).toBe(
      "https://test.xapi.to/api/v1/workers/worker%2Fid/schedules/schedule%2Fid/run",
    );
    expect((fetchSpy.mock.calls[1][1] as RequestInit).method).toBe("POST");
  });
});

it('uploads a large binary bundle over multipart with the server manifest protocol and unchanged bytes', async () => {
  const bytes = Buffer.alloc(14 * 1024 * 1024, 7);
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (target: any, init: any) => {
    if(String(target).endsWith('/artifact-provider/status'))return new Response(JSON.stringify({directUpload:false}));
    expect(target).toBe('https://test.xapi.to/api/v1/workers/worker%2Fid/artifacts/bundle');
    expect(new Headers(init.headers).get('XAPI-KEY')).toBe(options.apiKey);
    expect(new Headers(init.headers).get('Content-Type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(init.redirect).toBe('manual');
    // Serialize the real Request body before parsing its multipart wire format.
    const outgoing = new Request(target, init);
    const body = await outgoing.arrayBuffer();
    const parsed = await new Response(body, { headers: { 'Content-Type': outgoing.headers.get('Content-Type')! } }).formData();
    const manifest = JSON.parse(String(parsed.get('manifest')));
    expect(manifest.version).toBe(2); expect(manifest.idempotencyKey).toBe('multipart-upload-v1');
    expect(manifest.modules).toEqual([
      { path:'worker.js',contentType:'application/javascript+module',fileIndex:0 },
      { path:'data.bin',contentType:'application/octet-stream',fileIndex:1 },
    ]);
    const files = parsed.getAll('files') as File[];
    expect(await files[0].text()).toBe('export default {};');
    expect(Buffer.from(await files[1].arrayBuffer()).equals(bytes)).toBe(true);
    expect(manifest.modules.some((m: any) => 'content' in m)).toBe(false);
    return new Response(JSON.stringify({id:'multipart-artifact'}),{headers:{'Content-Type':'application/json'}});
  }) as any);
  await expect(uploadWorkerArtifact(options,'worker/id',{idempotencyKey:'multipart-upload-v1',bundle:{version:1,mainModule:'worker.js',modules:[
    {path:'worker.js',content:'export default {};',encoding:'utf8',contentType:'application/javascript+module'},
    {path:'data.bin',content:bytes.toString('base64'),encoding:'base64',contentType:'application/octet-stream'},
  ]}})).resolves.toEqual({id:'multipart-artifact'});
});
