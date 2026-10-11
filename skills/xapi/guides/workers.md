# xAPI Hosted Workers

Container deployment settings accept custom `instanceType` objects such as
`{"vcpu":1,"memory_mib":3072,"disk_mb":5500}`, including Wrangler import,
environment-specific deployment and rollback. MiB memory and decimal MB disk
use existing compute rates and the five-minute exposure calculation. Confirm
actual native rollout/size before claiming a configuration switch completed;
native sizing/account errors remain upstream errors. Native `dev` and
`standard` aliases are accepted with the same capacity pricing as `lite` and
`standard-1`. Compute coverage does not replace seven-day retention funding;
use the server quote and preserve Worker/DO protection. The server tracks funding and receipts; the CLI does not require a generic
independent Container retention-product quote. See `xapi-workers/references/deployment.md`.

Worker `ACTIVE` and a Container rollout's completion are separate facts.
An ACTIVE retry with the same deployment idempotency key returns the original
deployment with its observed Container progress, without another rollout or
funding freeze. Read `deployments[].containerRollout` from `workers get --format json` for the
recorded configuration progress; do not resubmit a deployment because native
confirmation is pending. Seven-day preservation covers code/configuration and
native persistent resources, not automatic recovery of ephemeral disk files.

Use this guide when the user wants to deploy an API, Webhook, Chat endpoint, scheduled JavaScript task, or persistent Agent to xAPI-managed Cloudflare Workers for Platforms.

## Choose Worker or Sandbox

- Use `workers` for continuously addressable HTTP/WebSocket applications, Webhooks, scheduled tasks, and persistent Agent entrypoints. The control plane currently manages KV, D1, R2, Durable Objects, Queues, Workflows, Secrets, and persistent schedules. Use `workers capabilities` for optional read-only provider diagnosis; provisioning reports its own upstream result.
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

Before test-domain discovery or `xapi workers domains attach`, set
`XAPI_ACTION_HOST` to the actual test Action service host obtained from the
operator's configuration; do not guess its hostname. `XAPI_API_HOST` and
`XAPI_ACTION_HOST` must target the same platform environment. Public actions
such as `xapi call domain.list` and the domain/DNS actions used by attach use
the separate Action host, which defaults to `action.xapi.to` even when the API
host is set to test. An `UNAUTHORIZED` response from that production Action
host with a test key is not by itself evidence of a backend defect; check both
host settings first. `--env preview` does not select the test platform hosts.

Do not send the key directly to Cloudflare or any non-xAPI host. xAPI owns the Cloudflare account and API token.

## Prefer the project workflow

For a normal application or Agent, use the project commands instead of manually
passing Worker IDs, Artifact IDs, and idempotency keys. `xapi.worker.json` stores
only xAPI-specific desired state and the remote `workerId`; Wrangler remains the
source of truth for the entrypoint, compatibility settings, and static assets.
Managed KV, D1, R2, Durable Object, Queue, and Workflow declarations belong in
`xapi.worker.json`. The file contains no credential and may be committed.

Use `xapi workers inspect --env preview` for one read-only operational view of
the linked Worker. It reports the active environment, routing, Artifact,
Deployment, resource and Secret metadata, domains, and billing freshness.
Unavailable sources remain `UNKNOWN`. Use `plan` for desired-state comparison.
Plan runs and validates the configured local build, then compares that exact
Artifact and desired resources with the live snapshot. It performs no remote
writes. `inspect` never builds, deploys, probes application routes, or reads
Secret values.

Choose the `init` form from the project you actually have:

| Starting point | Command | What `init` does |
| --- | --- | --- |
| Empty directory / new service | `xapi workers init my-agent --template persistent-agent` | Creates a complete Worker package from a versioned local template. |
| Existing React, Vite, Vue, or static Next.js package | `cd app && xapi workers init` | Detects the framework and adds a dependency-free ESM adapter, Wrangler config, desired-state file, and ignore entries; preserves the package manifest and lockfile. |
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
# Install the application's existing dependencies using the returned nextSteps.
xapi workers plan --env preview
xapi workers push --env preview
```

The generated files are `xapi.worker.json`, `wrangler.jsonc`, and
`xapi-worker/index.mjs`, plus entries in `.gitignore`. The adapter is directly
uploadable ESM; it needs no esbuild compilation or added tooling dependencies.
`package.json`, existing dependencies, scripts, and lockfiles remain unchanged.
`build.command` reuses the application's original build script, and `build.output`
points to `xapi-worker/index.mjs`. Review the generated diff before installing
dependencies. A package inside a monorepo inherits the repository's declared
package manager or lockfile; use the install and build commands printed by
`init` rather than substituting npm. For a fresh clone, these `nextSteps` use
`npm ci`, a frozen-lockfile install, or modern Yarn's immutable install when the
matching lockfile exists, and a normal install otherwise.
Re-running `init` is not a synchronization command;
once `xapi.worker.json` exists, manage it with the project and resource commands.

Use `--framework react|vite|vue|next` only for ambiguous package metadata.
Static Next.js requires `output: 'export'`. For Next.js SSR, do not generate a
generic SPA Worker: run `npx vinext check` and `npx vinext init`, then import the
generated Wrangler configuration. Local development uses the application's
existing development script; there is no separate `workers dev` command.

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

Wrangler `vars` are public string or JSON bindings. They remain in the referenced
Wrangler config and travel with the immutable deployment artifact, including
multipart uploads. A named environment uses its own `vars` (no root inheritance).
Native `.bundle` output must match the selected environment; rebuild if it is
stale. Module/directory builds include the selected config's public vars.
Changing vars changes the artifact identity. Do not put credentials here: use
`secrets` and `workers secrets set`. The importer report shows names, never values;
it does not read `.env` or `.dev.vars`. Variable names must not collide with
resource, asset or Secret bindings. Ordinary deployment rollback restores the
public vars stored in the selected artifact as well as its code.

Public variables use replacement by default: omitted plaintext/JSON bindings are
removed. Top-level `keep_vars: true` retains omitted bindings of both types;
`false` or absence does not. `env.<name>.keep_vars` is ignored with an import
warning and cannot override the root. Native `keep_bindings` retains only the
specified public types, and native JSON-string bindings stay `json`. Secrets are
independent and always kept across code deployment.

Plan shows `SET`, `RETAIN`, `REMOVE`, and `REPLACE` using live target Cloudflare
names/types without reading values, only during management. Promotion uses the
selected immutable Artifact's declarations against production, never local
preview output or local production vars. Deploy the matching backend before
upgrading the CLI: both `/api/v1/workers/:id/environments/:environment/variables`
and `/api/v1/workers/:id/artifacts/:artifactId/variable-configuration` GET reads
are required. Read failures stop preflight; never substitute empty variable state.
See [public variable decisions](../../xapi-workers/references/deployment.md#public-variable-decisions)
for the full retention and rollout contract. Local checks do not prove cloud
verification.

The project workflow does not require Git. Git repository, branch, and commit
are optional provenance, not authentication and not a deployment prerequisite.
It runs the configured build, creates the remote Worker when `workerId` is
absent, safely creates or updates declared resources, uploads one immutable
Artifact, deploys preview, waits for the active state, and runs the configured
health check. `push` binds the resources declared for that environment. Removing
a declaration unbinds it on the next deployment; the resource, data and storage
charges remain until an explicit destruction request. The project workflow never deletes an extra stateful resource or Secret.
Extra Secret values remain independent and are not deleted by changing declarations.

## Resource state without drift

There are only two resource states:

- `xapi.worker.json` is the desired state that belongs in Git. It contains
  binding names and portable options, never Cloudflare or xAPI resource IDs.
- xAPI is the live state. `plan` reads it every time and compares it with the
  selected environment in `xapi.worker.json`. A metadata-only `.xapi/resource-sync-*`
  baseline is used by `resources pull` to merge edits; it is not authoritative live state.

Choose the command by intent:

| Intent | Command | State changed |
| --- | --- | --- |
| Create a declaration | `resources add` | Local desired state only |
| Adjust a declaration | `resources update` | Local desired state only |
| Adopt live-only resources | `resources pull` | Live read, then safe local merge |
| Stop declaring a resource | `resources remove` | Local desired state only |
| Delete resource data | `resources destroy --yes` | Local desired state and one live environment |
| Preview exact deployment changes | `workers plan` | Local build output only |

Use this normal flow to add a resource:

```bash
xapi workers resources add --env both --type kv --binding CACHE
xapi workers resources add --env both --type d1 --binding DB --location apac
xapi workers resources add --env both --type r2 --binding FILES --location apac
xapi workers resources add --env both --type do --binding ROOM --class-name Room
xapi workers resources add --env both --type queue --binding JOBS
xapi workers resources add --env both --type workflow --binding PIPELINE
# To run your exported native Workflow class:
xapi workers resources add --env both --type workflow --binding NATIVE_PIPELINE --class-name Pipeline --workflow-name pipeline
xapi workers resources update --env preview --type d1 --binding DB \
  --location weur --read-replication disabled
xapi workers plan --env preview
xapi workers push --env preview
```

`plan` reports the current and desired daily budget, active price-book
visibility, and any new metered Worker/resource declarations. Exact charges
remain usage-dependent; the CLI does not invent request, CPU, storage, or
operation volume. Use `inspect` and billing views for accrued usage and billing
freshness.

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

The first `pull` imports supported healthy resources, enriches compatible
declarations and reports conflicting local definitions. Subsequent pulls compare
the local JSON and live inventory with the previous observations: preserve local
edits (including removed bindings), adopt remote-only changes and report conflicting
edits to the same binding without overwriting either side. It never writes provider
IDs into JSON, changes native resources or copies Secret values. Confirmed removal
from remote inventory can remove its unchanged local declaration. A live pending
resource keeps its prior remote observation and existing declaration; pending status
is not interpreted as remote removal. `--env both`
keeps independent baselines. A local file edit during the read aborts the merge.

`resources remove` changes desired state only. Review `plan` and deploy to remove
the Worker binding while retaining the physical resource. To also delete its data,
back it up and use the separate destructive command:

```bash
xapi workers resources destroy --env preview --binding FILES --yes
```

`destroy` accepts one environment, removes the declaration before requesting
live deletion, and reports a deletion request rather than claiming immediate
physical destruction. If the request fails or its result is unknown, inspect it
and explicitly retry `destroy` against the same binding. Do not recreate the
resource or infer zero usage/refund from a timeout.

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

When `package.json` contains a framework `build:worker` script with Wrangler's
`--outfile`, `init --from-wrangler` infers both the command and `.bundle` path.
Review the generated `xapi.worker.json`. If the framework uses a custom script,
provide the values during import instead of editing an ambiguous default:

```bash
xapi workers init --from-wrangler dist/server/wrangler.json \
  --build-command "pnpm run package:worker" \
  --build-output dist/app.worker.bundle
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
Named `env.preview`/`env.production` bindings and vars do not inherit root
declarations; when a named environment is absent, the default Wrangler config
continues to map to that xAPI slot. `vars` stay public Artifact/deployment
configuration, with native `plain_text`/`json` types; they are not Secret names.
Promotion of the same Artifact applies production vars, including an explicit
empty override when production has none. Variable-only changes participate in
deployment identity; rollback restores the recorded public override and preserves
current Secret values. Re-import with `--force` corrects desired declarations and
preserves the linked Worker ID; it does not delete old physical resources.
The deploy API accepts `variables: {vars: {...}, varTypes?: {...}}`; omission uses
Artifact defaults, `{vars: {}}` clears them, and `varTypes` can preserve a native
JSON string. `secrets.required` declares actual Secret names. Secret Store
references remain an explicit owned-reference adaptation gap, not ordinary Secrets.
Ordinary native upload configuration is retained in `nativeMetadata`, including
placement, user-selected limits, logpush and observability extensions; xAPI does
not maintain a supported-field allowlist for these options. The original Wrangler
native bundle is authoritative for new configuration translations. If an unknown
source setting is present, emit it with the original Wrangler configuration using
`wrangler deploy --dry-run --outfile`; a plain module cannot prove that setting
was compiled. Account/resource references still require owned mappings; this is
not a per-user feature switch. User Tail references now resolve an owned xAPI Worker slug/ID (optional preview/production target; default producer environment), preserving the platform metering Tail. Explicit empty tail_consumers clears user Tails. Managed DO/Container lifecycle reuploads retain deployed public/native configuration and frozen physical Tail targets. Verify actual Tail execution, pause behavior and native CPU ledger attribution separately. Service/RPC, Secret Store and log destinations still need verified mappings.

Native bundles may include local Durable Object bindings, matched by both
binding name and class to declared `durable_object` resources. Container classes
must match `xapi.worker.json` Container definitions; their configuration is kept
in the uploaded artifact and its hash. Wrangler-generated Container application
names are not reused as provider identities. External DO script/namespace
references still require a supported ownership-aware mapping; do not remove the
reference silently to make validation pass.

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
Deploy the matching workers-service backend before using these CLI contracts; follow that backend release’s migration and rollout instructions.

Cron triggers are separate from the upload bundle
and project push/promote map `triggers.crons` to tracked xAPI schedules. The granular `workers upload`
command is artifact-only; use the project `push` workflow for coordinated
compatibility, resource, secret and asset handling.

Artifact uploads match the backend's 64 MiB decoded Worker module budget,
100 MiB decoded modules plus assets budget, and 25 MiB per static asset.
The CLI selects multipart above JSON/base64 transport budgets; the receiver
record and metadata budgets still apply. Do not split a project into unrelated
deployments or edit framework output to work around these transfer budgets.

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
Blocked or incompatible declared production resources stop the command before
writes. A production resource omitted from the JSON is shown in the plan and
unbound by promotion, but its physical data and storage charges remain. Review
that effect before confirming; physical deletion is a separate action. The plan displays funding estimates; the server atomically checks and freezes resource funds.
`--retention-price-version` is optional when the user explicitly selects a version,
not a mandatory per-resource quotation workflow. Promotion then activates the exact preview
Artifact and verifies health before reporting success. To restore code:

```bash
xapi workers rollback --env production --to previous
# Or select one visible historical deployment:
xapi workers rollback --env production --deployment <deployment-id>
```

Rollback restores the selected code Artifact, compatibility settings, and Container configuration. A historical deployment can use the same Artifact with a different Container configuration.
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

Daily budgets are optional. Omit them or set `dailyBudgetUsd: null` in the project to use the account balance without a user-selected daily cap; actual usage is still billed. An explicit nonnegative budget applies to that environment. Creation has no fixed $5 threshold; real paid deployment/resource operations still require their quoted funds and retain billing evidence.

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

The user's API key authenticates only xAPI control-plane requests. It is never embedded in a bundle or sent directly to Cloudflare. When the CLI runs in your own Sandbox, provide your authorized key only to the CLI; keep it out of source and build artifacts. Do not put runtime secrets in source; add them later as encrypted Secret bindings.

```js
// src/index.ts
export default {
  async fetch(_request, env) {
    return Response.json({ ok: true, ai: env.XAPI_AI_BASE_URL });
  },
};
```

Build locally or in CI. A single bundled UTF-8 ES module must include its runtime
dependencies; above the legacy 1 MiB text limit, the CLI uses the bundle channel:

```bash
npm run build
npx xapi-to workers upload <worker-id> \
  --file dist/worker.mjs \
  --idempotency-key artifact-2026-08-21
```

For code splitting, upload the output directory and name its entrypoint. The
directory may contain up to 64 MiB of uncompressed Worker modules; there is no
200-module cutoff. All modules are sent together in one xAPI Artifact request:

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
100,000 assets, 25 MiB per asset, and 100 MiB of decoded project content in one
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

### Build in your execution environment

For this MVP, build with the CLI on your computer, CI runner or user-owned xAPI
Sandbox, then upload the Artifact and deploy through xAPI. A user-owned Sandbox
has its own billing/lifecycle; Worker deployment does not create another build
Sandbox or automatically delete yours. Use only your authorized credentials,
never platform/provider credentials, and keep secrets out of build artifacts.

The separate managed `workers build` API retains the main-branch unavailable
contract (`worker_cloud_build_disabled` / `USER_BUILD_BUDGET_NOT_IMPLEMENTED`).
New user delegation and customer cloud-build billing are deferred; do not use
that command as a required deployment step or claim setting a platform build Key
enables it. Existing build history remains readable. See the current
[Worker deployment reference](../../xapi-workers/references/deployment.md).

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
# Optional read-only diagnosis. GET success does not prove Edit/Write access;
# inspect errorCategory, errorCodes and provider headers before blaming permissions.
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

xAPI Queues bind an isolated producer Queue and deliver native events to the same owned Worker environment. The platform passes the complete message body to the application's `default.queue(batch, env, ctx)`; it does not route a body `path` to `fetch()`:

```js
await env.TASK_QUEUE.send({
  taskId: "task_123", objectKey: "uploads/report.pdf",
});

export default {
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const { taskId, objectKey } = message.body;
        // Initialize this table through the application's migration/setup path.
        await env.DB.prepare(
          "INSERT OR IGNORE INTO task_results (id, object_key) VALUES (?, ?)"
        ).bind(taskId, objectKey).run();
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
  // Keep the application's fetch handler alongside queue().
};
```

Delivery is at least once. Use a stable task ID for the actual business operation and acknowledge only after its durable result succeeds. Invalid or failed tasks must request retry; a successful send is not completion. Preserve application authentication (the persistent-agent template signs its message payload) and never place platform credentials in message bodies. An existing fetch-only consumer must export a native handler and redeploy; no background replay or implicit HTTP path fallback is provided. Verify the stored business result and delivery receipt, then check metering separately.

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

Prefer `--from-env` so plaintext does not appear in shell history. Values go to the
native Secret endpoint; public reads expose metadata only. Set, replace and delete
values independently in preview or production. JSON lists required names, not values
or an allowlist. Removing a name from JSON does not delete its value. Code deployment,
promotion and rollback preserve the destination environment's current Secrets.
If the native script does not exist yet, the first set initializes a placeholder;
it does not overwrite an existing script whose local deployment record is missing.
Failure/timeout ends that attempt; inspect metadata and explicitly retry as needed.

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

`invocations` shows request metadata and aggregate performance. `logs` reads Tail Worker console messages, exceptions, and traces; request/response bodies, headers, and query strings are deliberately excluded. `usage` is a bounded diagnostic of daily usage, recent invocation charges (including postpaid receipts), ledger entries, and related wallet transactions. Historical reservation/refund records may still appear; use the billing queries above for complete ledger reconciliation.

Runtime billing is postpaid: the dispatcher checks signed admission state valid for at most five minutes, and Tail telemetry supplies actual request/CPU usage for settlement. It does not reserve a maximum charge and refund the difference per request. Balance and budget checks use periodically refreshed state, so daily budgets are not hard per-request spending caps. Admission fails closed when the state is unavailable, expired, or denies execution. `billing-status` reports platform billing configuration and readiness, not an individual consumption bill.

Each environment receives an exact managed hostname. Use `publicUrl` immediately; it falls back to the shared dispatcher until the dedicated hostname reaches `ACTIVE`. The control plane attaches a Cloudflare Worker Custom Domain, waits for DNS and TLS, and detaches it during Worker deletion. On `ERROR`, inspect the recorded reason and retry explicitly:

```bash
npx xapi-to workers domains list <worker-id> --format pretty
npx xapi-to workers domains retry <worker-id> <domain-id>
```

For your own hostname, use `workers domains attach --xdomain-domain-id` for
automated DNS, or `workers domains challenge --env ENV --hostname HOSTNAME`
followed by manual TXT and `domains attach --env ENV --challenge-file PATH`
when no xdomain record exists. Both require an authoritative zone in the
platform Cloudflare account; they do not support arbitrary external accounts.
Read [the domain workflow](../../xapi-workers/references/domains.md) before
binding. Platform-generated addresses need no separate domain purchase.

`workers capabilities` probes read access, not resource creation. Its existing `permission` label names the permission normally needed for the resource (for example, `D1 Edit`), while `verifiedPermission=READ_ACCESS` proves only this GET. Do not block creation solely because a cached probe failed: report the actual provisioning response. `AUTHENTICATION` means 401/403; `RATE_LIMITED` means 429; neither by itself proves a missing product entitlement. Safe error codes, Retry-After, rate-limit policy and CF-Ray are returned for diagnosis. Concurrent probes share a cache; credential changes discard it. This does not retry any business write.

## Delete safely

Only delete when the user asked for it. The CLI requires explicit confirmation:

```bash
npx xapi-to workers delete <worker-id> --yes
```

Whole-Worker deletion performs the owned resource cleanup, including disposable R2 objects, deletes upstream scripts/resources and retains the Worker deletion record. A low-level bucket deletion can still require an empty bucket; do not confuse it with the whole-Worker cleanup flow. Records have a 30-day retention window. A partial upstream failure leaves the Worker in `DELETING`; report the error and do not say the Worker is deleted or active. Environment lifecycle actions wait up to 120 seconds. If the response times out, the result is `UNKNOWN`; read `workers retention show <worker-id> --env ENV --format json` before deciding whether to retry. No lifecycle write is automatically replayed.

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

Native `.bundle` binding declarations for D1, R2, KV, Queue, DO and Workflow map to the owned project resources. For local managed declarations, imported physical identities are replaced with owned resource mappings; DO/Workflow exported classes must match the declaration. An explicit external `script_name` is preserved as a cross-script reference, never stripped to reclassify it as a local class. Such references require verified owned mapping; unresolved external DO/Workflow mappings are reported as adaptation gaps, not claimed as supported. Artifact uploads automatically use multipart when needed, with backend limits of 64 MiB modules, 100 MiB total decoded content and 25 MiB per static asset. Wrangler Queue consumer batching/retry/concurrency and same-environment dead-letter settings map to owned Queue resources after deployment activation. Native `triggers.crons` use UTC scheduled-handler run receipts through the backend scheduler. Omitted Queue consumers preserve existing delivery; explicitly run `workers resources queue-consumer disable` before removing the declaration. Omitted Cron declarations preserve existing triggers; an explicit `crons` array synchronizes this project/environment’s owned scheduled-handler triggers and `[]` clears them. Manual platform HTTP schedules are unaffected. User `tail_consumers` are mapped to owned Worker targets while retaining platform metering; unknown consumer fields still report a missing backend mapping instead of being silently discarded. For scheduled-handler Cron, the CLI checks the UTC five-field shape; the matching backend validates Cloudflare syntax, including names and L/W/#, with weekdays 1–7. The original expression is passed as controller.cron without local next-run prediction. HTTP schedules keep their existing timezone and 0/7=Sunday convention. This remains platform-scheduler delivery to the native handler, not installation of a CF Cron Trigger on the dispatch script. Configuration and ACTIVE status are separate from actual handler delivery, billing and future timer verification.


The legacy managed source-build format has a 20 MiB decoded-source and 18 MiB serialized JSON transport budget; its public build entry remains unavailable in this MVP. Source paths may contain Unicode or spaces while staying relative to the project; symlinks and credential files are excluded. There is no CLI 200-file, 1 MB single-file or 2 MiB project gate. Build in your execution environment and upload the artifact with multipart. Artifact budgets and legacy source-build transport are separate.

Project and managed-build commands have no xAPI 1000-character cap; forward the exact nonempty command. Request-body capacity and existing execution deadlines still apply, and the managed-build identity includes the full command. Preserve the original identity when a result is uncertain.

An explicit later `push` can retry unchanged source after a terminal FAILED journal matches its operation and proves no successful or uncertain provider writes. Accepted effects are NOT_DISPATCHED/NO_WRITES, or REJECTED with at least one rejected step and no write evidence. The new identity derives from that journal and remains stable during lost-response reconciliation; this is not automatic retry or a blanket promise for `promote`. Unknown or partially confirmed writes recover the original operation journal; they are never reissued as a new deployment automatically. `resources pull` imports ready peers and reports pending/deleting statuses without deleting declarations; plan/push still reject a pending binding actually required by the application.

For deploy/rollback and Secret writes, an explicit `worker_control_operation_pending` admission response with `pendingReason=TARGET_BUSY`, `requestAccepted=false` and `requestDispatched=false` allows the CLI to wait up to 60 seconds. It reads only the blocking operation by ID, then submits the unchanged request when that operation releases its target with a confirmed result. Waiting progress is on stderr; the server has not queued this request. Generic errors, old pending responses without this evidence, unknown writes and transport timeouts are not automatically retried by this waiting mechanism. Cancellation and unavailable status reads stop waiting; no operation is forcibly unlocked. Requires the existing `workers:read` permission for status observation.

Secret names are forwarded exactly as nonempty strings, including names accessed through `env[name]`; there is no xAPI 64-character name limit or 128-item batch limit. Provider validation, ownership and binding-conflict checks still apply. Optional automatic retention does not control resource deposit funding. Both environments prepare protected seven-day retention funds, separately tracked from operating reserves. Duplicate identities reuse their financial receipts; historical funds remain traceable. After at least 168 hours, preservation continues while spendable retention funds remain, with system cleanup on exhaustion. User deletion is unavailable during financial retention; add sufficient funds and explicitly recover first. System cleanup remains independent.

Container metering `container_location_pricing_gap` preserves independently observed CPU/memory/disk, withholds incomplete egress buckets and keeps source coverage unresolved. Missing egress is not a zero cost or a reason to delete the resource. See `skills/xapi-workers/references/billing.md` for reconciliation.

Binding names remain exact nonempty strings; long, Unicode, dollar, hyphen and prototype-property names are supported. Use bracket access for names such as `env["binding-name"]`. Do not apply the old 64-character binding or 128-character class cap. Exported class names retain JavaScript identifier syntax, including Unicode, for generated deployment/lifecycle code. Physical provider resource names and ownership checks are separate requirements.

The currently used CF `exports` upload path has a native 128-character class-name maximum. Preserve that upstream failure; do not silently rename classes or retry a user write. The legacy `migrations` path has different acceptance behavior.

Completed owner recovery now attempts ordinary postpaid publication immediately. Check `accessPreparation`: `PENDING` means access preparation is still waiting; do not repeat the completed recovery operation. `PUBLISHED` confirms publication and still requires an actual service probe. Balance, fresh billing evidence and fixed expiry remain effective; a publication error does not delete the Worker or replay the user's action.

Artifact uploads continue while bytes move; they use a no-progress timeout, with no automatic write replay. Use `workers push --build-timeout 30m` for builds in your execution environment; the default is 15 minutes. Legacy managed-build parameters retain their 10-minute default, but that public entry remains unavailable. See `xapi-workers/references/deployment.md` for stage budgets and recovery, and `xapi-workers/references/billing.md` for protected seven-day retention funds, operating reserves and historical receipts.


### Queue producer names and resource identity

Several producer names for the same Wrangler logical Queue use one owned physical Queue and one retention hold. Imported environment `queueBindings` keeps the logical Queue mapped to its existing managed resource through producer/consumer/dead-letter changes; re-import preserves the linked Worker ID. Do not rename user code bindings or provision another Queue merely to add an alias. Bundle/deployment `queueBindingAliases`, including explicit empty production overrides, participate in deployment identity and rollback. Alias names remain occupied by their Queue when checking Secret/resource conflicts.

The adapter does not yet migrate an original primary name to another logical Queue while preserving the original Queue under a new producer name; an explicit mapping error prevents mixing messages. Producer delay and other listed native gaps require adaptation and tests rather than platform user quotas. HTTP Pull is supported by the explicit Queue management commands below. Backend support must ship before this CLI alias workflow. Actual native event execution, Queue operation billing and post-delete tail refunds remain separate acceptance checks.


### Queue creation and HTTP Pull

Queue resources remain owned by the selected Worker/environment and billed to its account. Creating a Queue no longer creates a default consumer or helper Worker. Producer-only deployments therefore do not require a native `queue()` handler. Declared Worker consumers are configured after deployment activation; existing consumers are preserved unless explicitly changed or disabled.

Configure HTTP Pull with `workers resources queue-consumer configure <worker-id> <resource-id> --env preview --body '{"type":"http_pull","settings":{"batch_size":10,"visibility_timeout_ms":30000}}'`. Use `workers resources queue-messages pull ... --body '{"batch_size":10}'` and `queue-messages ack ... --body '{"acks":[{"lease_id":"<returned-lease>"}],"retries":[]}'`. Messages/options retain native semantics. This uses the Queue management API and does not require a Worker handler or an obsolete Wrangler HTTP Pull declaration. See [resource reference](../../xapi-workers/references/resources.md) for full commands, explicit consumer type changes, lifecycle and billing semantics. Native Queue operations are billed from the existing Queue-ID collector, not from HTTP request count; no new fee or resource-level product is introduced.

Completed system funding suspension or owner deletion may include `accessPreparation` for publishing a denied runtime state, just as resume publishes an allowed state. `PENDING` publication does not replay or reverse a completed resource action. Native execution admitted during a platform-paused interval keeps usage evidence but incurs zero user charge with `PLATFORM_PAUSED` provenance; this is distinct from an ordinary application's billable 503 response and does not waive storage/retention charges. DO deletion financial close reuses the finalized exact namespace/class proof and preserves the 48-hour running tail.

Public build commands may contain paths such as `xapi-backend/worktrees/...`; that public prefix is not an API credential. Actual embedded credentials and credential fields still belong outside tracked project configuration. Upstream metering quota errors defer the current collection pass without changing unvisited cursors, user permissions, or prices; native usage remains pending until evidenced. Lifecycle status now uses the same seven-day policy for Preview and Production.

Initial deployment access preparation does not wait for the global background billing scan. State publication is coordinated per environment script, so unrelated Workers do not share that wait. A conflicting publication for the same script is ordered within the existing 15-second preparation budget; the service then rechecks the active deployment and real account/window evidence. It never steals a lease, extends the financial permission window, or replays deployment. A pending publication or failed public health check does not delete the ACTIVE deployment or its resources; inspect the recorded state and actual service access before any explicit retry. Provider acceptance still does not prove immediate edge propagation.

Confirmed deletion and cached admission: if both admission time and native execution-start time are at or after the immutable DELETED event, preserve actual request/CPU usage but charge the user zero, with PLATFORM_DELETED and the lifecycle event ID in the receipt/ledger. A request admitted before deletion remains billable even if its Tail arrives later; resource/storage charges keep their existing rules. Historical incorrect charges are corrected by append-only refund entries linked to the original charges, never by rewriting receipts or deleting usage.
## Activation, public readiness and deletion

The CLI reports code activation separately from public readiness. After an `ACTIVE` deployment, a platform `workers_postpaid_state_unavailable` 503 gets read-only health observation within the 75-second total window; this never repeats the deployment. Persistent readiness failure keeps the deployment ACTIVE and access UNVERIFIED. Ordinary application errors use the normal health checks.

Whole-Worker deletion waits up to 120 seconds. A timeout is UNKNOWN and does not trigger a repeated write; inspect the existing Worker, retention state and receipts. Confirmed R2 deletion closes the running reserve while preserving the original 48-hour GAP tail and retained event-capture queue. These retained billing records are not evidence that the user bucket still exists, and provisional usage is not free usage.

### Direct upload and deployment pull

With configured R2 artifact storage, `push`/`upload` sends bytes through an owned
15-minute temporary channel. The xAPI key is never sent to R2. Confirmation seals
verified immutable content before deployment; upload cancellation does not
occupy the deployment target. Expiry requires a new upload. Legacy upload remains
available for other storage modes.

Transient file lists live in private R2, with small DB references. A new explicit
preparation of identical content may reuse a channel and still grants the full
15-minute window, so an earlier CLI exit does not shorten the next attempt.
After the existing24h cleanup grace, a failed expired session may be absent;
start a new upload. Confirmed artifact receipts and deployment history remain.
There is no new per-owner file/session quota.

`xapi workers pull --env preview --output deployment-snapshot.json` reads the
active deployment snapshot and local differences, and saves a separate public
configuration snapshot. It preserves native metadata without rewriting Wrangler
or reading Secret values; public vars may contain sensitive application data.
`--output` accepts an absolute path or a project-root-relative path, including
`../evidence/deployment.json`. Choose an existing parent directory. Configuration
files and symbolic-link output endpoints are protected; an existing chosen
snapshot is replaced atomically. Concurrent change detection is best effort,
so avoid simultaneous writers to that output file.
Use `resources pull` for local resource declarations. Historical deployments
without a saved configuration return an explicit unavailable result.
In JSON mode, `workers push` and `workers rollback` write one final receipt to
stdout and build/plan diagnostics to stderr. Keep those streams separate for
automation; this does not change confirmation behavior. An absent Queue
binding-alias map or ordinary native metadata map compares equally to an empty map; the saved
snapshot still retains its original representation.

### Existing project identity and native upload recovery

Link an existing Worker with top-level `workerId` in `xapi.worker.json`; do not use `worker.id` or `worker.workerId`. A new unlinked project is created and linked by push. Wrangler import uses its imported name; template `--name`/`--slug` flags cannot be combined with `--from-wrangler`. Review generated `worker.name`/`worker.slug` before pushing.

After an upload response is lost, the original operation remains UNKNOWN. Recovery reads the exact deployment and operation tags from CF. Only when **all** writes are confirmed and the native observation matches may a later explicit push create a new publication identity. It does not replay the old write. Script tags do not confirm Container or Workflow writes. Conflicting targets require evidence; unrelated targets are not gated. The immutable server execution deadline is capped at 15 minutes and each provider request uses the remaining time; local build and temporary upload deadlines remain separate.

A complete native CF authentication rejection (HTTP 401, parsed failure envelope with code 10000) is recorded as REJECTED, not UNKNOWN. The platform must repair its credentials; this does not blame the user balance, grant new permissions or automatically replay the write. Incomplete bodies, connection loss and unrelated errors remain UNKNOWN. Historical UNKNOWN operations are not silently rewritten by this change.

### Explicit D1/R2 data export

Use `xapi workers d1 export [worker-id] --env preview|production --binding DB
--output ./fresh-backup.sql` or `xapi workers r2 export [worker-id] --env
preview|production --binding FILES --output ./fresh-directory`. Omit Worker ID to
use project `workerId`; `--config PATH` selects another project file. Binding
metadata requires `workers:read` **and** export needs separate
`workers:data:read`; management read/write does not grant data access.

D1 polls at most 600 seconds with `PENDING/COMPLETE/FAILED/EXPIRED` states. Use the
displayed `exportId` with `--export-id ID` and a fresh output to resume the same
job. Expired jobs need a new explicit start without that flag. If the first start
response is lost without an ID, the user can explicitly re-run export for the
same Worker/environment/binding with a fresh `--output` and no `--export-id`.
The backend returns the original ID of an existing same-owner/resource `PENDING`
job; an unconfirmed start already marked `FAILED` can allow a new job on this
explicit re-execution. For HTTP 409 `worker_export_start_retry`, explicitly try
again later with a fresh output, using the same scoped xAPI credentials.
No POST or lost result is automatically replayed. R2 processes live pages (default 100, maximum
200), with four reused download connections, `If-Match` and ETag/byte verification.
Concurrent writes can change listing or objects: this is not an atomic snapshot.

Fresh outputs are private (0700 directories, 0600 files), without symlink or
clobbering. Safe hash filenames map original keys and response metadata in a
private JSONL manifest. Failed/interrupted files remain partial; R2 restart uses
a new directory. Ordinary output/errors omit object keys, signed URLs and raw
upstream errors. Direct unexpired HTTPS GET downloads allow only
`.r2.cloudflarestorage.com`, no credentials/explicit ports/redirects, and optional
`If-Match`. Preserve signed URL/header bytes; never send xAPI credentials to CF.
Connection/header and idle budgets are 30/60 seconds, with no short total cap on
progress. Read [the export workflow](../../xapi-workers/references/resources.md#export-d1-and-r2-business-data)
for manifests and recovery. Local key safety does not establish native CF key
support. Imports are outside this feature; optional Container scripts/bridges are
not required. Export completion does not establish migration completion.
