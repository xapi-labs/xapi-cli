# Resources and real acceptance

Run `workers capabilities` and `workers resources list <worker-id> --env preview --format json`. Permissions, availability, and price configuration are independent: provisioned alone does not mean priced or exercised.

Keep resource declarations driven by application behavior. R2, D1, KV, Durable Objects, Queues, and Workflows are independent bindings; none must be added or deleted just because another resource is used. When the goal is to verify every platform resource, use a separate disposable acceptance Worker so those checks cannot change a real application's storage or lifecycle.

Prefer declarations plus plan/push. For granular provisioning:

```sh
xapi workers resources create <worker-id> --env preview --type kv --binding PREFERENCES
xapi workers resources create <worker-id> --env preview --type d1 --binding DB
xapi workers resources create <worker-id> --env preview --type r2 --binding FILES
xapi workers resources create <worker-id> --env preview --type do --binding COORDINATOR --class-name Coordinator
xapi workers resources create <worker-id> --env preview --type queue --binding JOBS
xapi workers resources create <worker-id> --env preview --type workflow --binding PIPELINE
```

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

Queue uses a managed consumer that routes an envelope to the same Worker environment:

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
