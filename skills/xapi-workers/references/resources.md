# Resources and real acceptance

Use `workers capabilities` as optional read-only diagnosis and `workers resources list <worker-id> --env preview --format json` to inspect ownership. Permissions, availability, and price configuration are independent: provisioned alone does not mean priced or exercised.

Keep resource declarations driven by application behavior. R2, D1, KV, Durable Objects, Queues, Workflows, and Container Applications are independent bindings and resources; none must be added or deleted just because another resource is used. A Container Application is the one exception to the generic create command: it is deployment-owned and must reference a Durable Object class in the same Worker. When the goal is to verify every platform resource, use a separate disposable acceptance Worker so those checks cannot change a real application's storage or lifecycle.

### R2 initialization and continuation

An R2 bucket can already exist while xAPI is confirming its metering event delivery. `PROVISIONING` with `R2_EVENT_CAPTURE_NOT_READY` is not a new bucket request or proof of failure. `workers resources list` only reads state: repeatedly listing does not finish initialization.

`workers push --env preview` continues this known pending phase on the same binding, waits up to 600 seconds between bounded API calls, and only proceeds to upload and publication when the resource is ready. It keeps the bucket identity and existing reserve. If its wait expires, rerun the same push command; do not remove the resource or change the binding to get past it. This wait does not change Artifact upload timeouts.

For standalone resource creation (or an older CLI that blocks push on pending R2), explicitly repeat `workers resources create <worker-id> --env <environment> --type r2 --binding <same-binding>`, preserving the original placement options and any explicitly selected price version. Inspect the returned status. Stop and report transport/unknown-operation errors or `automaticProbeRetry: false`; do not loop indiscriminately on all failures. `ACTIVE` means initialization completed, not that final usage settlement has been verified.

Prefer declarations plus plan/push. For granular provisioning:

```sh
xapi workers resources create <worker-id> --env preview --type kv --binding PREFERENCES
xapi workers resources create <worker-id> --env preview --type d1 --binding DB
xapi workers resources create <worker-id> --env preview --type r2 --binding FILES
xapi workers resources create <worker-id> --env preview --type do --binding COORDINATOR --class-name Coordinator
xapi workers resources create <worker-id> --env preview --type queue --binding JOBS
xapi workers resources create <worker-id> --env preview --type workflow --binding PIPELINE --class-name Pipeline --workflow-name pipeline
```

Do not run `resources create` for a Container. Declare it in Wrangler and `xapi.worker.json`, then deploy. After deployment, `resources list` exposes a read-only `CONTAINER_APPLICATION` record containing the physical application ID, image, instance type, maximum instances, placement, and rollout receipt. Its binding-like `CONTAINER_<hash>` key is an internal stable identity, not a Worker `env` binding.

Exercise a Container through the application route that causes its controlling Durable Object to start or contact an instance. Verify the business response, Container status, DO coordination state, and four Container usage dimensions separately. Do not conclude that an image runs merely because the application resource exists.

The server validates and prepares resource funds; an explicitly selected price version is optional. Redeploy after binding changes. Use `env.<BINDING>`; no provider API/S3 credentials belong in application code. D1 resource creation does not create application tables; initialize schema with the explicit migration commands below.

### D1 binding and schema initialization

Push/promote create and bind D1 resources without automatically reading or
executing SQL. To initialize schema before the first deployment, create or use
an existing Worker record (`workers create`), set its `workerId` in
`xapi.worker.json`, and declare `DB` in both Wrangler and the target environment's
project resources. Then precreate the binding:

```sh
xapi workers resources create <worker-id> --env preview --type d1 --binding DB
xapi workers resources list <worker-id> --env preview --format json
# Apply requires the existing binding to be ACTIVE.
xapi workers d1 migrations plan --binding DB --env preview
xapi workers d1 migrations apply --binding DB --env preview
xapi workers push --env preview
```

Skip creation if the binding already exists. For creation, preserve desired
`--location`/`--read-replication` options. Forward an explicitly selected
`--retention-price-version VERSION` only when intended; no per-type CLI quote step is required. See
[explicit D1 migrations](deployment.md#explicit-d1-migrations) for the alternative
push-first sequence, environment/config selection, receipts, and failure handling.

### Real business checks

| Resource | Real business check | Evidence |
|---|---|---|
| KV | Save and read a preference; respect eventual consistency | Key, before/after value, timestamps |
| D1 | Create/update/query a business record across separate requests | Record ID and stored result |
| R2 | Upload/download/list/delete a test attachment | Object key, bytes, checksum; only test data deleted |
| Durable Object | Read/write through the same object ID across requests | Object ID and durable result; test alarms separately if used |
| Queue | Enqueue a task and observe its persisted outcome | Stable task ID and consumer result, including retry idempotence |
| Workflow | Start and poll the instance to terminal state | Instance ID, final status and durable result |
| Schedule | Trigger an immediate run and inspect run history | Schedule/run ID and resulting business change |

For a native Workflow, declare `workflows: [{ binding: "PIPELINE", name: "pipeline", class_name: "Pipeline" }]` in Wrangler, export `Pipeline extends WorkflowEntrypoint` from your Worker, and import the configuration with `workers init --from-wrangler`. The xAPI resource declaration must retain `type: "workflow"`, `bindingName: "PIPELINE"`, and `className: "Pipeline"`. The original physical workflow name is remapped to this environment's managed resource. A declaration can be prepared before its first code deployment; it is not yet a completed running Workflow. An explicit external `script_name` is preserved as a reference to another script, never stripped to classify it as a local class. External Workflow/DO references require verified owned mapping; unresolved mappings remain explicit adaptation gaps.

Start it through `env.PIPELINE.create({ params: { taskId } })`, then poll `env.PIPELINE.get(id).status()` through an authenticated application endpoint and verify its durable output. The same Worker holds the application's bindings and Secret values. A normal new deployment is allowed while an instance waits; Cloudflare owns how the running instance resumes. Do not promise that every step stays on the original application version, and do not add a deployment block for active instances.

For imported native Queue consumers, the managed adapter invokes `queue(batch, env, ctx)` and returns ack/retry decisions to Cloudflare. For an existing compatibility Workflow created without a class declaration, the HTTP adapter instead routes the following envelope to the same Worker environment; do not mistake that route for a native handler:

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


### Retrying R2 creation

Use the original binding and environment; do not rename it to bypass a pending or failed attempt.

| Observed result | Next explicit create or push |
| --- | --- |
| CF rejected creation and no bucket exists | Retry creation with the same binding. |
| Bucket exists; metering setup is pending | Continue the original bucket. API may return HTTP 202 with `initialization.status=PENDING`. This is not a failed creation. |
| Creation request timed out | xAPI checks CF against the stored resource identity; reuse if present, create only if confirmed absent. |
| Resource is ACTIVE | Return/reuse the existing resource. |
| CF lookup also fails | Report the uncertainty and stop this attempt; the user can retry. Do not blindly create another bucket. |

`push` accepts an explicit retry of an R2 creation with its original operation record, including ERROR or PROVISIONING. Only a recognized metering wait permits bounded automatic continuation within that push. Ordinary timeouts and failed lookups do not. Pending responses with `automaticProbeRetry=false` require delivery investigation; preserve the bucket and report the reason rather than automatically resubmitting. The server remains authoritative for ownership, deletion conflicts and retained funds.

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

To restore Worker delivery explicitly, use the Worker-consumer declaration shape (the logical `queue` name and native Wrangler batch options), rather than the HTTP Pull `settings` shape:

```sh
xapi workers resources queue-consumer configure <worker-id> <resource-id> --env preview \
  --body '{"type":"worker","queue":"<logical-name-from-queues.consumers>","max_batch_size":1,"max_batch_timeout":1}'
```

The physical Queue and its funds are retained across this explicit switch. `push` still handles declared Worker consumers after code activation; producer-only projects are unchanged.

The returned messages, bodies and leases follow CF's native response. Do not assume the platform decoded the body; inspect its native encoding. Ordinary `settings` and message options are forwarded as JSON and CF validates them. Raw provider account, Queue ID and script targeting remain server-owned; dead-letter references use an owned Queue binding in the same environment.

Changing an existing consumer type requires deleting the old consumer then creating the new one, because CF rejects an in-place type update. This is an explicit user configuration change, not a step imposed on ordinary deployment. A partial failure is recorded and returned; the platform does not automatically replay the change. Disable removes the consumer and preserves the Queue, data and funds. Paused environments stop new pulls; acknowledgement of an already leased message remains available.

Queue operations are collected by native Queue ID from `queueMessageOperationsAdaptiveGroups`, independently of the consumer type. Do not bill by the number of pull/ack HTTP requests or duplicate this collector's charge. Handler execution uses the existing Worker invocation accounting. A successful pull/ack response does not establish final Queue settlement or the CF invoice.


Import Wrangler `queues.consumers` and `triggers.crons`, then review `workers plan` before `push` or `promote`. Producer Queue names identify logical bindings; consumer-only and dead-letter Queues receive stable generated binding names. xAPI creates its own physical Queues and resolves both consumer and dead-letter targets only from declared resources in the selected owned environment. Native `max_batch_size`, `max_batch_timeout`, `max_retries`, `retry_delay`, and `max_concurrency` values, including zero, are forwarded to the tracked Queue configuration API. Queue configuration runs after confirmed code deployment. Backend parameter validation still applies; runtime Queue support is checked only when active. A configuration receipt does not prove actual delivery or metering.

During financial retention, user Queue configuration and disable writes are unavailable. Add sufficient funds and explicitly request recovery first; recharge does not resume execution. After recovery, normal native consumer configuration runs through the same API. System suspension/restoration uses its recorded consumer checkpoint; xAPI does not save new user configuration for later activation during retention.

Worker consumption requires native `queue(batch, env, ctx)`; scheduled events require `scheduled(controller, env, ctx)`. HTTP Pull requires neither handler. Cron declarations become UTC `scheduled` triggers through the backend scheduler, with run receipts and normal dispatch funding. Native weekday values are 1–7. The CLI checks the UTC five-field shape and forwards the original expression to the matching backend’s Cloudflare parser, including names and L/W/#, without local next-run prediction. Manual HTTP schedules retain their separate timezone/parser contract. Keep unsupported expressions unchanged and report the API error instead of silently rewriting their meaning. An immediate run does not prove future timer firing.

Omitted Queue consumers remain unchanged and appear as manual state when absent from the desired plan. To stop Worker delivery, explicitly disable the consumer first, then remove its Wrangler declaration, matching [Cloudflare's Queue lifecycle](https://developers.cloudflare.com/queues/reference/how-queues-works/):

```sh
xapi workers resources queue-consumer disable <worker-id> <resource-id> --env preview
```

Cron intent follows [Wrangler semantics](https://developers.cloudflare.com/workers/configuration/cron-triggers/): omission preserves triggers; an explicit `crons` array synchronizes this project's owned scheduled-handler triggers, including `[]` to clear them. Manual platform HTTP schedules are separate and remain unchanged; pause those explicitly by schedule ID only when intended.

`tail_consumers` maps an owned xAPI Worker slug or ID to its physical script in the platform dispatch namespace. `environment` may explicitly select preview or production; omission selects the producer's xAPI environment. Cross-environment references within the same owner are supported. The calling API key's existing Worker scope also applies to the target. The platform metering Tail is retained; `tail_consumers: []` clears only user Tail consumers. Referencing a Worker creates no duplicate resource or retention hold. Rollback snapshots capture the target Worker ID so later slug reuse does not redirect logs. Verify native Tail CPU settlement and pause behavior separately; a binding/configuration receipt does not establish actual execution or billing. Service/RPC, Secret Store and observability destinations still need their own verified ownership mapping.


When a Worker only exports `fetch()` and handles an envelope's `path`, that does not establish native Queue compatibility. Add the native handler and redeploy under existing authorization; preserve producer payload semantics in application code rather than adding platform HTTP route replay. Confirm an actual persisted result keyed by the producer task ID, retry behavior and delivery receipts separately. A successful send/configuration or default acknowledgement is not evidence that D1 or another business store changed. The persistent-agent template contains a signed native handler and an idempotent D1 implementation for this pattern.

## Binding and class names

Binding names are preserved as nonempty strings, including long, Unicode, dollar, hyphen and prototype-property names. Do not shorten, uppercase or sanitize them; access non-identifier names with `env["binding-name"]`. xAPI does not impose the previous 64-character binding or 128-character class limit. Class names must be valid JavaScript identifiers because platform lifecycle modules refer to exported classes; Unicode identifiers are supported. Resource ownership, duplicate-binding checks and platform credential bindings still apply. Physical upstream resource names (Queue/Workflow/Container application) are separate from binding names and retain their own native validation.

The current native `exports` upload API limits class names to 128 characters; the legacy `migrations` API can behave differently. Preserve the upstream error and correct the exported class name explicitly. A legacy native-upload success does not prove the current managed deployment path accepts the same class length.

Capability GET success verifies READ_ACCESS only, not Edit/Write permissions. A cached capability failure is not a provisioning gate: actual creation reports its own upstream result. Inspect AUTHENTICATION (401/403), RATE_LIMITED (429), provider error codes, Retry-After, rate-limit policy and CF-Ray. Credential changes invalidate diagnostics; concurrent probes merge. The 60-second diagnostic cache may respect a 429 Retry-After up to 300 seconds; no business operation is blocked or replayed by this cache. Durable Object availability is a declarative statement, not a live permission probe.

## Export D1 and R2 business data

```sh
xapi workers d1 export [worker-id] --env preview --binding DB --output ./fresh-backup.sql
xapi workers r2 export [worker-id] --env preview --binding FILES --output ./fresh-directory
xapi workers d1 export [worker-id] --env preview --binding DB --export-id <export-id> --output ./resumed-backup.sql
```

Replace bracketed placeholders or omit Worker ID to use top-level `workerId` from
`xapi.worker.json`; `--config PATH` selects another project file. Select preview
or production explicitly and use the exact owned ACTIVE binding name. Keys need
**both `workers:read`** for binding metadata and **`workers:data:read`** for export,
plus access to the Worker. Management read/write scopes do not imply data access.
Permission errors do not justify creating another binding or bypassing the API.

D1 starts one native SQL export and displays safe `exportId` on stderr. The job
states are `PENDING/COMPLETE/FAILED/EXPIRED`. Polling stops after 600 seconds; the
backend job lifetime is 15 minutes. Explicit `--export-id` polls the same job and
requests a fresh download descriptor without another start. Choose a new output
path. Expired jobs need an explicit new export without that flag. If the first
start response is lost and no ID is available, the user can explicitly re-run
export for the same Worker, environment and binding with a fresh `--output` and
no `--export-id`. The backend reuses the original ID of an existing `PENDING`
job for the same owner/resource. An unconfirmed start already marked `FAILED`
can allow a new job on that explicit re-execution. For HTTP 409
`worker_export_start_retry`, the user can explicitly try again later with a
fresh output. Use the same scoped xAPI credentials. **No POST is automatically
replayed**, including descriptor requests. HTTP status is preserved; raw provider
messages, object keys, signed URLs and credentials are excluded from ordinary
output and errors.

R2 processes one live page at a time (default 100, maximum 200 objects; opaque
cursor up to 24000 bytes), with four concurrent downloads over four reused
connections and a 100000-page safety bound. It buffers neither whole objects nor
the whole bucket. Each object requests its five-minute signature only when a
download slot is ready, immediately before GET; the whole bucket does not share
one five-minute transfer window. Expiry limits starting a new request, not the
duration of an already accepted continuous download. A native R2 short-TTL probe
verified a five-second signature with a successful sixteen-second download;
new requests after expiry were rejected. An interrupted download needs a fresh
authorized signature for a subsequent attempt; current R2 export restarts into
a new directory and does not implement byte-range resume. Do not silently extend
an old capability, replay POST, or call this automatic resume.
Send the descriptor's `If-Match` unchanged after checking it
against the listed ETag; if absent, send the listed ETag. Verify response ETag,
listed size and actual bytes. Changed objects fail. **Listing is not an atomic
bucket snapshot: concurrent writes can change objects or listing.** Arrange
application quiescence separately for a consistent backup.

Output must be fresh. R2 creates a 0700 directory; objects and `manifest.jsonl`
are exclusive 0600 files. D1 creates an exclusive 0600 SQL file and
`<output>.manifest.jsonl` in an existing trusted parent. Existing paths, symlinks
and untrusted non-sticky shared writable ancestors are refused. Relative paths
use the CLI working directory. R2 filenames are `sha256(UTF-8 key).bin`; the
private JSONL manifest maps exact original keys, listed ETags/sizes, downloaded
SHA-256 and response metadata (content type/encoding/disposition, last-modified,
`x-amz-meta-*`). Each object has a `partial` entry followed by `completed` after
verification; page/final receipts count completed objects and bytes. Duplicate
keys or filename collisions stop without overwriting. Keep manifests private.

Failure/interruption retains completed and potentially incomplete files. Only
verified completed entries are usable; a missing final completed result means
an incomplete export. R2 has no resume flag: explicitly restart into a new
directory. D1 resumes the server job, never local partial bytes.

Direct descriptors require GET, unexpired `expiresAt`, HTTPS at
`.r2.cloudflarestorage.com`, no explicit port/credentials/redirect, and only
optional `If-Match` headers. Downloads use no xAPI key, cookie or Authorization
header. Preserve signed URL/header bytes; reject ambiguous dot-segment/backslash
paths. Never constrain the account prefix: native D1 may use a CF service account.
Unknown domains fail closed. Local safe-key tests do not prove native CF support
for every unusual key; provider URL encoding/transport must also be verified.
Compressed bytes stay unchanged with their response metadata. Connection/header
budget is 30 seconds and body idle budget 60 seconds; progressing transfers have
no short total limit.

Export neither provisions/deploys nor imports/switches bindings. A backup receipt
is not migration completion. Imports are outside this feature. Container
HTTP/outbound binding scripts are optional user-owned workflows; no Container
bridge is required or implemented by D1/R2 export.
