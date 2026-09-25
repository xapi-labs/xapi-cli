# Resources and real acceptance

Run `workers capabilities` and `workers resources list <worker-id> --env preview --format json`. Permissions, availability, and price configuration are independent: provisioned alone does not mean priced or exercised.

Keep resource declarations driven by application behavior. R2, D1, KV, Durable Objects, Queues, Workflows, and Container Applications are independent bindings and resources; none must be added or deleted just because another resource is used. A Container Application is the one exception to the generic create command: it is deployment-owned and must reference a Durable Object class in the same Worker. When the goal is to verify every platform resource, use a separate disposable acceptance Worker so those checks cannot change a real application's storage or lifecycle.

Prefer declarations plus plan/push. For granular provisioning:

```sh
xapi workers resources create <worker-id> --env preview --type kv --binding PREFERENCES
xapi workers resources create <worker-id> --env preview --type d1 --binding DB
xapi workers resources create <worker-id> --env preview --type r2 --binding FILES
xapi workers resources create <worker-id> --env preview --type do --binding COORDINATOR --class-name Coordinator
xapi workers resources create <worker-id> --env preview --type queue --binding JOBS
xapi workers resources create <worker-id> --env preview --type workflow --binding PIPELINE --class-name Pipeline
```

Do not run `resources create` for a Container. Declare it in Wrangler and `xapi.worker.json`, then deploy. After deployment, `resources list` exposes a read-only `CONTAINER_APPLICATION` record containing the physical application ID, image, instance type, maximum instances, placement, and rollout receipt. Its binding-like `CONTAINER_<hash>` key is an internal stable identity, not a Worker `env` binding.

Exercise a Container through the application route that causes its controlling Durable Object to start or contact an instance. Verify the business response, Container status, DO coordination state, and four Container usage dimensions separately. Do not conclude that an image runs merely because the application resource exists.

Supply the explicitly accepted retention price version when required. Redeploy after binding changes. Use `env.<BINDING>`; no provider API/S3 credentials belong in application code. Initialize D1 schema through the application's migration mechanism; creation doesn't create tables.

| Resource | Real business check | Evidence |
|---|---|---|
| KV | Save and read a preference; respect eventual consistency | Key, before/after value, timestamps |
| D1 | Create/update/query a business record across separate requests | Record ID and stored result |
| R2 | Upload/download/list/delete a test attachment | Object key, bytes, checksum; only test data deleted |
| Durable Object | Read/write through the same object ID across requests | Object ID and durable result; test alarms separately if used |
| Queue | Enqueue a task and observe its persisted outcome | Stable task ID and consumer result, including retry idempotence |
| Workflow | Start and poll the instance to terminal state | Instance ID, final status and durable result |
| Schedule | Trigger an immediate run and inspect run history | Schedule/run ID and resulting business change |

For a native Workflow, declare `workflows: [{ binding: "PIPELINE", name: "pipeline", class_name: "Pipeline" }]` in Wrangler, export `Pipeline extends WorkflowEntrypoint` from your Worker, and import the configuration with `workers init --from-wrangler`. The xAPI resource declaration must retain `type: "workflow"`, `bindingName: "PIPELINE"`, and `className: "Pipeline"`. The original physical workflow name is remapped to this environment's managed resource. A declaration can be prepared before its first code deployment; it is not yet a completed running Workflow. A binding to another script is not silently imported as a local class.

Start it through `env.PIPELINE.create({ params: { taskId } })`, then poll `env.PIPELINE.get(id).status()` through an authenticated application endpoint and verify its durable output. The same Worker holds the application's bindings and Secret values. A normal new deployment is allowed while an instance waits; Cloudflare owns how the running instance resumes. Do not promise that every step stays on the original application version, and do not add a deployment block for active instances.

For imported native Queue consumers, the managed adapter invokes `queue(batch, env, ctx)` and returns ack/retry decisions to Cloudflare. For an existing compatibility Workflow created without a class declaration, the HTTP adapter instead routes the following envelope to the same Worker environment; do not mistake that route for a native handler:

```js
await env.JOBS.send({ path: "/tasks/report", method: "POST", body: { taskId } });
const job = await env.PIPELINE.create({ params: {
  path: "/tasks/report", method: "POST", body: { taskId }
} });
const state = await (await env.PIPELINE.get(job.id)).status();
```

Use local absolute paths and idempotent task IDs. Queue delivery can repeat; a successful enqueue isn't task completion. Workflow instance creation isn't completion either: poll to `complete`, `errored`, or `terminated`, with a bounded deadline. Don't expose a public administrative test route without application authentication.

```sh
xapi workers schedules create <worker-id> --env preview --name daily-report --cron '0 8 * * *' --timezone Asia/Shanghai --path /tasks/report --method POST --body '{"source":"schedule"}'
xapi workers schedules list <worker-id> --format json
xapi workers schedules run <worker-id> <schedule-id>
xapi workers schedules runs <worker-id> <schedule-id> --format json
xapi workers logs <worker-id> --env preview --request-id <request-id>
```

An immediate run doesn't prove future cron firing. Pause test schedules when finished. Log each resource separately as not connected / connected / exercised / result verified / metering observed / reconciled. Test data must not overwrite existing user content. Correlate operation times and IDs with billing.md; unrelated background traffic can also generate charges.
