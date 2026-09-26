# Deployment and CI

## Project workflow

Use one command layer for one task. For normal application deployment, stay in
the project workflow:

| Intent | Command | Writes live state |
| --- | --- | --- |
| Inspect one running environment | `workers inspect [worker-id] --env ENV` | No |
| Build locally and compare exact desired state with xAPI | `workers plan --env ENV` | No remote writes |
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
After publication, check a real deep link and refresh, resource MIME types,
actual UI actions, and any PWA/local-storage persistence across an update.
The generated health endpoint checks transport only. Use the returned routing
readiness to distinguish a root hostname from `PATH_FALLBACK`; do not invent
per-page forwarding rules or count health 200 as application acceptance.

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

An initial Wrangler Durable Object migration containing only
`new_sqlite_classes` is managed when its class set exactly matches the imported
Durable Object bindings. xAPI creates those SQLite classes through managed
Workers for Platforms exports and does not copy provider migration tags.
Renames, deletions, regular-class migrations, repeated classes, and partial
class sets remain blocked because they need an explicit state migration plan.
`preview_urls` is also not copied: xAPI assigns the environment hostname.

`xapi.worker.json` holds desired xAPI state and Worker ID; Wrangler holds entrypoint, compatibility and binding declarations. The persistent-agent template declares the six ordinary managed binding types so it can demonstrate the platform; Containers remain deployment-owned and must be declared explicitly. An ordinary application should declare only the resources its business logic uses. Do not add unrelated bindings merely to complete an acceptance checklist. Test the full resource matrix in a separate disposable Worker or environment, then clean up only that isolated test state. Install/build according to the generated project instructions. Inspect plans for missing permissions, prices, secrets, budget, and policy requirements.

```sh
# No required Secrets: push can complete the deployment directly.
# Required Secrets: follow secrets.md's first-project setup before expecting a release.
xapi workers push --env preview
xapi workers get <worker-id> --format json
xapi workers logs <worker-id> --env preview --since 10m
```

If provisioning requires an accepted retention quote, follow lifecycle.md and pass its exact `--retention-price-version VERSION`; do not invent a version. Configure public vars and credentials with [secrets.md](secrets.md), including its interactive bootstrap and non-interactive first-project setup. Public vars take effect with the Artifact deployment; Secret writes and retention are independent. Never report a blocked preflight as successful deployment.

Use the Node and package-manager version required by the application before `plan` or `push`; the CLI runs the configured build command unchanged. If the project declares `engines.node`, activate a compatible runtime first. A build-runtime failure is an application build failure and must occur before any deployment write; rerun the same push only after correcting the local runtime.

For SSR frameworks that generate a complete Wrangler bundle, preserve that native bundle rather than uploading source files one at a time. For vinext/Next.js, a typical build command is:

```sh
npm run build
npx wrangler deploy --dry-run \
  --config dist/server/wrangler.json \
  --outfile dist/app.worker.bundle
```

This example assumes the generated Wrangler config represents the target environment at its root. If it defines `env.preview`, add `--env preview` to the dry-run command; use the matching environment for the framework build too. The CLI runs `build.command` as written, so it does not automatically add Wrangler's environment flag. Never package root vars while planning a named environment, and never pass a nonexistent environment just to follow an example.

Set `build.output` to the generated `.worker.bundle`, omit `build.main`, and set `assets.directory` to the generated client directory. `--dry-run` only creates the local Cloudflare upload artifact; `xapi workers push` remains the only publisher. The CLI sends the complete modules/assets set in one authenticated multipart Artifact request. The import report must show every unmapped Wrangler field; never split a framework application into per-file API uploads to work around an import problem.

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
2. `xapi workers init --from-wrangler ...` imports the Container settings into `xapi.worker.json` and writes separate desired DO declarations for preview and production. Init is local only; push creates the remote resources for the selected environment.
3. `xapi workers plan --env preview` must show the DO creation and an Artifact change. Verify `workers capabilities` reports `container_application` available before applying.
4. `xapi workers push --env preview` uploads the Worker, resolves the exact preview DO namespace, creates or updates the Container Application, submits the required rollout, records its application ID and receipt for metering, and only then marks the deployment ACTIVE. Native rollout convergence remains separately observable; xAPI keeps both old and new risk capacity counted until Cloudflare confirms it.

Before the first Provider mutation, xAPI also requires a complete active price book and account-level five-minute Container risk capacity. This check does not freeze or deduct wallet funds and does not run on application requests. If push returns `worker_container_risk_policy_missing`, `worker_container_prices_incomplete`, `worker_container_egress_risk_not_accepted`, or `worker_container_risk_capacity_exceeded`, report the exact code and stop; do not bypass xAPI with Wrangler or reinterpret the amount as a customer charge. The first three require an xAPI operator to correct platform policy or pricing. The last requires reducing the deployment's instance size/count or adding balance/risk capacity.

xAPI v1 accepts prebuilt images from Cloudflare Registry, Docker Hub, Amazon ECR, and Google Artifact Registry. Push the image before deployment and use a tag or immutable digest. A Wrangler `image: "./Dockerfile"` is intentionally reported as unsupported: the CLI does not silently build or publish registry credentials. Never put registry tokens in `xapi.worker.json`, the Artifact, or Worker secrets.

Preview and production use distinct Worker scripts, DO namespaces, and physical Container Application names even though the same immutable Artifact is promoted. A Container rollout is a second Cloudflare mutation after Worker upload; failure leaves the deployment non-ACTIVE and retryable. Do not bypass the failed step with direct Wrangler deployment.

Removing a Container declaration is also a deployment operation. Push the new immutable manifest; xAPI deletes only the exact Container Application no longer declared and releases its risk capacity after Provider deletion is confirmed. Do not delete the associated Durable Object or unrelated R2/D1/KV resources unless the application declaration and business migration require it.

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

Rollback re-deploys the selected Artifact and its release compatibility settings and required Secret **names**. It does not restore data, schema, resource bindings, Secret **values**, schedules, or Queue/Workflow state. Explicit public vars come from the target Artifact; omitted public vars follow that Artifact's retention types against the current environment, not a snapshot of historical values. A missing Secret required by the target Workflow must be set through the independent Secret workflow; do not borrow requirements from the latest release or replay old values. Preview and production each have their own current deployment; an old deployment reference is not proof an environment is still serving.

## CI runner

Use the project's installed/pinned CLI, lockfile installation, and a scoped secret `XAPI_KEY`. Keep `XAPI_API_HOST` explicit and separate test/production credentials. CLI deployment does not require SSH into an API server or a Cloudflare account token.

Run plan, push, inspect, active-status and business checks in order. Both plan
and push prepare the local Artifact; push performs that work before any Worker,
budget, resource, Artifact, or Deployment write. `--non-interactive` suppresses
prompts; it does not bypass quote, balance or preflight checks. A separate retention-policy acceptance call is not required:

```sh
xapi workers plan --env preview --format json
xapi workers push --env preview --non-interactive
xapi workers inspect --env preview --format json
```

Promote in the already authorized release job after preview acceptance. Follow repository AGENTS.md and branch/PR rules; do not infer release authorization from a successful preview push. On uncertain results inspect deployments/logs and retry unchanged inputs so stable idempotency keys can recover the same operation. Do not change IDs or clear deletion flags to force deployment through.

Inspect the exact `worker_control_*` code and operation status. A conflict can mean an overlapping change to the same script/resource, an unknown native result, a changed resource identity, or incompatible server configuration. There is one management path; users do not select an internal execution mode. Preserve IDs and receipts; inspect `workers audit` and current deployment/resource state. On an explicitly requested retry, reuse unchanged inputs: the server may continue steps that have not been sent or repair known-success local state. Do not loop on UNKNOWN, clear operation records, switch modes, or bypass xAPI with Wrangler. Scope/configuration mismatches require platform investigation; ordinary in-progress operations require status inspection.

For explicit artifact operations: `workers upload <worker-id> --file dist/worker.mjs --idempotency-key <stable-key>`, then `workers deploy <worker-id> --artifact <artifact-id> --env preview --idempotency-key <stable-release-key>`. Reuse a key only for identical inputs. `workers build` is an optional managed Sandbox build, not a requirement for deploying locally built code.


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

The import report includes `BEFORE_CODE` (D1 migrations), `CODE` (Worker
configuration), and `AFTER_CODE` (Queue consumers and Cron). Current push/promote
execute these steps only with the matching backend and Dispatcher release. Check
the plan before confirmation; migrations are resolved relative to the referenced
Wrangler file, constrained to the project, and frozen with their SHA256 before
execution. Promote uses the selected Artifact plus the displayed local migration
and event plan. It does not restore these from the old Artifact automatically.

D1 files execute remotely through xAPI in order, recording each file and checksum
in the target D1 database. Require APPLIED/ALREADY_APPLIED and remote:true receipts.
An existing Wrangler record without a checksum is skipped with sha256:null: its
original content has not been verified. Failed SQL stops later files/code release;
completed migrations do not roll back with code. A lost response is reconciled
against the remote ledger, never blindly replayed. Preserve partial receipts.

Queue consumers invoke queue(batch, env, ctx) through the platform event adapter;
CF owns ack/retry/delay/DLQ delivery. The adapter preserves message IDs, attempts,
timestamps, logical names, binary bodies and waitUntil failure. It does not claim
exactly-once or every possible V8 serialized type. Cron invokes scheduled() with
scheduledTime, cron, noRetry and waitUntil. Only UTC numeric five-field expressions
are currently supported, with CF weekdays 1=Sunday through 7=Saturday. Named fields,
L/W/# and singleton steps are rejected before deployment. Do not delete unsupported
settings or use --accept-partial to claim full compatibility.

These are platform mappings over the existing metered Dispatcher path, not direct
namespace native trigger registrations. Scheduler waiting is currently at most
120 seconds; existing Dispatcher CPU/subrequest limits still apply. Configuration
probes require the deployed signed adapter and real handlers; an HTML 200 is not
readiness. Explicit crons:[] disables only CLI-owned schedules in the target
environment; absent triggers preserves them. Independently created user schedules
are not removed.

A successful push proves deployment/configuration receipts and the configured
HTTP health probe, not live Queue/Cron or financial acceptance. Before reporting
CF acceptance, verify actual Queue messages/retries/DLQ, a naturally triggered Cron,
remote D1 ledger and business side effects, pause/ownership controls, and attributed
usage/billing on the selected xAPI test environment. Local workerd/Miniflare,
mocked transport and run-now alone are insufficient. Never bypass xAPI with a direct
Wrangler cloud deployment to manufacture a successful result.

## Plan freshness

The CLI freezes the project configuration and the target environment's active deployment ID when preparing the plan. If the JSON changes during build/confirmation, or another deployment becomes active before submission, rerun the plan and review its effects. Do not retry the old plan by changing its IDs. The API checks `expectedActiveDeploymentId` again when claiming deployment; `null` means the environment had no active deployment. This is a check at deployment submission, not a long-lived environment lock. Independent resources that are omitted from bindings are retained and may still incur storage costs.
