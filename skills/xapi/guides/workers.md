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
export XAPI_API_HOST=test.xapi.to
```

Do not send the key directly to Cloudflare or any non-xAPI host. xAPI owns the Cloudflare account and API token.

## Prefer the project workflow

For a normal application or Agent, use the project commands instead of manually
passing Worker IDs, Artifact IDs, and idempotency keys. `xapi.worker.json` stores
only xAPI-specific desired state and the remote `workerId`; Wrangler remains the
source of truth for the entrypoint, compatibility settings, and Cloudflare-style
bindings. The file contains no credential and may be committed.

Create a new project:

```bash
xapi workers templates
xapi workers init my-agent --template persistent-agent
cd my-agent
xapi workers plan --env preview
xapi workers push --env preview
```

The templates are versioned files packaged with the CLI, so `init` neither
downloads nor executes remote code. The `persistent-agent` starter declares KV,
D1, R2, one Durable Object, one Queue, and one Workflow in both environments,
plus the Secret names `APP_TOKEN` and `MODEL_KEY`. `plan` shows the exact desired
changes; `push` creates environment-specific resources and binds their provider
IDs without writing those IDs into application source. Set secret values after
the Worker ID exists:

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

After real preview validation, promote the exact active preview Artifact without
rebuilding it:

```bash
xapi workers promote --to production
```

Production promotion verifies bindings, Secret names, budgets, Artifact
identity, and health before reporting success. To restore code:

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
export XAPI_API_HOST=test.xapi.to
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

Wrangler imports preserve supported `assets` settings. Cloudflare permits up to
25 MiB per asset and 100,000 assets per version. Asset content stays separate
from Worker modules and is never silently dropped. The current xAPI JSON
Artifact transport accepts at most 12 MiB of decoded modules and assets in one
deployment; split larger sites before upload until the multipart Artifact
transport is available.

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

## Attach isolated Cloudflare resources

Managed resources belong to one Worker environment. Create separate preview and production resources even when their binding names match. User code sees the binding through `env.<NAME>`; it never receives the xAPI Cloudflare account or API token.

```bash
# Inspect the active provider permissions first. A failed item names the exact
# Cloudflare permission that the platform operator must add.
npx xapi-to workers capabilities --format pretty

# Durable key/value state
npx xapi-to workers resources create <worker-id> \
  --env preview --type kv --binding STATE

# SQL and object storage
npx xapi-to workers resources create <worker-id> \
  --env preview --type d1 --binding DB
npx xapi-to workers resources create <worker-id> \
  --env preview --type r2 --binding FILES

# Stateful Agent coordination, asynchronous work, and durable multi-step jobs
npx xapi-to workers resources create <worker-id> \
  --env preview --type do --binding AGENT_STATE --class-name AgentState
npx xapi-to workers resources create <worker-id> \
  --env preview --type queue --binding TASK_QUEUE
npx xapi-to workers resources create <worker-id> \
  --env preview --type workflow --binding AGENT_WORKFLOW

npx xapi-to workers resources list <worker-id> \
  --env preview --format table
```

After creating or deleting a resource, deploy the Worker again so the new binding set becomes active. Durable Object creation needs the exported `--class-name`; xAPI adds its migration during deployment. Queue and Workflow resources are isolated per environment and are exposed only through their declared binding. Treat an `ERROR` resource as unavailable and surface its Cloudflare permission or provisioning error; do not deploy code that assumes it exists.

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
