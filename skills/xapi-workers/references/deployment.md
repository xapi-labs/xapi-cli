# Deployment and CI

### Wrangler environments and public variables

When `env.preview` or `env.production` exists, its bindings, `vars`, and required
Secret names come from that named environment; root bindings and vars are not
inherited. Ordinary inheritable settings retain Wrangler semantics. If the named
environment is absent, the existing default Wrangler configuration maps to the
xAPI slot. Review and re-import an older generated project with `--force` to
correct its declarations; this preserves its linked Worker ID and does not delete
already-created resources.

Wrangler `vars` are public configuration. Strings become `plain_text`; other
JSON values become `json`. They are included in the immutable Artifact and in
environment deployment identity. Promotion uses production vars even when it
reuses the preview Artifact. The deploy API also accepts
`variables: {vars: {...}, varTypes?: {...}}`: omission uses the Artifact defaults;
`variables: {vars: {}}` explicitly clears its public vars. Rollback restores the
recorded override, while resource data and independently managed Secret values
remain current. Explicit `varTypes: {NAME: "json"}` preserves a native JSON string.

Do not copy credentials into `vars`: Artifact/deployment configuration records
are not secret storage. Use the Secret commands for credentials. The importer
reads `secrets.required` as Secret names, not values. Secret Store bindings still
need an owned store/secret mapping and are reported as an adaptation gap; they
must not be replaced with ordinary Secrets without an explicit application change.

CF upload acceptance and edge propagation are separate. Read native settings
and observe application behavior before claiming that new configuration is serving;
do not replay deployment writes merely because one immediate request sees old values.

## Project workflow

```sh
export XAPI_API_HOST=api.test.xapi.to
xapi workers templates
xapi workers init my-service --template persistent-agent
cd my-service
xapi workers plan --env preview
```

Choose the API host explicitly: `api.test.xapi.to` operates test-platform
resources; `api.xapi.to` operates production-platform resources. `--env preview`
selects a project's preview environment on that host, not the test API. A
production acceptance deployment can therefore use `api.xapi.to` with
`--env preview`. Do not silently fall back to a saved test key or host.

For an existing project use `xapi workers init --from-wrangler ./wrangler.jsonc` (TOML also supported). Generated framework configs may live below the project root, for example `dist/server/wrangler.json`; run the command from the package directory so xAPI writes `xapi.worker.json` beside `package.json` and resolves generated asset paths back to that root. Read its import report; do not auto-accept unsupported settings. xAPI creates environment-specific resources; do not copy another Cloudflare account's IDs.

When importing Wrangler, `--name` and `--slug` are template flags and cannot be combined with `--from-wrangler`; the imported name initializes the project. Review `worker.name` and `worker.slug` in the generated file if you need different xAPI names. To link an existing owned Worker, set the **top-level** `workerId` in `xapi.worker.json`, for example `"workerId": "<owned-worker-id>"`, and keep the other generated fields. Neither `worker.id` nor `worker.workerId` is a valid field. A fresh project without `workerId` is created and linked by `push`; a separate `workers create` is not required.

`xapi.worker.json` holds desired xAPI state and Worker ID; Wrangler holds entrypoint, compatibility and binding declarations. The persistent-agent template declares the six ordinary managed binding types so it can demonstrate the platform; Containers remain deployment-owned and must be declared explicitly. An ordinary application should declare only the resources its business logic uses. Do not add unrelated bindings merely to complete an acceptance checklist. Test the full resource matrix in a separate disposable Worker or environment, then clean up only that isolated test state. Install/build according to the generated project instructions. Inspect plans for missing permissions, prices, secrets, budget, and policy requirements.

```sh
xapi workers push --env preview
xapi workers get <worker-id> --format json
xapi workers secrets set <worker-id> APP_TOKEN --env preview --from-env APP_TOKEN
xapi workers logs <worker-id> --env preview --since 10m
```

If provisioning requires an accepted retention quote, follow lifecycle.md and pass its exact `--retention-price-version VERSION`; do not invent a version. Configure credentials with [secrets.md](secrets.md); xAPI never needs a code deployment to retain or replay their values. Never report a blocked preflight as successful deployment.

Use the Node and package-manager version required by the application before `plan` or `push`; the CLI runs the configured build command unchanged. If the project declares `engines.node`, activate a compatible runtime first. A build-runtime failure is an application build failure and must occur before any deployment write; rerun the same push only after correcting the local runtime.

Build commands remain exact nonempty strings, with no xAPI 1000-character cap in project configuration or the managed-build request. Existing request-body capacity and build execution deadlines still apply. Command changes participate in managed-build idempotency; do not replay an uncertain build under a different identity.

For SSR frameworks that generate a complete Wrangler bundle, preserve that native bundle rather than uploading source files one at a time. For vinext/Next.js, a typical build command is:

```sh
npm run build
npx wrangler deploy --dry-run \
  --config dist/server/wrangler.json \
  --outfile dist/app.worker.bundle
```

Set `build.output` to the generated `.worker.bundle`, omit `build.main`, and set `assets.directory` to the generated client directory. `--dry-run` only creates the local Cloudflare upload artifact; `xapi workers push` remains the only publisher. The import report must show every unmapped Wrangler field; never split a framework application into per-file API uploads to work around an import problem.

## Native Containers

Cloudflare Containers are part of the Worker deployment, not an ordinary binding created with `workers resources create`. Keep the native relationship explicit:

1. Wrangler declares a Durable Object binding and `containers[].class_name` for the same class in the same Worker.
2. `xapi workers init --from-wrangler ...` imports shared or environment-specific Container settings into `xapi.worker.json` and creates separate DO resources for preview and production.
3. `xapi workers plan --env preview` must show the DO creation and an Artifact change. Verify `workers capabilities` reports `container_application` available before applying.
4. `xapi workers push --env preview` uploads the Worker, resolves the exact preview DO namespace, creates or updates the Container Application, starts the rollout, and records the application ID for metering. Worker deployment `ACTIVE` confirms code publication; a Container rollout can still be pending. Confirm its actual native configuration and rollout completion before reporting that the new Container size/image is serving.

Deployment responses and `workers get --format json` can report
`containerRollout.status` as `PENDING`, `COMPLETE` or `UNCONFIRMED`.
`PENDING` means native confirmation has not been recorded yet; it does not
require another deployment. `confirmation` and `confirmedAt` distinguish
provider acceptance from a later observed native configuration. This is
configuration progress, not an application health or persistent-file guarantee.
Repeating a completed deployment with the same idempotency key reports the
original deployment and its observed Container progress. It does not submit a
new rollout or freeze funds again. Use the detail read to observe progress;
do not redeploy solely because the Container is still pending.

xAPI v1 accepts prebuilt images from Cloudflare Registry, Docker Hub, Amazon ECR, and Google Artifact Registry. Push the image before deployment and use a tag or immutable digest. A Wrangler `image: "./Dockerfile"` is intentionally reported as unsupported: the CLI does not silently build or publish registry credentials. Never put registry tokens in `xapi.worker.json`, the Artifact, or Worker secrets.

`instanceType` accepts a preset (including the native `dev` → `lite` and
`standard` → `standard-1` compatibility aliases) or a custom object, for example
`{"vcpu":1,"memory_mib":3072,"disk_mb":5500}`. Wrangler's `instance_type`
object is imported unchanged. Memory is in MiB; disk is in decimal MB. The
backend expands custom sizes into the native API fields and compares actual
resolved sizes for updates and rollbacks. Native account/size/ratio limits are
reported by Cloudflare; do not invent a smaller xAPI ceiling. CPU, memory and
disk use the existing rates and five-minute capacity envelope. This envelope
is an estimate of exposure, not a charge for every allocated CPU second.
The retention scope preserves code, configuration and native persistent data
(such as DO/R2); it does not promise recovery of ephemeral Container disk files.
Native filesystem snapshots are a separate capability requiring the provider's
`durable_object` scheduling policy; this local default-policy integration has
not yet completed that adaptation.

Container compute coverage and seven-day retention funding serve different
purposes. Use the server-returned resource funding quote and preserve existing
Worker/DO protection. Sleeping compute does not prove that persistent storage,
backup, image retention and cleanup are free; do not claim an ephemeral root
filesystem is a seven-day persistent volume. The local candidate's independent
Container retention classification is under review and is not a released
fee exemption.

Preview and production use distinct Worker scripts, DO namespaces, and physical Container Application names even though the same immutable Artifact is promoted. A Container rollout is a second Cloudflare mutation after Worker upload; failure leaves the deployment non-ACTIVE and retryable. Do not bypass the failed step with direct Wrangler deployment.

Repository maintainers can run `npm run test:workers:container-local` after building the CLI. It starts a loopback xAPI service, invokes the packaged CLI process, creates the declared DO, uploads the normalized Container Artifact, deploys it, and performs the public health request. This validates protocol wiring without consuming Cloudflare resources; a real preview deployment is still required before release when an account token with Containers Edit is available.

Use the environment's returned `publicUrl` for actual requests. A custom-domain URL needs verified DNS/TLS readiness; do not construct a hostname or infer readiness from the organization name. Use application authentication, never the control-plane key, on this URL.

The dispatcher reserves and strips incoming `x-xapi-*` headers. Use an
application-owned header such as `x-my-app-token`, or normal application
authentication, for your own probes and APIs. Do not disable this filtering to
make a probe pass. Also inspect returned state: `domains retry` can return a
domain record with `status: ERROR`; command completion does not certify DNS,
TLS, root-relative assets or OAuth callback readiness.

After deployment reaches ACTIVE, run health plus business persistence and asynchronous completion checks in resources.md. Review data/schema compatibility before promoting the same preview artifact:

```sh
xapi workers promote --to production
xapi workers rollback --env production --to previous
# Or an explicit deployment visible in the selected environment:
xapi workers rollback --env production --deployment <deployment-id>
```

Rollback restores code, compatibility settings, and the selected deployment's Container configuration, including configuration-only changes using the same Artifact. It does not restore data, schema, Secret values, schedules, or Queue/Workflow state. Preview and production each have their own current deployment; an old deployment reference is not proof an environment is still serving.

Wrangler `triggers.crons` map to tracked xAPI schedules invoking your exported
`scheduled()` handler. These use Cloudflare's UTC five-field dialect, including
case-insensitive month/weekday names, `L`, `W`, `LW`, last-day offsets, weekday
`L`/`#`, start/step expressions and wrapping ranges. The original expression is
passed to `controller.cron`; xAPI does not rewrite it into a numeric schedule.
For example, `59 23 LW * *` runs at 23:59 UTC on the last weekday of each month.
The platform scheduler delivers the event; this is not a claim that a native
Cloudflare Cron Trigger was installed on the dispatch-namespace script. HTTP
schedules retain their IANA timezone and 0/7=Sunday convention. Verify actual
delivery and metering separately from configuration acceptance.

## CI runner

Use the project's installed/pinned CLI, lockfile installation, and a scoped secret `XAPI_KEY`. Keep `XAPI_API_HOST` explicit and separate test/production credentials. CLI deployment does not require SSH into an API server or a Cloudflare account token.

Run plan, build/push, active-status and business checks in order. `--non-interactive` suppresses prompts; it does not accept retention policy or bypass preflight:

```sh
xapi workers plan --env preview --format json
xapi workers push --env preview --non-interactive
```

Promote in the already authorized release job after preview acceptance. Follow repository AGENTS.md and branch/PR rules; do not infer release authorization from a successful preview push. On uncertain results inspect deployments/logs and retry unchanged inputs so stable idempotency keys can recover the same operation. Do not change IDs or clear deletion flags to force deployment through.

A `worker_control_*` conflict is a server rollout or environment-enrollment failure, not a hint to bypass xAPI with Wrangler. Preserve the existing deployment and resources, record the exact error code, inspect `workers audit`, and have the platform operator restore a compatible control-plane configuration before retrying the unchanged deployment.

For explicit artifact operations: `workers upload <worker-id> --file dist/worker.mjs --idempotency-key <stable-key>`, then `workers deploy <worker-id> --artifact <artifact-id> --env preview --idempotency-key <stable-release-key>`. Reuse a key only for identical inputs. `workers build` is an optional managed Sandbox build, not a requirement for deploying locally built code.


For an explicit subsequent user retry, preserve the application source. A failed current push stops; it is never automatically replayed. A confirmed FAILED journal with `providerEffect=NOT_DISPATCHED` or `REJECTED` (no confirmed or uncertain upstream writes) permits a new request identity derived from that journal; lost responses keep that identity. Unknown or partially confirmed provider effects must recover the original recorded operation and must not replay provider writes under a fresh key. Recovery uses an authenticated native tags read to confirm the exact upload operation, not just the deployment ID. If all writes are confirmed and the current native observation matches, a subsequent explicit `push` may create a new publication identity; it does not replay the old UNKNOWN operation. A script observation cannot confirm a separate Container or Workflow write. Unknown or missing tags remain unconfirmed. Same-target new writes are held until there is evidence; unrelated targets remain usable. Older unknown uploads without the operation tag require other exact native evidence rather than guessed success. A current matching ACTIVE deployment is reused. Resource pulls skip pending/deleting records and list their status while importing ready peers; keep any existing declaration and inspect plan before applying it.

Same-target admission is different from a failed deployment. For deploy/rollback and Secret writes, the CLI waits up to 60 seconds only when HTTP 409 explicitly includes `code=worker_control_operation_pending`, `pendingReason=TARGET_BUSY`, `requestAccepted=false` and `requestDispatched=false`. That response means this request has not started or been queued. The CLI reads the blocking operation through `GET /api/v1/workers/:id/control-operations/:operationId` (requires `workers:read`), then submits exactly the same body and deployment key only when the target is released and the result is confirmed. Progress goes to stderr. Poll intervals grow from 1 to 2, 4 and 5 seconds; each read is at most 5 seconds and does not recover or write anything.

Waiting ends on cancellation, an unconfirmed result, a failed/invalid status read or the client wait budget. Old pending responses without explicit unsent evidence remain errors. Do not retry a generic 409/503, network loss or timeout as though it were an unsent admission conflict. No server queue or strict FIFO across independent clients is promised. The 60-second wait is separate from the normal 60-second deployment HTTP budget and does not change the server operation deadline or billing. The internal Workers client accepts `operationWait.timeoutMs=0` to disable waiting and an AbortSignal for cancellation; no new CLI configuration is required.

Remote source builds have a 20 MiB decoded-source and 18 MiB serialized JSON transport budget, while local builds can upload larger resulting artifacts through multipart. Unicode and spaces in safe relative source paths are preserved. Source transfer does not impose a 200-file, 1 MB single-file, or 2 MiB project gate.

Project pushes retain the selected Wrangler environment’s `observability` configuration in the uploaded artifact, including `enabled`, sampling, logs and traces. It participates in artifact identity, so an observability-only update is deployed. Configure Container process logging with Worker observability; xAPI runtime Tail events alone do not prove Container stderr was captured.

Container configuration resolves in this order: the selected environment's `containers`, shared top-level `containers`, then no Containers when only another environment declares them. Explicit `[]` means no Container declaration in that environment; promotion never copies preview-only overrides into production. Removing a resource from the project declaration changes the deployment bindings and leaves the resource and its data intact. Delete it separately when it is no longer needed.

### Upload and build deadlines

Artifact uploads use a 60-second no-progress budget rather than a 60-second total duration. Continuing multipart/JSON transmission is allowed; `XAPI_TRANSFER_IDLE_TIMEOUT_MS` adjusts the CLI idle budget. The receiver ends an incomplete body after 60 seconds with no socket activity, keeps its existing 20 MiB JSON and 100 MiB multipart content budgets, and shares a physical memory budget between JSON parsing and multipart receivers. This is platform capacity protection, not a user quota. No upload is automatically replayed. Inspect artifacts using the original idempotency key after a lost response.

`workers push --build-timeout 30m` selects the local build-command deadline (default 15 minutes). `workers build <id> --build-timeout 30m` forwards 1800 seconds to the Sandbox command (default 10 minutes), includes the selected deadline in build identity and extends the account-scoped temporary credential when needed. The CLI allows the command budget plus six minutes for other stages, reset by actual upload/response progress; large projects can still exceed that preparation allowance. A lost response does not cancel or replay the remote build: inspect `workers builds <id>` and the tracked Sandbox before retrying the identical idempotency key. Native Gateway/provider timeout validation is returned unchanged. Provisioning has its existing operator-selected overall deadline and each status read uses the remaining time; build execution has 30 seconds of transport headroom. No new service environment variables are required.

## Native configuration and release identity

Ordinary native upload configuration is retained in `nativeMetadata`, including
placement, user-selected limits, logpush and observability extensions; xAPI does
not maintain a supported-field allowlist for these options. The original Wrangler
native bundle is authoritative for new configuration translations. If an unknown
source setting is present, emit it with the original Wrangler configuration using
`wrangler deploy --dry-run --outfile`; a plain module cannot prove that setting
was compiled. Account/resource references still require owned mappings; this is
not a per-user feature switch. User Tail references now resolve an owned xAPI Worker slug/ID (optional preview/production target; default producer environment), preserving the platform metering Tail. Explicit empty tail_consumers clears user Tails. The native Tail CPU settlement remains a local-candidate acceptance gap. Managed DO/Container lifecycle reuploads retain the deployed public/native configuration and frozen physical Tail targets; paused managed runtime does not load tenant code. A real local CF managed-DO Tail active/pause/resume probe passed; Tail-only pause and native CPU ledger acceptance remain open. Service/RPC, Secret Store and log destinations still need verified mappings.

The deploy API accepts optional `nativeMetadata`. Omission uses Artifact defaults;
a nonempty object overlays its ordinary fields; explicit `{}` clears them.
`placement.mode="off"` is recorded as intent and omitted from the WFP upload, as
Wrangler does. It does not restore a later environment smart-placement default.
`version_metadata.binding` becomes the native built-in binding; it does not create
a managed resource. `keep_vars` maps to public native binding inheritance. User
tags coexist with the platform deployment tag, which cannot be replaced.

New deployment receipts contain an effective snapshot of metadata, public vars,
selected resource identities, compatibility settings, aliases and Containers.
Rollback uses that snapshot rather than current project/environment defaults.
Historical receipts without a snapshot retain their legacy fallback. This does
not roll back stored resource data, current Secret values or resources deleted
since the release. Restore a missing resource explicitly before deploying it.
Deploy the workers-service backend before the updated CLI; there is no new schema,
environment variable, periodic job or pricing rule in this change.

Initial deployment access preparation does not wait for the global background billing scan. State publication is coordinated per environment script, so unrelated Workers do not share that wait. A conflicting publication for the same script is ordered within the existing 15-second preparation budget; the service then rechecks the active deployment and real account/window evidence. It never steals a lease, extends the financial permission window, or replays deployment. A pending publication or failed public health check does not delete the ACTIVE deployment or its resources; inspect the recorded state and actual service access before any explicit retry. Provider acceptance still does not prove immediate edge propagation.
# Public readiness after activation

`ACTIVE` records code activation. The CLI checks the public health URL separately. A platform `workers_postpaid_state_unavailable` 503 after activation may reflect permission propagation; the CLI observes with read-only GETs for up to 60 seconds, without uploading or deploying again. Ordinary application failures retain the usual health checks. If readiness remains unverified, the CLI keeps `deploymentStatus=ACTIVE` and `publicAccessStatus=UNVERIFIED`; inspect the existing deployment and public URL rather than repeating a push automatically.

### Native execution deadlines and trace tags

Each accepted server operation has one immutable total deadline, currently capped at 15 minutes. Ordinary small operations keep their shorter step-based budget; each actual provider request uses the smaller of its transfer budget and the remaining operation time. This does not limit local builds or grant a new upload session. Static asset transfer shares the same deadline. A timeout does not prove a native write failed, and the server never automatically repeats that write.

The platform appends `xapi-deployment:` and `xapi-operation:` tags for exact native result tracing. Other string tags remain available; user metadata cannot replace these two platform identity prefixes. This is proof integrity, not a supported-feature allowlist.

Pull comparison treats absent and empty ordinary native metadata equally. Nonempty native settings still produce real differences; saved snapshots and explicit deployment clearing semantics are unchanged.
