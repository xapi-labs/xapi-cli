# Deployment and CI

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

Set `build.output` to the generated `.worker.bundle`, omit `build.main`, and set `assets.directory` to the generated client directory. `--dry-run` only creates the local Cloudflare upload artifact; `xapi workers push` remains the only publisher. The import report must show every unmapped Wrangler field; never split a framework application into per-file API uploads to work around an import problem.

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

Run plan, build/push, active-status and business checks in order. `--non-interactive` suppresses prompts; it does not accept retention policy or bypass preflight:

```sh
xapi workers plan --env preview --format json
xapi workers push --env preview --non-interactive
```

Promote in the already authorized release job after preview acceptance. Follow repository AGENTS.md and branch/PR rules; do not infer release authorization from a successful preview push. On uncertain results inspect deployments/logs and retry unchanged inputs so stable idempotency keys can recover the same operation. Do not change IDs or clear deletion flags to force deployment through.

A `worker_control_*` conflict is a server rollout or environment-enrollment failure, not a hint to bypass xAPI with Wrangler. Preserve the existing deployment and resources, record the exact error code, inspect `workers audit`, and have the platform operator restore a compatible control-plane configuration before retrying the unchanged deployment.

For explicit artifact operations: `workers upload <worker-id> --file dist/worker.mjs --idempotency-key <stable-key>`, then `workers deploy <worker-id> --artifact <artifact-id> --env preview --idempotency-key <stable-release-key>`. Reuse a key only for identical inputs. `workers build` is an optional managed Sandbox build, not a requirement for deploying locally built code.
