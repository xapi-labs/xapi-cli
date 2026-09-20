# xAPI Hosted Workers

Use this guide when the user wants to deploy an API, Webhook, Chat endpoint, scheduled JavaScript task, or persistent Agent to xAPI-managed Cloudflare Workers for Platforms.

## Choose Worker or Sandbox

- Use `workers` for continuously addressable HTTP/WebSocket applications, Webhooks, scheduled tasks, and persistent Agent entrypoints. The control plane currently manages KV, D1, R2, Durable Objects, Queues, Workflows, Secrets, and persistent schedules. Run `workers capabilities` before provisioning because the configured Cloudflare token may not have every required resource permission.
- Use `sandbox` for arbitrary shell commands, builds, browsers, GPU work, or short-lived isolated jobs.
- A Worker may dispatch heavy work to Sandbox. Do not keep a Sandbox alive merely to act as an HTTP service when a Worker fits.

## Authentication and test routing

Keys need `workers:read` for reads and `workers:write` for mutations. The CLI reads `XAPI_KEY`, then `XAPI_API_KEY`, then `~/.xapi/config.json`.

The account owner can additionally restrict each key to all account Workers,
only Workers created by that key, or own plus selected Workers. Configure this
in Console → API Keys → Permissions. Every CLI subcommand respects the same
server-side instance boundary; an out-of-scope Worker is returned as `404`.

Production uses `api.xapi.to`. Select the test control plane explicitly:

```bash
export XAPI_API_HOST=api.test.xapi.to
```

Do not send the key directly to Cloudflare or any non-xAPI host. xAPI owns the Cloudflare account and API token.

## Prefer the project workflow

For a normal application or Agent, use the project commands instead of manually
passing Worker IDs, Artifact IDs, and idempotency keys. `xapi.worker.json` stores
only xAPI-specific desired state and the remote `workerId`; Wrangler remains the
source of truth for the entrypoint, compatibility settings, and static assets.
Managed KV, D1, R2, Durable Object, Queue, and Workflow declarations belong in
`xapi.worker.json`. The file contains no credential and may be committed.

Choose the `init` form from the project you actually have:

| Starting point | Command | What `init` does |
| --- | --- | --- |
| Empty directory / new service | `xapi workers init my-agent --template persistent-agent` | Creates a complete Worker package from a versioned local template. |
| Existing React, Vite, Vue, or static Next.js package | `cd app && xapi workers init` | Detects the framework, keeps existing scripts, and adds only the xAPI adapter, Wrangler config, desired-state file, and xAPI package scripts. |
| Existing Worker with Wrangler | `xapi workers init --from-wrangler ./wrangler.jsonc` | Imports supported settings after showing what is managed, ignored, or must be re-entered. |
| Next.js SSR | Run `npx vinext check`, `npx vinext init`, then `xapi workers init --from-wrangler <generated-config>` | Uses the framework adapter's complete Worker bundle instead of treating SSR as static files. |

For a new service:

```bash
xapi workers templates
xapi workers init my-agent --template persistent-agent
cd my-agent
xapi workers plan --env preview
xapi workers push --env preview
```

For an existing browser application without Wrangler, initialize the package in
place. Detection reads `package.json`; it supports Vite React, Vite Vue, plain
Vite, Create React App, Vue CLI, and static Next.js. It does not replace the
application's `dev`, `build`, or test scripts:

```bash
cd existing-web-app
xapi workers init
npm install
npm run xapi:build
xapi workers plan --env preview
xapi workers push --env preview
```

The added files are `xapi.worker.json`, `wrangler.jsonc`, and
`xapi-worker/index.ts`. The added package scripts are `xapi:build`,
`xapi:worker:build`, and `xapi:worker:dev`. Review the generated diff before
installing dependencies. Re-running `init` is not a synchronization command;
once `xapi.worker.json` exists, manage it with the project and resource commands.

Use `--framework react|vite|vue|next` only for ambiguous package metadata.
Static Next.js requires `output: 'export'`. For Next.js SSR, do not generate a
generic SPA Worker: run `npx vinext check` and `npx vinext init`, then import the
generated Wrangler configuration. Local development remains a package concern
(`xapi:worker:dev` runs Wrangler); there is no separate `workers dev` command.

The templates are versioned files packaged with the CLI, so `init` neither
downloads nor executes remote code. The `persistent-agent` starter declares KV,
D1, R2, one Durable Object, one Queue, and one Workflow in both environments,
plus the Secret names `APP_TOKEN` and `MODEL_KEY`. `plan` shows the exact desired
changes; `push` creates environment-specific resources and binds their provider
IDs without writing those IDs into application source. Set secret values after
the Worker ID exists:

That broad resource set demonstrates the complete platform; it is not the
default architecture for every application. Keep only resources used by the
application's business logic. Do not add or couple independent bindings merely
to complete an acceptance checklist. Verify the full resource matrix in a
separate disposable Worker or environment so cleanup cannot alter application
data.

```bash
xapi workers secrets set <worker-id> APP_TOKEN --env preview --from-env APP_TOKEN
xapi workers secrets set <worker-id> MODEL_KEY --env preview --from-env MODEL_KEY
```

The generated `TEMPLATE.md` explains the `/chat`, `/state`, `/queue`,
`/workflow`, and `/cron` routes and includes a remote smoke test. Users own and
edit `src/index.ts`; the template is only the initial project snapshot.

Import an existing Cloudflare Worker without reusing its Cloudflare account ID,
resource IDs, routes, or secrets:

```bash
cd existing-worker
xapi workers init --from-wrangler ./wrangler.jsonc
xapi workers plan --env preview
xapi workers push --env preview
```

`init --from-wrangler` also accepts `wrangler.toml`. It classifies settings as
`SUPPORTED`, `MANAGED`, `REENTER`, `IGNORED`, or `UNSUPPORTED`; it refuses to
write a partial project unless the user explicitly accepts the report with
`--accept-partial`.

The project workflow does not require Git. Git repository, branch, and commit
are optional provenance, not authentication and not a deployment prerequisite.
It runs the configured build, creates the remote Worker when `workerId` is
absent, safely creates or updates declared resources, uploads one immutable
Artifact, deploys preview, waits for the active state, and runs the configured
health check. `push` never deletes an extra stateful resource or Secret; `plan`
marks such drift `MANUAL` for explicit handling.

## Resource state without drift

There are only two resource states:

- `xapi.worker.json` is the desired state that belongs in Git. It contains
  binding names and portable options, never Cloudflare or xAPI resource IDs.
- xAPI is the live state. `plan` reads it every time and compares it with the
  selected environment in `xapi.worker.json`; there is no cached state file.

Choose the command by intent:

| Intent | Command | State changed |
| --- | --- | --- |
| Create a declaration | `resources add` | Local desired state only |
| Adjust a declaration | `resources update` | Local desired state only |
| Adopt live-only resources | `resources pull` | Live read, then safe local merge |
| Stop declaring a resource | `resources remove` | Local desired state only |
| Delete resource data | `resources destroy --yes` | Local desired state and one live environment |
| Check convergence | `workers plan` | None |

Use this normal flow to add a resource:

```bash
xapi workers resources add --env both --type kv --binding CACHE
xapi workers resources add --env both --type d1 --binding DB --location apac
xapi workers resources add --env both --type r2 --binding FILES --location apac
xapi workers resources add --env both --type do --binding ROOM --class-name Room
xapi workers resources add --env both --type queue --binding JOBS
xapi workers resources add --env both --type workflow --binding PIPELINE
xapi workers resources update --env preview --type d1 --binding DB \
  --location weur --read-replication disabled
xapi workers plan --env preview
xapi workers push --env preview
```

`--env both` creates matching declarations, not shared storage. `resources add`
is idempotent and rejects conflicting binding reuse. `resources update`
replaces the complete declaration. Before linking it can correct any local
field; after linking it rejects type and Durable Object class changes. A live
location or D1 replication change is
`BLOCKED` because the current API cannot update a managed resource in place;
create another binding and migrate data instead.

If a live resource was created before this file, or an older CLI changed only
the control plane, adopt it explicitly:

```bash
xapi workers plan --env preview
xapi workers resources pull --env preview
git diff -- xapi.worker.json
xapi workers plan --env preview
```

`pull` is an additive, all-or-nothing merge. It imports only supported healthy
resources, preserves pending local declarations, never writes provider IDs,
never deletes anything, and refuses to overwrite a binding whose type,
Durable Object class, location, or D1 replication differs. `--env both` reads
the environments independently because their physical resources are separate.

`resources remove` changes desired state only. The following `plan` shows the
live resource as `MANUAL`; keep it with `resources pull`, or back it up and use
the project-aware destructive command:

```bash
xapi workers resources destroy --env preview --binding FILES --yes
```

`destroy` accepts one environment, removes the declaration before requesting
live deletion, and reports a deletion request rather than claiming immediate
physical destruction. If the request fails, the live resource remains and
`resources pull` restores desired state before retrying.

`resources list/create/delete <worker-id> ...` are recovery and debugging
primitives. They mutate or inspect live state without updating
`xapi.worker.json`; do not use `create` as the normal project workflow.

`build.output` may point to one bundled JavaScript module or to a directory of
Cloudflare code modules. A directory requires `build.main`, relative to that
directory, so CI and local runs select the same entrypoint:

```json
{
  "build": {
    "command": "npm run build",
    "output": "dist",
    "main": "worker.js"
  }
}
```

Directory Artifacts include `.js`, `.mjs`, `.wasm`, `.txt`, and `.bin` modules
in one versioned upload. Relative imports must resolve inside the directory;
package imports must be bundled by the build. The CLI normalizes and hashes the
complete Artifact before `plan` or `push`, so both commands compare identical
bytes. Existing single-file project configurations remain valid.

### Framework builds: publish Wrangler's complete bundle

For a framework that produces a generated Wrangler configuration (for example
vinext), use that configuration to produce the native upload bundle:

```bash
npm run build
npx wrangler deploy --dry-run --config dist/server/wrangler.json --outfile dist/app.worker.bundle
```

Point the project build output to `dist/app.worker.bundle`; omit `build.main`.
Set `assets.directory` to the framework's client output (for example
`dist/client`). Then use `xapi workers plan --env preview` and
`xapi workers push --env preview`. The build command should run both commands
above. `--dry-run` creates a local artifact; it does not publish outside xAPI.

The CLI reads multipart module names, bytes, MIME types and `main_module` from
Wrangler instead of guessing the output directory's contents. It does not
rename chunks or rewrite imports. Assets are packaged with the artifact and
published using CF's asset upload session before the script is activated.
Compatibility date/flags must match the project's Wrangler configuration.
D1/R2/KV binding names must match declared xAPI resources; native account IDs
and resource IDs are not reused. Secrets are set separately through xAPI.
The artifact also preserves `observability.enabled`.

This adapter currently supports the explicitly mapped metadata above, not every
Wrangler setting. Unmapped metadata fails before artifact upload rather than
being silently discarded. Cron triggers are separate from the upload bundle
and must be configured through xAPI schedules. The granular `workers upload`
command is artifact-only; use the project `push` workflow for coordinated
compatibility, resource, secret and asset handling.

Project publishing uses one authenticated multipart Artifact request, then xAPI
stores an immutable content-addressed manifest. Limits are 200 modules / 10 MiB
decoded module content, 10,000 assets / 25 MiB per asset, and 100 MiB total
decoded project content. These are xAPI limits, not a statement of CF's full
native capacity. If exceeded, report the unsupported deployment; never split a
project into unrelated deployments or edit framework output to work around it.

A `PATH_FALLBACK` URL is not a root-hosted Web application URL. Do not rewrite
application routes or configure GitHub callbacks against an invented host.
Use the environment's reported routing state and verify a real reachable
`publicOrigin` with empty `publicBasePath` for a root-hosted acceptance test.

After real preview validation, promote the exact active preview Artifact without
rebuilding it:

```bash
xapi workers promote --to production
```

Production promotion first reads the complete production state. Missing
declared resources appear as `CREATE` and are created only after every budget,
Secret, compatibility, and extra-resource check passes and the user confirms.
Any blocked or undeclared production resource stops the command before all
writes. Use `--retention-price-version <accepted-version>` when a new resource
requires an accepted freeze quote. Promotion then activates the exact preview
Artifact and verifies health before reporting success. To restore code:

```bash
xapi workers rollback --env production --to previous
# Or select one visible historical deployment:
xapi workers rollback --env production --deployment <deployment-id>
```

Rollback restores the selected code Artifact and compatibility settings only.
It does **not** restore or migrate KV, D1, R2, Durable Objects, Queues, Workflows,
schedule state, or Secret values. Inspect application data compatibility before
confirming production rollback.

For CI, provide a least-privilege Key scoped to the selected Worker and keep
both host and key explicit. Non-interactive mode removes prompts but does not
bypass `BLOCKED` plan items or production preflights:

```bash
export XAPI_API_HOST=api.test.xapi.to
export XAPI_KEY="$CI_XAPI_KEY"
xapi workers plan --env preview --format json
xapi workers push --env preview --non-interactive
xapi workers promote --to production --non-interactive
```

When an operation result is uncertain, rerun the same project command. Its
stable idempotency keys and state lookup recover the existing operation rather
than publishing a duplicate. Do not change project inputs merely to force a
retry.

Follow runtime output after deployment:

```bash
xapi workers logs <worker-id> --env preview --tail --since 10m
xapi workers logs <worker-id> --env preview --request-id <request-id>
xapi workers logs <worker-id> --env preview --deployment <deployment-id>
```

## Advanced: granular control-plane commands

Use the commands below for platform diagnosis, explicit resource operations, or
custom automation that cannot use `xapi.worker.json`. They are the primitives
used by the project workflow, not the recommended first-time deployment path.

### Create with explicit budgets

The account needs at least $5 available balance. This is a creation guard, not a prepayment. Both environment budgets are required and must be between $0.10 and $100 per day.

```bash
npx xapi-to workers create \
  --name "Daily research agent" \
  --slug daily-research-agent \
  --template agent \
  --preview-budget 0.25 \
  --production-budget 2 \
  --format pretty
```

Save the returned Worker ID. Preview and production have separate script names, hostnames, budgets, bindings, and state resources.
Each environment also returns `publicUrl`. Use that field for calls: xAPI may point it at the shared dispatcher while a custom hostname is waiting for DNS and TLS. `dispatchUrl` is immediately routable through the platform Worker; `customDomainUrl` is the intended dedicated hostname and must not be presented as ready until its domain status is verified.

### Produce an Artifact, then deploy

Deployments consume an immutable xAPI Artifact, never a mutable directory and never a running Sandbox. The normal path is to build locally or in CI and upload either one bundled ES module or one code-module directory. Sandbox is an optional build provider.

The user's API key authenticates only xAPI control-plane requests. It is never embedded in a bundle, written into a build Sandbox, or sent directly to Cloudflare. Do not put runtime secrets in source; add them later as encrypted Secret bindings.

```js
// src/index.ts
export default {
  async fetch(_request, env) {
    return Response.json({ ok: true, ai: env.XAPI_AI_BASE_URL });
  },
};
```

Build locally or in CI. A single bundled UTF-8 ES module must be at most 1 MiB
and include its runtime dependencies:

```bash
npm run build
npx xapi-to workers upload <worker-id> \
  --file dist/worker.mjs \
  --idempotency-key artifact-2026-08-21
```

For code splitting, upload the output directory and name its entrypoint. The
directory may contain at most 200 supported modules and 10 MiB of decoded
module content. All modules are sent together in one xAPI Artifact request:

```bash
npx xapi-to workers upload <worker-id> \
  --file dist/ \
  --main worker.js \
  --idempotency-key artifact-2026-08-21
```

This directory format is for Worker code modules. For a web application, keep
HTML, CSS, images, and fonts in a separate build directory and declare it in
`xapi.worker.json`. `workers push` packages those files into the immutable xAPI
Artifact and the platform completes Cloudflare's native static-assets upload:

```json
{
  "build": { "command": "npm run build", "output": "dist/worker" },
  "assets": {
    "directory": "dist/client",
    "binding": "ASSETS",
    "htmlHandling": "auto-trailing-slash",
    "notFoundHandling": "single-page-application",
    "runWorkerFirst": ["/api/*"]
  }
}
```

Wrangler imports preserve supported `assets` settings. xAPI accepts up to
10,000 assets, 25 MiB per asset, and 100 MiB of decoded project content in one
multipart Artifact request. Asset content stays separate from Worker modules
and is never silently dropped. The backend stores content-addressed blobs and
reassembles the exact immutable bundle for Cloudflare's native asset upload.

Save the returned Artifact `id`, then deploy that exact Artifact to preview:

```bash
npx xapi-to workers deploy <worker-id> \
  --artifact <artifact-id> \
  --env preview \
  --compatibility-date 2026-08-21 \
  --idempotency-key release-candidate-1
```

After deployment, read the environment `publicUrl` instead of constructing a hostname.
For a web application, `workers plan` reports whether that environment has a
dedicated hostname. Preview path fallback remains useful for API and diagnostic
Workers. A path-prefix-aware application can also use it in production;
root-relative browser URLs and OAuth callbacks require `webAppReady: true`.
Promotion surfaces this as a manual review instead of blocking compatible apps.

```bash
npx xapi-to workers get <worker-id> --format pretty
curl "<preview-publicUrl>/health"
```

### Optional Sandbox build

`workers build` uploads a bounded project snapshot. The control plane creates an ephemeral Sandbox with platform credentials, writes the project, executes the explicit command, stores the output as the same immutable Artifact type, and requests termination in `finally`.

The CLI skips `.git`, `.xapi`, `node_modules`, `dist`, credential directories (`.ssh`, `.aws`, `.gnupg`, `.docker`), `.env*`, package-manager credential files, private-key extensions, and common SSH private-key names.

The optional server-side Sandbox builder currently requires `--output` to
identify one bundled ES module produced by the command:

```bash
npx xapi-to workers build <worker-id> \
  --project . \
  --entrypoint src/index.ts \
  --command "npm install --ignore-scripts --no-audit --no-fund && npm run build" \
  --output dist/worker.mjs \
  --idempotency-key source-2026-08-21
```

The result must have `status: SUCCEEDED`. Save its `artifactId`, not the build `id`, and deploy it with `--artifact`.

Reuse an upload key only for identical normalized Artifact bytes. Reuse a build key only for the exact same source snapshot and parameters. Reuse a deployment key only for the same Artifact and environment. A successful deployment returns `status: ACTIVE`; `DEPLOYING` is not completion and `FAILED` must be surfaced with its error.

After real preview validation, deploy the identical file to production with a new stable key:

```bash
npx xapi-to workers deploy <worker-id> \
  --artifact <same-artifact-id> \
  --env production \
  --idempotency-key production-2026-08-21
```

Workers for Platforms switches User Worker uploads all at once. Treat preview validation as a release gate; do not imply gradual rollout.

## Low-level resource recovery

Managed resources belong to one Worker environment. Preview and production use
separate physical resources even when binding names match. Normal projects use
the commands in “Resource state without drift”; the commands below are for
recovery and custom control-plane automation and do not update
`xapi.worker.json`.

```bash
# Inspect the active provider permissions first. A failed item names the exact
# Cloudflare permission that the platform operator must add.
npx xapi-to workers capabilities --format pretty

# Recovery-only direct live creation
npx xapi-to workers resources create <worker-id> \
  --env preview --type kv --binding STATE

npx xapi-to workers resources list <worker-id> \
  --env preview --format table
```

After a direct low-level create or delete, run `resources pull` or reconcile the
project declaration manually before the next deployment. Treat an `ERROR`
resource as unavailable and surface its provider error.

xAPI Queue creation includes the producer binding, an isolated Cloudflare Queue,
and an xAPI-managed consumer. The User Worker sends a route envelope; the
managed consumer delivers it back to the same Worker environment over an
internal Cloudflare Service Binding:

```js
await env.TASK_QUEUE.send({
  path: "/tasks/summarize",
  method: "POST",
  body: { taskId: "task_123", objectKey: "uploads/report.pdf" },
});
```

`path` must be a local absolute path. Supported methods are `GET`, `POST`,
`PUT`, `PATCH`, and `DELETE`; an omitted path uses `/__xapi/queue`. Delivery is
at least once: a successful `2xx` response is acknowledged, while a failure is
retried. Tell users to make the target route idempotent by stable task ID and
to pass resource identifiers instead of secrets in the message body.

Workflow creation installs a managed Workflow host. User code starts an
instance with `env.AGENT_WORKFLOW.create({ params: { path, method, body } })`,
saves the returned ID, and calls
`(await env.AGENT_WORKFLOW.get(id)).status()` until `complete`, `errored`, or
`terminated`. A returned instance ID means accepted, not completed.

```js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/tasks/summarize") {
      const task = await request.json();
      // Check task.taskId before executing so Queue retries are harmless.
      return Response.json({ completed: true, taskId: task.taskId });
    }
    await env.STATE.put("last-request", new Date().toISOString());
    const rows = await env.DB.prepare("SELECT id, title FROM tasks").all();
    await env.FILES.put("latest.json", JSON.stringify(rows.results));
    return Response.json({ ok: true, tasks: rows.results });
  },
};
```

D1 tables still require an application migration or explicit initialization query. Resource creation does not invent the user's schema. R2 buckets must be empty before Cloudflare allows deletion.

Do not treat resource creation alone as validation. After redeploying, perform
a write/read round trip for a Durable Object, send a Queue message and observe
the target route's durable result, and start a Workflow then poll it to a
terminal state.

## Run persistent schedules

xAPI stores schedules in the control plane rather than inside a short-lived Sandbox. It evaluates the cron expression in the declared IANA timezone, leases each run to prevent duplicate execution across replicas, retries failures up to the configured limit, and keeps run history.

```bash
npx xapi-to workers schedules create <worker-id> \
  --name "refresh research digest" \
  --cron "0 */6 * * *" \
  --timezone Asia/Shanghai \
  --env production \
  --path /tasks/refresh \
  --method POST \
  --body '{"source":"scheduled"}'

npx xapi-to workers schedules list <worker-id> --format table
npx xapi-to workers schedules run <worker-id> <schedule-id>
npx xapi-to workers schedules runs <worker-id> <schedule-id> --format table
npx xapi-to workers schedules pause <worker-id> <schedule-id>
npx xapi-to workers schedules resume <worker-id> <schedule-id>
```

An immediate run exercises the same lease, retry, audit, budget, and Worker route as a cron run. Use it as the release check before enabling production schedules. A schedule is persistent metadata; it does not mean a Worker process stays alive between requests.

### Encrypted Secrets

Prefer `--from-env` so plaintext does not appear in shell history. The control plane encrypts the value at rest and public reads expose only binding name, version, and timestamps. When a script is already active, rotation is applied immediately; otherwise it is applied during the next deployment.

```bash
export MODEL_KEY='...'
npx xapi-to workers secrets set <worker-id> MODEL_KEY \
  --env preview --from-env MODEL_KEY
npx xapi-to workers secrets list <worker-id> --env preview
unset MODEL_KEY
```

Never print the value to verify it. User code can report only whether a secret is configured. Delete explicitly when no longer needed:

```bash
npx xapi-to workers secrets delete <worker-id> MODEL_KEY \
  --env preview --yes
```

## Consumption queries

For the dedicated deployment and cost-reconciliation workflow, install the bundled `xapi-workers` skill. Query `workers billing overview <worker-id> --env preview --json` and `workers billing ledger <worker-id> --env preview --all --json`. The latter follows all pages at one snapshot and fails instead of silently truncating; its completion flag only describes pagination. Reuse its `snapshotTime` with overview `--snapshot-time` before comparing totals. Customer accrued charges, platform-funded amounts and frozen reserves are distinct; missing observations are unknown, not zero. A snapshot covers its UTC billing day, not all history.

## Inspect and manage

```bash
npx xapi-to workers list --format table
npx xapi-to workers get <worker-id> --format pretty
npx xapi-to workers audit <worker-id> --format table
npx xapi-to workers invocations <worker-id> --env preview --format table
npx xapi-to workers logs <worker-id> --env preview --format table
npx xapi-to workers usage <worker-id> --env preview --format pretty
npx xapi-to workers billing-status --format pretty
npx xapi-to workers domains list <worker-id> --format table
npx xapi-to workers artifacts <worker-id> --format table
npx xapi-to workers builds <worker-id> --format table
npx xapi-to workers bindings --format table
npx xapi-to workers resources list <worker-id> --env preview --format table
npx xapi-to workers secrets list <worker-id> --env preview --format table
npx xapi-to workers provider-status
npx xapi-to workers capabilities --format table
npx xapi-to workers artifact-provider-status
npx xapi-to workers build-provider-status
npx xapi-to workers budget <worker-id> preview --daily-usd 0.50
```

`invocations` shows request metadata and aggregate performance. `logs` reads Tail Worker console messages, exceptions, and traces; request/response bodies, headers, and query strings are deliberately excluded. `usage` shows authorization reservations, actual Tail-settled CPU charges, refunds, and the Cloudflare GraphQL reconciliation gap.

The dispatcher preauthorizes the maximum per-request charge before executing user code. It rejects exhausted account/API-key balances and environment daily budgets before dispatch; Tail telemetry settles actual CPU and refunds the unused reservation. If billing authorization is unavailable while enforcement is enabled, execution fails closed.

Each environment receives an exact managed hostname. Use `publicUrl` immediately; it falls back to the shared dispatcher until the dedicated hostname reaches `ACTIVE`. The control plane attaches a Cloudflare Worker Custom Domain, waits for DNS and TLS, and detaches it during Worker deletion. On `ERROR`, inspect the recorded reason and retry explicitly:

```bash
npx xapi-to workers domains list <worker-id> --format pretty
npx xapi-to workers domains retry <worker-id> <domain-id>
```

Bindings are risk-tiered. A catalog entry describes product policy; `workers capabilities` is the live Cloudflare token preflight. A failed D1 item, for example, must identify `D1 Edit` and block D1 creation while leaving unrelated resources usable.

## Delete safely

Only delete when the user asked for it. The CLI requires explicit confirmation:

```bash
npx xapi-to workers delete <worker-id> --yes
```

The backend preflights managed resources (for example, R2 must be empty), deletes active upstream scripts and resources, then marks the Worker soft-deleted. Records have a 30-day retention window. A partial upstream failure leaves the Worker in `DELETING`; report the error and do not say the Worker is deleted or active.

## D1 and R2 data location

Choose the expected primary data-access region when a project creates D1 or R2. The Worker code itself remains globally deployed on Cloudflare's edge network.

```json
{
  "type": "d1_database",
  "bindingName": "DB",
  "location": "apac",
  "readReplication": "disabled"
}
```

Supported location hints are `wnam`, `enam`, `weur`, `eeur`, `apac`, and `oc`. `readReplication` is D1-only and accepts `auto` or `disabled`. Omitting these fields preserves the existing compatible behavior.

Set an environment default when every newly created D1/R2 resource should use
the same location, and optionally enable Cloudflare Smart Placement:

```json
{
  "dailyBudgetUsd": 0.25,
  "defaultResourceLocation": "apac",
  "placementMode": "smart"
}
```

The equivalent targeted command is `xapi workers environment <worker-id>
preview --data-location apac --placement smart`. A resource-level `location`
overrides the environment default. Worker code remains globally deployed;
Smart Placement is native Worker execution metadata, not a fixed Worker region.

Location is creation-time placement. Changing it on an existing binding is blocked because Cloudflare cannot move an existing D1 database or R2 bucket in place. Create a new binding, migrate and verify the data, switch the application binding, and retain the old resource for rollback before deleting it.
