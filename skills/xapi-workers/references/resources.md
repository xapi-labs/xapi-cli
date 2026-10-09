# Resources and real acceptance

Use `workers capabilities` as optional read-only diagnosis and `workers resources list <worker-id> --env preview --format json` to inspect ownership. Permissions, availability, and price configuration are independent: provisioned alone does not mean priced or exercised.

Keep resource declarations driven by application behavior. R2, D1, KV, Durable Objects, Queues, Workflows, and Container Applications are independent bindings and resources; none must be added or deleted just because another resource is used. A Container Application is the one exception to the generic create command: it is deployment-owned and must reference a Durable Object class in the same Worker. When the goal is to verify every platform resource, use a separate disposable acceptance Worker so those checks cannot change a real application's storage or lifecycle.

Prefer declarations plus plan/push. For granular provisioning:

```sh
xapi workers resources create <worker-id> --env preview --type kv --binding PREFERENCES
xapi workers resources create <worker-id> --env preview --type d1 --binding DB
xapi workers resources create <worker-id> --env preview --type r2 --binding FILES
xapi workers resources create <worker-id> --env preview --type do --binding COORDINATOR --class-name Coordinator
xapi workers resources create <worker-id> --env preview --type queue --binding JOBS
xapi workers resources create <worker-id> --env preview --type workflow --binding PIPELINE
# Native Workflow: export this class in the Worker code
xapi workers resources create <worker-id> --env preview --type workflow --binding PIPELINE --class-name Pipeline --workflow-name pipeline
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

Queue delivers each complete `message.body` to the same Worker environment's native `default.queue(batch, env, ctx)` handler. Export that handler and perform the business write before ack; the platform does not interpret `path` as an HTTP route. For example:

```js
await env.JOBS.send({ taskId, objectKey: "uploads/report.pdf" });
const job = await env.PIPELINE.create({ params: {
  path: "/tasks/report", method: "POST", body: { taskId }
} });
const state = await (await env.PIPELINE.get(job.id)).status();
```

Workflow HTTP callback paths must be local absolute paths. Use stable task IDs for Queue writes and commit the outcome before `message.ack()`; on failure use `message.retry()` or let the native handler fail. Queue delivery can repeat; a successful enqueue isn't task completion. Workflow instance creation isn't completion either: poll to `complete`, `errored`, or `terminated`, with a bounded deadline. Don't expose a public administrative test route without application authentication.

```sh
xapi workers schedules create <worker-id> --env preview --name daily-report --cron '0 8 * * *' --timezone Asia/Shanghai --path /tasks/report --method POST --body '{"source":"schedule"}'
xapi workers schedules list <worker-id> --format json
xapi workers schedules run <worker-id> <schedule-id>
xapi workers schedules runs <worker-id> <schedule-id> --format json
xapi workers logs <worker-id> --env preview --request-id <request-id>
```

An immediate run doesn't prove future cron firing. Pause test schedules when finished. Log each resource separately as not connected / connected / exercised / result verified / metering observed / reconciled. Test data must not overwrite existing user content. Correlate operation times and IDs with billing.md; unrelated background traffic can also generate charges.

## Apply a newly created binding

Creation records the managed resource; a deployment selects which resource IDs are bound. `workers push` refreshes eligible resource IDs and includes them in the deployment request. For granular `workers deploy`, pass `resourceIds` explicitly when changing bindings; an omitted list preserves the previous deployment selection. Creating a resource and re-deploying the same artifact without selecting it does not attach it automatically. Verify the binding with an actual read/write, not only ACTIVE.

Native Workflow project declarations may include `className` and optional `workflowName`. `plan` and `push` accept a native Workflow in `PROVISIONING` only after the platform confirms its host is prepared; deployment then activates the declaration. `resources pull` preserves these requirements and skips Container application records derived from deployments. Wrangler import preserves Workflow `class_name` while provisioning a new platform-owned identity. Native multipart binding declarations support D1/R2/KV/Queue/DO/Workflow; platform resource IDs and target scripts are resolved from owned project resources, and DO/Workflow classes must match.

Artifact uploads use the backend 64 MiB module and 100 MiB decoded-content budgets, including static assets limited to 25 MiB per file. The CLI automatically selects multipart when JSON/base64 transport or per-module JSON limits would be exceeded; large single files become bundle artifacts with the corresponding canonical bundle identity. The receiver record and metadata budgets still apply.


## Queue identity and producer binding aliases

Several Wrangler producer bindings can refer to one logical Queue. Keep the user binding names unchanged; xAPI creates one owned Queue and one retention hold, with each name pointing to that Queue. Import saves environment `queueBindings` (logical queue name → managed resource binding) for producers, consumers and dead-letter targets. Keep this mapping when producer names are added, removed or renamed; `--force` re-import preserves the linked Worker ID and still-referenced Queue identity. The logical name is not a provider resource ID and does not attach an external account's Queue.

Bundle `queueBindingAliases` survives multipart/manifest uploads. Deployments can override it, including explicit `{}` to clear immutable defaults; promotion of historical v1/v2 bundles explicitly clears missing production aliases. Rollback restores the target configuration without replacing the physical Queue or freezing another alias hold. Deploy the supporting workers-service backend before distributing this CLI capability.

An alias name cannot simultaneously be a Secret or a different resource. The current adapter still lacks migration for reassigning the old primary binding to a different logical Queue while retaining the original Queue under a new name. It reports an explicit mapping error to prevent silently merging the two Queues; record this as an incomplete adapter path, not a user quota. Producer `delivery_delay` needs further adaptation. HTTP Pull consumer management is available through the scoped resource API below; obsolete Wrangler HTTP Pull consumer declarations are not silently converted. Configuration success does not establish actual message delivery, final Queue operation settlement or the CF invoice.

## Native Queue and scheduled handlers

Creating an owned Queue creates only the Queue. It remains associated with the selected Worker/environment and its billing account, running reserve and retention hold; creation does not add a helper Worker or select a consumer. Existing consumers are preserved. `push`/`promote` configure Worker delivery after activation only when the desired project declares `queues.consumers`. A producer-only Queue does not need a `queue()` handler.

### HTTP Pull consumers

HTTP Pull does not require a Worker `queue()` handler or a delivery bridge. Configure it using the Queue management API, not obsolete Wrangler `type: "http_pull"` configuration:

```sh
xapi workers resources queue-consumer configure <worker-id> <resource-id> --env preview \
  --body '{"type":"http_pull","settings":{"batch_size":10,"visibility_timeout_ms":30000,"max_retries":3}}'
xapi workers resources queue-messages pull <worker-id> <resource-id> --env preview \
  --body '{"batch_size":10,"visibility_timeout_ms":30000}'
xapi workers resources queue-messages ack <worker-id> <resource-id> --env preview \
  --body '{"acks":[{"lease_id":"<lease-from-pull>"}],"retries":[]}'
```

The returned messages, bodies and leases follow CF's native response. Do not assume the platform decoded the body; inspect its native encoding. Ordinary `settings` and message options are forwarded as JSON and CF validates them. Raw provider account, Queue ID and script targeting remain server-owned; dead-letter references use an owned Queue binding in the same environment.

Changing an existing consumer type requires deleting the old consumer then creating the new one, because CF rejects an in-place type update. This is an explicit user configuration change, not a step imposed on ordinary deployment. A partial failure is recorded and returned; the platform does not automatically replay the change. Disable removes the consumer and preserves the Queue, data and funds. Paused environments stop new pulls; acknowledgement of an already leased message remains available.

Queue operations are collected by native Queue ID from `queueMessageOperationsAdaptiveGroups`, independently of the consumer type. Do not bill by the number of pull/ack HTTP requests or duplicate this collector's charge. Handler execution uses the existing Worker invocation accounting. A successful pull/ack response does not establish final Queue settlement or the CF invoice.


Import Wrangler `queues.consumers` and `triggers.crons`, then review `workers plan` before `push` or `promote`. Producer Queue names identify logical bindings; consumer-only and dead-letter Queues receive stable generated binding names. xAPI creates its own physical Queues and resolves both consumer and dead-letter targets only from declared resources in the selected owned environment. Native `max_batch_size`, `max_batch_timeout`, `max_retries`, `retry_delay`, and `max_concurrency` values, including zero, are forwarded to the tracked Queue configuration API. Queue configuration runs after confirmed Worker activation. Runtime Queue support and backend parameter validation must succeed; a configuration receipt does not prove actual delivery or metering.

Worker consumption requires native `queue(batch, env, ctx)`; scheduled events require `scheduled(controller, env, ctx)`. HTTP Pull requires neither handler. Cron declarations become UTC `scheduled` triggers through the backend scheduler, with run receipts and normal dispatch funding. Native weekday values are 1–7. The current scheduled-handler parser accepts CF month/weekday names, L/W/LW, last-day offsets, weekday L/#, start/step and wrapping ranges in five-field UTC expressions. Keep unsupported expressions unchanged and report the API error instead of silently rewriting their meaning. An immediate run does not prove future timer firing.

Plan shows remote consumers and schedules absent from desired state as `MANUAL`; ordinary deployment preserves them and does not require their deletion. To intentionally stop deliveries, remove the corresponding Wrangler/project declaration and use the explicit scoped action:

```sh
xapi workers resources queue-consumer disable <worker-id> <resource-id> --env preview
xapi workers schedules pause <worker-id> <schedule-id>
```

`tail_consumers` maps an owned xAPI Worker slug or ID to its physical script in the platform dispatch namespace. `environment` may explicitly select preview or production; omission selects the producer's xAPI environment. Cross-environment references within the same owner are supported. The calling API key's existing Worker scope also applies to the target. The platform metering Tail is retained; `tail_consumers: []` clears only user Tail consumers. Referencing a Worker creates no duplicate resource or retention hold. Rollback snapshots capture the target Worker ID so later slug reuse does not redirect logs. Native Tail CPU settlement and autonomous pause behavior still require the final billing/lifecycle acceptance; do not describe the local candidate as fully billed. Service/RPC, Secret Store and observability destinations still need their own verified ownership mapping.


When a Worker only exports `fetch()` and handles an envelope's `path`, that does not establish native Queue compatibility. Add the native handler and redeploy under existing authorization; preserve producer payload semantics in application code rather than adding platform HTTP route replay. Confirm an actual persisted result keyed by the producer task ID, retry behavior and delivery receipts separately. A successful send/configuration or default acknowledgement is not evidence that D1 or another business store changed. The persistent-agent template contains a signed native handler and an idempotent D1 implementation for this pattern.

## Binding and class names

Binding names are preserved as nonempty strings, including long, Unicode, dollar, hyphen and prototype-property names. Do not shorten, uppercase or sanitize them; access non-identifier names with `env["binding-name"]`. xAPI does not impose the previous 64-character binding or 128-character class limit. Class names must be valid JavaScript identifiers because platform lifecycle modules refer to exported classes; Unicode identifiers are supported. Resource ownership, duplicate-binding checks and platform credential bindings still apply. Physical upstream resource names (Queue/Workflow/Container application) are separate from binding names and retain their own native validation.

The current native `exports` upload API limits class names to 128 characters; the legacy `migrations` API can behave differently. Preserve the upstream error and correct the exported class name explicitly. A legacy native-upload success does not prove the current managed deployment path accepts the same class length.

Capability GET success verifies READ_ACCESS only, not Edit/Write permissions. A cached capability failure is not a provisioning gate: actual creation reports its own upstream result. Inspect AUTHENTICATION (401/403), RATE_LIMITED (429), provider error codes, Retry-After, rate-limit policy and CF-Ray. Credential changes invalidate diagnostics; concurrent probes merge. The 60-second diagnostic cache may respect a 429 Retry-After up to 300 seconds; no business operation is blocked or replayed by this cache. Durable Object availability is a declarative statement, not a live permission probe.
