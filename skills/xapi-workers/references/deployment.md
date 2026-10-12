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

Use one command layer for one task. For normal application deployment, stay in
the project workflow:

| Intent | Command | Writes live state |
| --- | --- | --- |
| Inspect one running environment | `workers inspect [worker-id] --env ENV` | No |
| Build locally and compare exact desired state with xAPI | `workers plan --env ENV` | No remote writes |
| Inspect local D1 migration files without a build or backend call | `workers d1 migrations plan --binding DB --env ENV` | No; remote status is not checked |
| Explicitly execute D1 migrations on an existing binding | `workers d1 migrations apply --binding DB --env ENV` | Yes; SQL only |
| Rebuild, present the final plan, reconcile and deploy preview | `workers push --env preview` | Yes, after confirmation |
| Release the accepted preview Artifact | `workers promote --to production` | Yes |
| Restore an earlier active version | `workers rollback --env ENV ...` | Yes |

`workers inspect` accepts an explicit Worker ID or resolves it from the current
`xapi.worker.json`. It combines Worker, environment, active Artifact and
Deployment, routing, resource, Secret metadata, domain, and billing freshness
reads into one report. Optional read failures stay `UNKNOWN`, never zero or
success. It never reads Secret values and performs no health request that might
trigger application behavior. Use `workers plan` separately when comparing
local desired state with xAPI. Plan runs the configured local build first, validates
the native bundle and static assets, and then displays the exact Artifact hash,
resource/Secret/routing changes, budget-cap delta, price-book availability, and
usage-dependent cost effects. A budget is a cap rather than a predicted charge;
unknown traffic and storage must remain unknown.
`workers build`, `upload`, and `deploy` are lower-level Artifact primitives for
custom CI and recovery. A managed `build` only produces an Artifact; `deploy`
only activates an existing Artifact. Neither replaces project convergence by
`push`.

```sh
export XAPI_API_HOST=api.test.xapi.to
xapi workers templates
xapi workers init my-service --template persistent-agent
cd my-service
xapi workers plan --env preview
```

### Existing static web applications

For a Vite-based client application (including React or Vue), start in its
application package directory:

```sh
xapi workers init . --framework vite
# Install the application's existing dependencies using the returned nextSteps.
xapi workers plan --env preview
```

Static initialization leaves the application's package manifest, build script,
and lockfile unchanged. It creates a dependency-free ESM Worker adapter and uses
the existing application build; no extra deployment packages are needed for
this adapter. Follow the returned package-manager command, preserving an
existing lockfile. A dependency
resolution failure is a local build problem, not proof that Workers cannot run
the application. Do not upgrade unrelated application dependencies to hide it.

The generated Vite configuration assumes `dist`. Check the actual build output:
custom Vite builds and SvelteKit **static** adapters can emit `build`, `docs`, or
another directory. Set `assets.directory` in both `xapi.worker.json` and its
referenced Wrangler config to that directory, relative to each config file.
Keep `build.output` pointing to the Worker entry bundle, not the static directory.
An SSR application needs its framework's native Worker bundle instead; a static
adapter cannot replace its server-side behavior.

Retain the application's routing behavior. `single-page-application` is suitable
for an SPA's client-side routes; it does not make missing JS/CSS files valid.
For R2 initialization waits, push continues the existing bucket before upload or publication. If it returns a pending timeout, rerun the same push; a read-only resource-list loop cannot finish this phase. See [resources.md](resources.md#r2-initialization-and-continuation). Unknown provider results are not automatically replayed.

After publication, check a real deep link and refresh, resource MIME types,
actual UI actions, and any PWA/local-storage persistence across an update.
The generated health endpoint checks transport only. Use the returned routing
readiness to distinguish a root hostname from `PATH_FALLBACK`; do not invent
per-page forwarding rules or count health 200 as application acceptance.

An unmodified application that emits root URLs such as `/_next/...`, `/assets/...`
or `/api/...` needs a root hostname, unless its native build and server routes
are configured for the supplied base path. A working `/w/<ref>/<env>/` HTML
response alone does not prove these URLs belong to that Worker. Use a verified
owned custom domain when the test platform has no default hostname; never
borrow a production domain or rewrite arbitrary HTML in the Dispatcher.

`init .` preserves an existing Wrangler configuration or generated
`.wrangler/deploy/config.json` entrypoint before generating a static adapter.
If a later build produces a real server entrypoint, re-import that generated
configuration with `init --from-wrangler <path> --force`, review the configuration,
and package its complete native dry-run bundle. React/Vite dependencies alone
do not distinguish a SPA from a server-rendered application.

During builds, assets fields absent from `xapi.worker.json` inherit the selected
Wrangler configuration; explicitly declared xAPI fields override it, including
`false`, `none`, and empty arrays. Previously imported fields remain explicit
overrides: remove an optional override if it should follow Wrangler changes.
Directories resolve relative to the file declaring them. Do not silently
overwrite a customer's deliberate configuration.

For copied projects, build from tracked source with the lockfile rather than
reusing another directory's generated caches or node_modules. Generated caches
can embed absolute build-machine paths even when all files upload successfully.
Preserve tracked public build configuration; a file named `.env.production`
is not automatically a private credential file.

For an APAC-oriented service, initialize or edit the environment desired state
with `defaultResourceLocation: "apac"` and `placementMode: "smart"`. The first
setting applies only when xAPI creates new D1/R2 resources; the second emits
Cloudflare's native Smart Placement metadata on Worker deployment. Workers
remain global, and neither setting moves existing stored data.

Choose the API host explicitly: `api.test.xapi.to` operates test-platform
resources; `api.xapi.to` operates production-platform resources. `--env preview`
selects a project's preview environment on that host, not the test API. A
production acceptance deployment can therefore use `api.xapi.to` with
`--env preview`. Do not silently fall back to a saved test key or host.

For an existing project use `xapi workers init --from-wrangler ./wrangler.jsonc` (TOML also supported). Generated framework configs may live below the project root, for example `dist/server/wrangler.json`; run the command from the package directory so xAPI writes `xapi.worker.json` beside `package.json` and resolves generated asset paths back to that root. Read its import report; do not auto-accept unsupported settings. xAPI creates environment-specific resources; do not copy another Cloudflare account's IDs.

Cloudflare Vite projects may omit `assets.directory` in the source Wrangler config. Import keeps the asset routing there; plan/push runs the native build and reads the actual directory from the generated config referenced by `.wrangler/deploy/config.json`. Do not guess `dist/client` or add a directory merely to pass import. If the build does not produce that pointer and directory, the CLI reports the missing build output before any deployment write. Importing an existing generated config remains supported.

An initial Wrangler Durable Object migration containing only
`new_sqlite_classes` is managed when its class set exactly matches the imported
Durable Object bindings. xAPI creates those SQLite classes through managed
Workers for Platforms exports and does not copy provider migration tags.
Renames, deletions, regular-class migrations, repeated classes, and partial
class sets remain blocked because they need an explicit state migration plan.
`preview_urls` is also not copied: xAPI assigns the environment hostname.

When importing Wrangler, `--name` and `--slug` are template flags and cannot be combined with `--from-wrangler`; the imported name initializes the project. Review `worker.name` and `worker.slug` in the generated file if you need different xAPI names. To link an existing owned Worker, set the **top-level** `workerId` in `xapi.worker.json`, for example `"workerId": "<owned-worker-id>"`, and keep the other generated fields. Neither `worker.id` nor `worker.workerId` is a valid field. Interactive `push` can create and link a fresh project. For required Secrets in CI or before provisioning resources, use `workers create --config xapi.worker.json`, set Secrets, then plan/push; non-interactive push does not create a missing-Secret project.

`xapi.worker.json` holds desired xAPI state and Worker ID; Wrangler holds entrypoint, compatibility and binding declarations. The persistent-agent template declares the six ordinary managed binding types so it can demonstrate the platform; Containers remain deployment-owned and must be declared explicitly. An ordinary application should declare only the resources its business logic uses. Do not add unrelated bindings merely to complete an acceptance checklist. Test the full resource matrix in a separate disposable Worker or environment, then clean up only that isolated test state. Install/build according to the generated project instructions. Inspect plans for missing permissions, prices, secrets, budget, and policy requirements.

```sh
# Prepare required D1 schema separately; push does not execute SQL.
# Required Secrets: follow secrets.md's first-project setup before expecting a release.
xapi workers push --env preview
xapi workers get <worker-id> --format json
xapi workers logs <worker-id> --env preview --since 10m
```

Plan displays the server funding estimate. The server performs atomic funding checks; the CLI does not require a separate per-resource quote or mandatory price-version argument. An explicitly selected `--retention-price-version VERSION` is forwarded unchanged; do not invent a version. Configure public vars and credentials with [secrets.md](secrets.md), including its interactive bootstrap and non-interactive first-project setup. Public vars take effect with the Artifact deployment; Secret values are managed independently of deployment. Financial retention blocks user writes until successful funding recovery; see [billing.md](billing.md). Never report a blocked preflight as successful deployment.

Use the Node and package-manager version required by the application before `plan` or `push`; the CLI runs the configured build command unchanged. If the project declares `engines.node`, activate a compatible runtime first. A build-runtime failure is an application build failure and must occur before any deployment write; rerun the same push only after correcting the local runtime.

Build commands remain exact nonempty strings, with no xAPI 1000-character cap in project configuration or the managed-build request. Existing request-body capacity and build execution deadlines still apply. Command changes participate in managed-build idempotency; do not replay an uncertain build under a different identity.

For SSR frameworks that generate a complete Wrangler bundle, preserve that native bundle rather than uploading source files one at a time. For vinext/Next.js, a typical build command is:

```sh
npm run build
npx wrangler deploy --dry-run \
  --config dist/server/wrangler.json \
  --outfile dist/app.worker.bundle
```

This example assumes the generated Wrangler config represents the target environment at its root. If it defines `env.preview`, add `--env preview` to the dry-run command; use the matching environment for the framework build too. The CLI runs `build.command` as written, so it does not automatically add Wrangler's environment flag. Never package root vars while planning a named environment, and never pass a nonexistent environment just to follow an example.

Set `build.output` to the generated `.worker.bundle`, omit `build.main`, and set `assets.directory` to the generated client directory. `--dry-run` only creates the local Cloudflare upload artifact; `xapi workers push` remains the only publisher. The CLI sends the complete modules/assets set as one immutable Artifact: direct checksummed R2 upload and server sealing when available, otherwise the authenticated legacy multipart channel. The import report must show every unmapped Wrangler field; never split a framework application into per-file API uploads to work around an import problem.

Direct upload progress is written to stderr; JSON stdout remains the final result.
The CLI uploads content through a reusable, bounded connection pool. Files remain
one complete-project Artifact, not separate deployments. A temporary socket/idle
failure or HTTP 408/429/500/502/503/504 may retry the same checksummed object, with
the same authorization, up to three total attempts within the existing eight PUT
slots. Retry-After is waited in full when it fits the upload/signature deadline;
otherwise the upload stops. Cancellation, authorization/checksum failures and
redirects do not retry. The CLI reports retries and the upload ID; it does not
prepare a new session or replay confirmation/deployment automatically. After upload, xAPI
persists confirmation and reports `QUEUED`, `CONFIRMING`, `READY`, or `FAILED`.
A continuing large-file transfer uses an idle deadline; Artifact confirmation has
its own bounded wait. If the CLI disconnects or reports an unresolved confirmation:

```bash
xapi workers upload-status <worker-id> --upload <upload-id> --format json
```

Read `progress.stage`, `completedFiles`, and `totalFiles`. `READY` includes the
immutable Artifact. Rerun the original `workers push` to reuse it and continue
publication. `FAILED` includes a safe error code: correct the cause and explicitly
retry. Do not create a different Worker, modify the Artifact, or assume that an
accepted confirmation published the application. Confirmation does not reserve
funds or initiate a deployment. A service restart can recover accepted verification
work; it does not automatically replay a publication.

For custom HTTP clients, `POST /api/v1/workers/{workerId}/artifact-uploads/{uploadId}/confirm`
with JSON `{"async":true}` accepts the verification task and returns the upload ID
and status. Read `GET /api/v1/workers/{workerId}/artifact-uploads/{uploadId}/status`
using the same authenticated owner. `QUEUED` and `CONFIRMING` are pending;
`READY` includes `artifact`; `FAILED` includes sanitized `error.code` and, when
available, `error.status` and `error.type`. Progress can show `WAITING_CAPACITY`
while local scratch is busy; this does not trigger a deployment or charge.
Verification's processing budget begins when work starts, not while it waits.
Omitting `async` preserves the synchronous confirmation response for existing clients.

The complete-project upload channel accepts up to 64 MiB of uncompressed
Worker modules and 100 MiB of combined module/static-asset content; each static
asset is limited to 25 MiB. There is no 200-module cutoff. A single-file build
larger than 1 MiB automatically uses the bundle channel; do not split application
code just to fit the old source-text endpoint. Native `.bundle` files have a
separate 128 MiB envelope allowance for metadata/framing. Public ingress and
Cloudflare account limits still apply, so local acceptance does not certify
public upload capacity. Deploy the matching backend before the CLI update.

Generated Wrangler configs may omit provider resource IDs and emit an
`inherit` binding in the dry-run bundle. Declare that binding exactly once in
the selected environment's `resources`; xAPI maps it by binding name and
injects the environment-owned resource during deployment. Do not add a copied
or placeholder Cloudflare resource ID merely to make the local bundle pass.

For a package inside a pnpm, Yarn, or Bun workspace, run `init` from that
package directory. The CLI uses the nearest lockfile up to the repository root
and keeps the generated build command on the repository's package manager.

## Public variable decisions

Public `vars` and their binding types belong to the immutable Artifact. Review
`plan.variables` in JSON or the **Public variables** section in human output:

| Decision | Effect |
| --- | --- |
| `SET` | Apply the Artifact's declared value, including when a binding already has the same type. Values are not compared. |
| `RETAIN` | Keep an omitted live public binding because its current native type is retained. |
| `REMOVE` | Remove an omitted live public binding whose type is not retained. |
| `REPLACE` | Replace a public binding with another declared public type or an explicit resource/asset/version/Secret binding. |

Default deployment replaces public variables: omit a live `plain_text` or `json`
binding and it is removed. Set **top-level** Wrangler `keep_vars: true` to keep
omitted bindings of both types. `false` or absence emits no public retention.
Wrangler ignores `env.<name>.keep_vars`; the importer reports that warning and
the root setting is never overridden. Named environments do not inherit root
`vars`; declare their public values explicitly and build for the same environment.
An explicitly declared variable still sets its Artifact value when retention is
on, and an explicit binding of another kind takes precedence over retention.

Native `keep_bindings` preserves per-type intent: `["json"]` retains omitted JSON
bindings but removes omitted plaintext bindings; `["plain_text"]` does the
reverse. The Artifact stores only those public types in canonical
`keepBindings` order (`plain_text`, then `json`), with duplicates removed and an
empty list omitted. `secret_text` and `secret_key` normalize out because Secrets
are independently managed and always kept across code deployment. Other native
resource retention types require explicit target mapping and are rejected before
upload; there is no wildcard `all` mapping. Secret values still use the separate
Secrets workflow; retaining public vars never reads or replays credentials.

String vars default to `plain_text`, other JSON values to `json`. Native JSON
bindings whose values happen to be strings remain `json` via the Artifact's
`varTypes` exceptions. Default type annotations are omitted so existing Artifact
hashes stay unchanged. Rebuild stale native output when values or retention
settings disagree with the selected Wrangler configuration.

For linked targets, plan reads the target Cloudflare script's live public binding
names/types through xAPI. It never reads or displays their values. These are
management reads only; they add no reads to application requests. Promotion
reads the selected immutable preview Artifact's variable declaration and compares
it with the live production target. Do not substitute local preview output or
local production `vars`, or rebuild to infer the selected Artifact's intent.
Retention preserves the target environment's own omitted values, not preview's.

Deploy the matching backend **before upgrading the CLI**. Both authenticated
read endpoints and backend `keepBindings`/`varTypes` support are required:

- `GET /api/v1/workers/:id/environments/:environment/variables` — live target
  public names/types and deployment identity, without values.
- `GET /api/v1/workers/:id/artifacts/:artifactId/variable-configuration` — the
  selected immutable Artifact's public names/types, retention and binding names,
  without values.

A missing endpoint, failed read, malformed response, or mismatched Artifact or
deployment identity stops preflight. Report the exact failure and backend
upgrade requirement where applicable; never silently substitute an empty set or
infer remote state from local files. An absent `variables` field in an older plan
is unavailable metadata, not evidence of no variables. Local tests and Wrangler
dry-runs do not prove that Cloudflare has applied this behavior; report cloud
verification only after a real deployment and appropriate runtime checks.

## Native Containers

Cloudflare Containers are part of the Worker deployment, not an ordinary binding created with `workers resources create`. Keep the native relationship explicit:

1. Wrangler declares a Durable Object binding and `containers[].class_name` for the same class in the same Worker.
2. `xapi workers init --from-wrangler ...` imports shared or environment-specific Container settings into `xapi.worker.json` and writes separate desired DO declarations for preview and production. Init is local only; push creates the remote resources for the selected environment.
3. `xapi workers plan --env preview` must show the DO creation and an Artifact change. `workers capabilities` is optional read-only diagnosis, not a provisioning gate. The actual deployment reports upstream permissions and native validation errors.
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
filesystem is a seven-day persistent volume. The server remains responsible for funding and financial receipts; the CLI does
not request a generic independent Container retention-product quote.

Preview and production use distinct Worker scripts, DO namespaces, and physical Container Application names even though the same immutable Artifact is promoted. A Container rollout is a separate Cloudflare mutation after Worker upload. A rejected required write is a deployment failure; an accepted rollout awaiting convergence is observed through read-only status, not automatically redeployed. Do not bypass a failed managed deployment with direct Wrangler deployment.

Repository maintainers can run `npm run test:workers:container-local` after building the CLI. It starts a loopback xAPI service, invokes the packaged CLI process, creates the declared DO, uploads the normalized Container Artifact, deploys it, and performs the public health request. This validates protocol wiring without consuming Cloudflare resources; a real preview deployment is still required before release when an account token with Containers Edit is available.

Use the environment's returned `publicUrl` for actual requests. A custom-domain URL needs verified DNS/TLS readiness; do not construct a hostname or infer readiness from the organization name. Use application authentication, never the control-plane key, on this URL.

The dispatcher reserves and strips incoming `x-xapi-*` headers. Use an
application-owned header such as `x-my-app-token`, or normal application
authentication, for your own probes and APIs. Do not disable this filtering to
make a probe pass. Also inspect returned state: `domains retry` can return a
domain record with `status: ERROR`; command completion does not certify DNS,
TLS, root-relative assets or OAuth callback readiness.

After deployment reaches ACTIVE, run health plus business persistence and asynchronous completion checks in resources.md.

`workers push` requires a successful public health response to report success.
HTTP 403 and ordinary health failures remain nonzero failures even when the
deployment is ACTIVE. Preserve the
released deployment ID and inspect status and logs before choosing recovery.
System funding protection requires sufficient funds and explicit `retention resume`
when recovery is intended; recharge or deployment does not resume execution.
UNKNOWN deployment outcomes are not replayed.

`ACTIVE` does not mean public access authorization is ready. For exactly
HTTP 503 with JSON `error.code: workers_postpaid_state_unavailable`, the CLI
continues read-only GET health checks within a 75-second total health window
(at most 75 attempts, with each request limited to 10 seconds and the remaining
window). It still requires a successful HTTP response; expiration remains a
nonzero failure with the deployment ACTIVE and runtime readiness unconfirmed.
This response does not identify a Cloudflare/KV cache root cause: initial
postpaid enrollment or publication may be pending, and existing deployments
can also encounter authorization-state unavailability or a publisher outage. Do not republish,
re-promote, rotate Secrets, or change configuration to retry health. Preserve
the released deployment ID, health URL, HTTP status and exact error code;
recheck that URL with a bounded read-only GET and use `workers inspect` for the
same environment. Keep management credentials off the public URL. Other errors,
including 403 authorization denials, invalid configuration and application 503s,
keep the ordinary 10-attempt limit and must be diagnosed separately.

Review data/schema compatibility before promoting the same preview artifact:

```sh
xapi workers promote --to production
xapi workers rollback --env production --to previous
# Or an explicit deployment visible in the selected environment:
xapi workers rollback --env production --deployment <deployment-id>
```

Rollback re-deploys the selected immutable Artifact and the recorded release snapshot: compatibility settings, required Secret **names**, selected resource bindings, native metadata, aliases and Container settings, including configuration-only changes using the same Artifact. It does not recreate deleted resources or restore resource data, SQL schema, Secret **values**, schedules or Queue/Workflow state. Explicit public vars come from the target Artifact and recorded override; omitted public vars follow the target Artifact's retention types against the current environment, not a snapshot of historical values. Set a missing required Secret through the independent Secret workflow. Preview and production have separate active deployments; a historical receipt is not evidence of what is currently serving.

Wrangler `triggers.crons` map to tracked xAPI schedules invoking `scheduled()` through the platform scheduler; this is not a native Cron registration on the dispatch-namespace script. See the [native configuration contract](#native-configuration-and-application-deployment-prerequisites) for supported syntax and explicit update/removal behavior. Verify actual delivery and metering separately from configuration acceptance.

## CI runner

Use the project's installed/pinned CLI, lockfile installation, and a scoped secret `XAPI_KEY`. Keep `XAPI_API_HOST` explicit and separate test/production credentials. CLI deployment does not require SSH into an API server or a Cloudflare account token.

Run plan, push, inspect, active-status and business checks in order. Both plan
and push prepare the local Artifact; push performs that work before any Worker,
budget, resource, Artifact, or Deployment write. `--non-interactive` suppresses
prompts; it does not bypass server funding checks or the reviewed deployment plan. A separate retention-policy acceptance call is not required:

```sh
xapi workers plan --env preview --format json
xapi workers push --env preview --non-interactive
xapi workers inspect --env preview --format json
```

Record the active deployment, immutable Artifact and actual public hostname.
Then use a real browser to load the page, follow an internal link and refresh
that deep URL; verify the application's declared CSS/JS have the correct MIME
and are not HTML error pages. Exercise a real UI action and its server API,
and verify persisted data after an update. Record font failures, application
errors and unrelated browser-extension errors separately. A path fallback that
cannot load the application's root URLs is an incomplete web acceptance result,
not evidence that the customer must rewrite their application.

Platform service deployment and CF integration deployment are separate release
steps. Maintainers must bind the serving Dispatcher/Tail version to the exact
candidate code, verify existing bindings, Secret authentication, Queue consumer
and DLQ configuration, then verify native callbacks and ledger attribution.
An API health response does not prove these edge components were updated.

For xAPI platform maintainers, keep Worker implementation changes on one Worker feature branch; Sandbox changes stay separate. The backend platform integrates an authorized release through `dev → staging → main`, completing the checks at each stage. The separate CLI repository uses its own development PR to `main` and Release Please release review; do not invent CLI staging branches or publish a feature checkout. These repository flows are distinct from a customer's preview-to-production Worker promotion. Local source/tests are not evidence that the platform has been deployed or that a CLI package is published; package version/tag/publication remains governed by Release Please.

Promote in the already authorized release job after preview acceptance. Follow repository AGENTS.md and branch/PR rules; do not infer release authorization from a successful preview push. On uncertain results inspect deployments/logs and read the original operation before choosing an explicit retry with unchanged inputs; stable idempotency keys preserve its identity without automatic write replay. Do not change IDs or clear deletion flags to force deployment through.

Inspect the exact `worker_control_*` code and operation status. A conflict can mean an overlapping change to the same script/resource, an unknown native result, a changed resource identity, or incompatible server configuration. There is one management path; users do not select an internal execution mode. Preserve IDs and receipts; inspect `workers audit` and current deployment/resource state. On an explicitly requested retry, reuse unchanged inputs: the server may continue steps that have not been sent or repair known-success local state. Do not loop on UNKNOWN, clear operation records, switch modes, or bypass xAPI with Wrangler. Scope/configuration mismatches require platform investigation; ordinary in-progress operations require status inspection.

For explicit artifact operations: `workers upload <worker-id> --file dist/worker.mjs --idempotency-key <stable-key>`, then `workers deploy <worker-id> --artifact <artifact-id> --env preview --idempotency-key <stable-release-key>`. Reuse a key only for identical inputs. `workers build` names the separate managed Sandbox build API; it is currently unavailable, retaining the main-branch contract, and is not required for deploying locally built code.


### Explicit D1 migrations

`workers push` and `workers promote` do not read, parse, or execute D1 SQL
files. They still create and bind declared resources, publish code, and configure
Queue/Cron in `AFTER_CODE`. A normal release does not require repairing a D1
migration ledger. Choose schema execution separately for each environment:

```sh
# Local files only: no backend call and no application build.
xapi workers d1 migrations plan --binding DB --env preview
# Explicit remote SQL execution on the existing ACTIVE binding.
xapi workers d1 migrations apply --binding DB --env preview
```

Both commands require `--binding NAME` and `--env preview|production`, and accept
`--config PATH` to select the project configuration (`xapi.worker.json`). They
read the referenced Wrangler configuration for the selected environment. The
binding must be declared in both Wrangler and that environment's project
resources. Migration paths are relative to the Wrangler file and constrained
to the project. Files ending in `.sql` are ordered by filename and snapshotted
with their SQL content and SHA256; use ordered filename prefixes. If the
Wrangler config is generated, prepare that file beforehand: these commands do
not run the application build.

Plan reports local filenames and SHA256 values with `remoteStatus: NOT_CHECKED`.
It does not identify which files are remotely pending or applied and needs no
existing remote Worker. Apply takes its own local snapshot, requires `workerId`
in the project configuration and an existing `ACTIVE` D1 binding in the target
environment, and checks the remote ledger while executing files sequentially.
Apply does not create resources or publish code. It uses normal Worker access
permissions, with no administrator approval or `--yes` gate.

Require `APPLIED` or `ALREADY_APPLIED` and `remote: true` for each successful
receipt. An existing database or table does not establish that local migrations
were applied. A legacy Wrangler ledger entry returned with `sha256: null` does
not verify its original SQL against the local file. On any failure, later files
stop; retain completed receipts and the failed filename. Completed SQL is not
rolled back. A timeout or lost response is an unknown outcome: inspect the
error and remote ledger before an explicit retry; never automatically replay
uncertain SQL or clear data/ledger entries to force progress.

For an existing `ACTIVE` D1 binding, apply needed, compatible schema changes before
push or promotion. For a new project, prefer precreating the binding with
[`workers resources create`](resources.md#d1-binding-and-schema-initialization),
then apply and publish. Alternatively, push can create the binding first and
apply can initialize it afterward. That first push may fail its health check
because tables do not yet exist. Inspect the actual deployment/resource state,
apply to the same binding, and check the application's business behavior; do
not recreate the database or clear its contents. Migration success alone does
not establish a successful deployment.

Production uses its own binding and ledger: apply with `--env production`
when intended, separately from `workers promote --to production`. Code
rollback never rolls back SQL; plan schema changes to remain compatible with
the code versions that may run before, during, and after a release.

### Native configuration and application deployment prerequisites

`cache.enabled`, `cache.cross_version_cache` and `version_metadata.binding` are
preserved through the Artifact and native upload. These require a backend version
containing the native-options changes; an older deployment is not evidence of
support. A stale `.bundle` whose cache/version/observability settings disagree with the selected
Wrangler environment must be rebuilt. Cache settings apply to the user Worker,
not to the xAPI dispatcher. Required Secret names in `secrets.required` are
imported; set their values through the Secrets API, never inside the Artifact.

The native-options release also preserves script-local `observability` settings:
`enabled`, `head_sampling_rate`, `logs` (including `invocation_logs` and `persist`),
and `traces`. Explicit `false` and sampling rate `0` remain meaningful. Account
export `destinations` need tenant-aware mapping and are rejected before upload;
do not remove them just to claim a complete deployment. User telemetry settings
do not disable the platform billing Tail.

Use Wrangler's `--dry-run --outfile dist/worker.bundle` output for native source
maps. xAPI preserves `application/source-map` parts exactly; an outdir map can
have different source paths, so do not replace the map inside the bundle. For a
plain module/directory build, `upload_source_maps: true` includes the adjacent
`<module>.map` or directory `.map` files as private upload attachments; omitting
it excludes those files from that build. Explicit `false` rejects a stale native
bundle that still contains map attachments. Keep private maps out of your public
assets directory: files explicitly placed there are website assets. The plan
shows telemetry settings and the private attachment count. Verify actual CF
logging/stack remapping after release; local upload validation proves neither.

Push/promote retain `CODE` (Worker configuration) and `AFTER_CODE` (Queue
consumers and Cron), using the matching backend and Dispatcher release. D1
migration guidance points to the [explicit commands](#explicit-d1-migrations);
there is no automatic D1 `BEFORE_CODE` execution. Check the event plan before
confirmation. Promote uses the selected Artifact plus the displayed local event
plan; it does not automatically restore that event configuration from the old
Artifact.

Queue consumers invoke queue(batch, env, ctx) through the platform event adapter;
CF owns ack/retry/delay/DLQ delivery. The adapter preserves message IDs, attempts,
timestamps, logical names, binary bodies and waitUntil failure. It does not claim
exactly-once or every possible V8 serialized type. Cron invokes scheduled() with
scheduledTime, cron, noRetry and waitUntil. The CLI checks the UTC five-field shape and forwards the original expression;
the matching backend validates Cloudflare syntax, including names and L/W/#,
with CF weekdays 1=Sunday through 7=Saturday. It does not rewrite advanced
expressions or attempt local next-run prediction. Manual HTTP schedules retain
their separate timezone/parser contract. Verify the matching backend before use;
configuration acceptance alone is not evidence of future timer delivery.

Queue consumer omission preserves the existing consumer and Queue messages. To stop Worker delivery, first run `workers resources queue-consumer disable` for the owned Queue, then remove its Wrangler declaration. This follows [Cloudflare's explicit consumer-removal workflow](https://developers.cloudflare.com/queues/reference/how-queues-works/). Declaring a consumer configures it after confirmed code activation; check its receipt. Storage can remain billable without a consumer.

Cron uses [Wrangler's update intent](https://developers.cloudflare.com/workers/configuration/cron-triggers/): omitted `triggers` or `crons` preserves current triggers; an explicit `crons` array synchronizes this project's CLI-owned scheduled-handler triggers in the selected environment, and `crons: []` clears them. Independently created platform HTTP schedules remain unchanged. Do not treat Queue omission as Cron removal intent.

These are platform mappings over the existing metered Dispatcher path, not direct namespace native trigger registrations. Scheduler waiting is currently at most 120 seconds; existing Dispatcher CPU/subrequest limits still apply. Configuration probes require the signed adapter and real handlers; an HTML 200 is not readiness.

A successful push proves deployment/configuration receipts and the configured
HTTP health probe, not live Queue/Cron or financial acceptance. Before reporting
CF acceptance, verify actual Queue messages/retries/DLQ, a naturally triggered Cron,
remote D1 ledger and business side effects, pause/ownership controls, and attributed
usage/billing on the selected xAPI test environment. Local workerd/Miniflare,
mocked transport and run-now alone are insufficient. Never bypass xAPI with a direct
Wrangler cloud deployment to manufacture a successful result.

## Plan freshness

The CLI freezes the project configuration and the target environment's active deployment ID when preparing the plan. If the JSON changes during build/confirmation, or another deployment becomes active before submission, rerun the plan and review its effects. Do not retry the old plan by changing its IDs. The API checks `expectedActiveDeploymentId` again when claiming deployment; `null` means the environment had no active deployment. This is a check at deployment submission, not a long-lived environment lock. Independent resources that are omitted from bindings are retained and may still incur storage costs.

For an explicit subsequent user retry, preserve the application source. A failed current push stops; it is never automatically replayed. For `push`, a confirmed terminal FAILED journal with a matching operation ID and `providerEffect=NOT_DISPATCHED`, `NO_WRITES` or `REJECTED` permits an explicit later retry with a derived request identity only when no step contains successful/uncertain write evidence. `REJECTED` additionally requires at least one rejected step. Lost responses keep the same retry identity. This does not promise the same fresh-retry path for `promote`, and it never automatically repeats a failed write. Unknown or partially confirmed provider effects must recover the original recorded operation and must not replay provider writes under a fresh key. Recovery uses an authenticated native tags read to confirm the exact upload operation, not just the deployment ID. If all writes are confirmed and the current native observation matches, a subsequent explicit `push` may create a new publication identity; it does not replay the old UNKNOWN operation. A script observation cannot confirm a separate Container or Workflow write. Unknown or missing tags remain unconfirmed. Same-target new writes are held until there is evidence; unrelated targets remain usable. Older unknown uploads without the operation tag require other exact native evidence rather than guessed success. A current matching ACTIVE deployment is reused. Resource pulls report pending/deleting status while importing ready peers. A live pending resource retains its prior remote observation for the three-way merge; it is not treated as a remote deletion and does not erase the existing declaration. Inspect the plan before applying it.

Same-target admission is different from a failed deployment. For deploy/rollback and Secret writes, the CLI waits up to 60 seconds only when HTTP 409 explicitly includes `code=worker_control_operation_pending`, `pendingReason=TARGET_BUSY`, `requestAccepted=false` and `requestDispatched=false`. That response means this request has not started or been queued. The CLI reads the blocking operation through `GET /api/v1/workers/:id/control-operations/:operationId` (requires `workers:read`), then submits exactly the same body and deployment key only when the target is released and the result is confirmed. Progress goes to stderr. Poll intervals grow from 1 to 2, 4 and 5 seconds; each read is at most 5 seconds and does not recover or write anything.

Waiting ends on cancellation, an unconfirmed result, a failed/invalid status read or the client wait budget. Old pending responses without explicit unsent evidence remain errors. Do not retry a generic 409/503, network loss or timeout as though it were an unsent admission conflict. No server queue or strict FIFO across independent clients is promised. The 60-second wait is separate from the normal three-minute deployment HTTP budget and does not change the server operation deadline or billing. The internal Workers client accepts `operationWait.timeoutMs=0` to disable waiting and an AbortSignal for cancellation; no new CLI configuration is required.

Remote source builds have a 20 MiB decoded-source and 18 MiB serialized JSON transport budget, while local builds can upload larger resulting artifacts through multipart. Unicode and spaces in safe relative source paths are preserved. Source transfer does not impose a 200-file, 1 MB single-file, or 2 MiB project gate.

Project pushes retain the selected Wrangler environment’s `observability` configuration in the uploaded artifact, including `enabled`, sampling, logs and traces. It participates in artifact identity, so an observability-only update is deployed. Configure Container process logging with Worker observability; xAPI runtime Tail events alone do not prove Container stderr was captured.

Container configuration resolves in this order: the selected environment's `containers`, shared top-level `containers`, then no Containers when only another environment declares them. Explicit `[]` means no Container declaration in that environment; promotion never copies preview-only overrides into production. Removing a resource from the project declaration changes the deployment bindings and leaves the resource and its data intact. Delete it separately when it is no longer needed.

### Upload and build deadlines

Artifact uploads use a 60-second no-progress budget rather than a 60-second total duration. Continuing multipart/JSON transmission is allowed; `XAPI_TRANSFER_IDLE_TIMEOUT_MS` adjusts the CLI idle budget. The receiver ends an incomplete body after 60 seconds with no socket activity, keeps its existing 20 MiB JSON and 100 MiB multipart content budgets, and shares a physical memory budget between JSON parsing and multipart receivers. This is platform capacity protection, not a user quota. Only the bounded same-object recovery described above is automatic; whole uploads and uncertain confirmation/publication writes are not replayed. Inspect artifacts using the original idempotency key after a lost response.

Direct-upload file lists live in private R2; DB sessions keep only small references and confirmed artifact receipts. Preparing the same content again may reuse an active channel while granting the same full15-minute upload window as a new explicit preparation, including after the earlier CLI exits. This does not extend a deployment's execution deadline. Failed expired channels can be removed after the existing24h cleanup grace; start a new upload when the temporary session is absent. Confirmed artifact identity and deployment history remain available. No per-owner file/session quota is added.

`workers push --build-timeout 30m` selects the local build-command deadline (default 15 minutes). "Local" means the CLI's execution environment: a user's computer, CI runner, or user-owned xAPI Sandbox. A user can obtain a Sandbox through its normal API, run the project build and CLI there, and upload artifacts for xAPI-managed CF deployment. That Sandbox follows its own billing/lifecycle; deployment does not automatically delete it or require another build Sandbox. The user decides its cleanup. Supply only the user's authorized Worker credentials to the CLI, never platform/provider keys, and never embed credentials into artifacts.

For this MVP, prefer that local-build/direct-artifact path. `workers build <id> --build-timeout 30m` targets the separate managed server-build API. Its public entry remains unavailable with `worker_cloud_build_disabled` / `USER_BUILD_BUDGET_NOT_IMPLEMENTED`, exactly as on main, until customer cloud-build billing is implemented. Setting a legacy service build Key does not enable it. No delegated Key, Sandbox instance or new customer cloud-build charge is created; `workers push` and uploaded-artifact deployment remain usable. Legacy implementation code can still represent1800 seconds (default10 minutes) and the configured service build account, but this is not a successful or enabled cloud-build workflow. The CLI allows the command budget plus six minutes for other stages, reset by actual upload/response progress; large projects can still exceed that preparation allowance. Lost server-build responses are not replayed: inspect `workers builds <id>` using the original identity. Stored build cost is a historical observation, not proof of a final invoice or completed cleanup. Gateway/provider timeout validation remains unchanged. Provisioning and command deadlines remain bounded; no new cloud-build background task or migration is introduced. The self-assembled Sandbox→CLI→R2→CF flow still requires its own real end-to-end acceptance.

## Native configuration and release identity

Ordinary native upload configuration is retained in `nativeMetadata`, including
placement, user-selected limits, logpush and observability extensions; xAPI does
not maintain a supported-field allowlist for these options. The original Wrangler
native bundle is authoritative for new configuration translations. If an unknown
source setting is present, emit it with the original Wrangler configuration using
`wrangler deploy --dry-run --outfile`; a plain module cannot prove that setting
was compiled. Account/resource references still require owned mappings; this is
not a per-user feature switch. User Tail references now resolve an owned xAPI Worker slug/ID (optional preview/production target; default producer environment), preserving the platform metering Tail. Explicit empty tail_consumers clears user Tails. Managed DO/Container lifecycle reuploads retain deployed public/native configuration and frozen physical Tail targets. Verify actual Tail execution, pause behavior and native CPU ledger attribution separately; configuration receipts alone do not establish those outcomes. Service/RPC, Secret Store and log destinations still need verified mappings.

The deploy API accepts optional `nativeMetadata`. Omission uses Artifact defaults;
a nonempty object overlays its ordinary fields; explicit `{}` clears them.
With the matching backend, promotion automatically submits the complete effective
production metadata computed from Wrangler's named-environment inheritance.
Inherited root placement, limits, logging and cache settings remain; preview-only
version bindings and user Tails are removed unless production declares them.
The CLI checks backend support and matching immutable Artifact binding types;
older services keep the safe preflight rejection for intent they cannot express.
No extra command flag is needed. Review the displayed plan, set required production
Secrets through the Secrets API, then use `workers promote --to production`.
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
Deploy the matching workers-service backend before using these CLI contracts;
follow that backend release’s migration and rollout instructions. CLI configuration
forwarding does not introduce a new user pricing rule.

Initial deployment access preparation does not wait for the global background billing scan. State publication is coordinated per environment script, so unrelated Workers do not share that wait. A conflicting publication for the same script is ordered within the existing 15-second preparation budget; the service then rechecks the active deployment and real account/window evidence. It never steals a lease, extends the financial permission window, or replays deployment. A pending publication or failed public health check does not delete the ACTIVE deployment or its resources; inspect the recorded state and actual service access before any explicit retry. Provider acceptance still does not prove immediate edge propagation.
### Public readiness after activation

`ACTIVE` records code activation. The CLI checks the public health URL separately. A platform `workers_postpaid_state_unavailable` 503 after activation may reflect permission propagation; the CLI observes with read-only GETs within the 75-second total health window, without uploading or deploying again. Ordinary application failures retain the usual health checks. If readiness remains unverified, the CLI keeps `deploymentStatus=ACTIVE` and `publicAccessStatus=UNVERIFIED`; inspect the existing deployment and public URL rather than repeating a push automatically.

### Native execution deadlines and trace tags

Each accepted server operation has one immutable total deadline, currently capped at 15 minutes. Ordinary small operations keep their shorter step-based budget; each actual provider request uses the smaller of its transfer budget and the remaining operation time. This does not limit local builds or grant a new upload session. Static asset transfer shares the same deadline. A timeout does not prove a native write failed, and the server never automatically repeats that write.

The platform appends `xapi-deployment:` and `xapi-operation:` tags for exact native result tracing. Other string tags remain available; user metadata cannot replace these two platform identity prefixes. This is proof integrity, not a supported-feature allowlist.

Pull comparison treats absent and empty ordinary native metadata, Queue aliases, and the empty public-vars envelope `{vars:{}}` equally. Actual values (including empty strings, zero, false and null inside vars) and future envelope fields still produce real differences. Saved snapshots and explicit deployment clearing semantics are unchanged.
