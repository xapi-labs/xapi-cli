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
xapi workers push --env preview
xapi workers get <worker-id> --format json
xapi workers secrets set <worker-id> APP_TOKEN --env preview --from-env APP_TOKEN
xapi workers logs <worker-id> --env preview --since 10m
```

If provisioning requires an accepted retention quote, follow lifecycle.md and pass its exact `--retention-price-version VERSION`; do not invent a version. Configure credentials with [secrets.md](secrets.md); xAPI never needs a code deployment to retain or replay their values. Never report a blocked preflight as successful deployment.

Use the Node and package-manager version required by the application before `plan` or `push`; the CLI runs the configured build command unchanged. If the project declares `engines.node`, activate a compatible runtime first. A build-runtime failure is an application build failure and must occur before any deployment write; rerun the same push only after correcting the local runtime.

For SSR frameworks that generate a complete Wrangler bundle, preserve that native bundle rather than uploading source files one at a time. For vinext/Next.js, a typical build command is:

```sh
npm run build
npx wrangler deploy --dry-run \
  --config dist/server/wrangler.json \
  --outfile dist/app.worker.bundle
```

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

## Native Containers

Cloudflare Containers are part of the Worker deployment, not an ordinary binding created with `workers resources create`. Keep the native relationship explicit:

1. Wrangler declares a Durable Object binding and `containers[].class_name` for the same class in the same Worker.
2. `xapi workers init --from-wrangler ...` imports the Container settings into shared `xapi.worker.json` state and creates separate DO resources for preview and production.
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

Rollback restores code and compatibility settings, not data, schema, Secret values, schedules, or Queue/Workflow state. Preview and production each have their own current deployment; an old deployment reference is not proof an environment is still serving.

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

Inspect the exact `worker_control_*` code and operation status. A conflict can mean an overlapping change to the same script/resource, an unknown native result, a changed resource identity, or incompatible server configuration. It is not automatically an environment-enrollment problem. Users do not choose LEGACY/CONTROL. Preserve IDs and receipts; inspect `workers audit` and current deployment/resource state. On an explicitly requested retry, reuse unchanged inputs: the server may continue steps that have not been sent or repair known-success local state. Do not loop on UNKNOWN, clear operation records, switch modes, or bypass xAPI with Wrangler. Scope/configuration mismatches require platform investigation; ordinary in-progress operations require status inspection.

For explicit artifact operations: `workers upload <worker-id> --file dist/worker.mjs --idempotency-key <stable-key>`, then `workers deploy <worker-id> --artifact <artifact-id> --env preview --idempotency-key <stable-release-key>`. Reuse a key only for identical inputs. `workers build` is an optional managed Sandbox build, not a requirement for deploying locally built code.


### Native configuration and application deployment prerequisites

`cache.enabled`, `cache.cross_version_cache` and `version_metadata.binding` are
preserved through the Artifact and native upload. These require a backend version
containing the native-options changes; an older deployment is not evidence of
support. A stale `.bundle` whose cache/version settings disagree with the selected
Wrangler environment must be rebuilt. Cache settings apply to the user Worker,
not to the xAPI dispatcher. Required Secret names in `secrets.required` are
imported; set their values through the Secrets API, never inside the Artifact.

The import report now includes a `deploymentPlan` for each environment:
`BEFORE_CODE` (D1 migrations), `CODE` (Worker configuration), `AFTER_CODE` (Queue
consumers and Cron). `REQUIRES_MAPPING` is unfinished execution support, not a
successful deployment. D1 directories are relative to the referenced Wrangler
file, not necessarily the project root. Code rollback does not undo applied SQL.

Current managed Queue delivery is HTTP; it is not equivalent to `queue(batch)`.
Current HTTP schedules are not equivalent to `scheduled()`. Do not remove these
fields from an app or use `--accept-partial` to claim full compatibility. Before
publishing an app that uses them, implement/verify the declared event semantics
and database initialization, then test them in the selected xAPI test environment.
