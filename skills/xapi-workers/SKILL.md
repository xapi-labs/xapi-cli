---
name: xapi-workers
description: Deploy, operate, and verify applications on xAPI-managed Cloudflare Workers for Platforms through the xAPI CLI. Use for Workers projects, preview/production deployment, KV, D1, R2, Durable Objects, Queues, Workflows, Containers, schedules, runtime logs, consumption queries, billing reconciliation, retention, recovery, and test-resource cleanup. Includes real resource acceptance and cost evidence; does not administer a Cloudflare account directly.
---

# xAPI Workers for Platforms

Use the `xapi` CLI (`xapi-to` is the same executable). Verify `xapi workers --help` before using it; an older published installation may lack these commands even when the repository already contains them. Stop and report the version mismatch instead of silently replacing managed deployment with Wrangler direct deployment. Wrangler `deploy --dry-run --outfile` is allowed only as a local framework packaging step; the resulting Artifact must still be published with xAPI.

## Start with scope

- Identify the control-plane host, Worker ID, and **preview or production** from the project and `workers get`. Test control plane and preview environment are separate choices.
- Authentication precedence: `XAPI_KEY`, `XAPI_API_KEY`, then `~/.xapi/config.json`. Keys need `workers:read` and, for changes, `workers:write`, plus access to the target Worker. A scoped-out Worker can return 404.
- Production API host is `api.xapi.to`; testing uses `XAPI_API_HOST=api.test.xapi.to` (host only). Load secrets from the user's existing secure environment. Never print keys, include them in code/artifacts, or send the xAPI key to a public Worker URL or Cloudflare. Runtime application authentication is separate.
- For an existing linked project, start with `workers inspect [worker-id] --env <environment>` and `workers capabilities`. For a new unlinked project, use capabilities and plan; inspect needs a real Worker ID. Use `workers plan --env <environment>` when a local project is available and desired-state drift matters. `inspect` reads current runtime state only. `plan` runs the configured local build with credential-shaped environment variables removed, validates the exact Artifact, and compares it with live state without writing to the xAPI control plane. It also shows the budget cap, active price-book visibility, and usage-dependent resource changes; never present those estimates as an accrued invoice. Use existing user authorization for changes; don't expand cleanup from a test environment to production.
- Treat Worker execution and data placement separately. Worker code remains global. Use environment `defaultResourceLocation` only as the default for newly created D1/R2 resources and `placementMode: smart` only for Cloudflare Smart Placement. Never claim either setting migrates existing data.

## Before creating a Worker or resource

Briefly tell the user: when retention is enabled, provisioning/deployment freezes the quoted retention reserve; an empty project record does not freeze funds. Storage can keep costing money while paused. After insufficient balance starts retention, reaching the reserve cleanup threshold can trigger automatic deletion. Unused reserve is returned after confirmed cleanup and the required settlement window; recharging does not automatically resume service. Retention estimates are not guaranteed fixed retention periods.

This is an informational reminder, not a separate approval gate. Use the user's existing creation/deployment authorization; do not require a `retention accept` call. xAPI records the default policy with the first retention hold. Read the current resource quote and pass its exact price version when required; see [lifecycle.md](references/lifecycle.md) for details. If an older server still returns `retention_policy_acceptance_required`, report the server-version mismatch instead of silently accepting policy or bypassing xAPI.


## Load the relevant workflow

- **Build/deploy/import/CI:** read [deployment.md](references/deployment.md).
- **Use and verify resources, including Containers:** read [resources.md](references/resources.md).
- **Configure public vars and runtime credentials (including first-project setup):** read [secrets.md](references/secrets.md). Secret values go to the environment's Cloudflare User Worker binding; never ask xAPI to reveal them.
- **How much did it cost?** Read [billing.md](references/billing.md) before answering, collecting, or reconciling consumption.
- **Pause/recover/delete/refund:** read [lifecycle.md](references/lifecycle.md) before lifecycle mutations.
- **Bind a custom domain or buy an xdomain domain:** read [domains.md](references/domains.md). Use combined attach for xdomain, or challenge plus manual TXT and attach for an eligible zone without an xdomain record. Do not manually create a CNAME to the Dispatcher or expose Cloudflare zone IDs.

## Evidence and completion

Follow a full round: execute real business operations → collect failures → confirm reproduction and affected paths → fix together → rerun affected real operations. Unit tests supplement this; label them separately from live acceptance.

`ACTIVE` deployment, a provisioned resource, an accepted asynchronous job, and a passing HTTP health check prove different things. Verify the intended business result and persisted state. Preserve sanitized evidence: host, environment, IDs, times, request/job IDs, statuses, snapshot and ledger IDs, exact decimal amounts, and unresolved gaps. Exclude tokens, cookies, passwords, and customer file contents.

For Cloudflare Containers, `ACTIVE` means the Worker upload, matching Durable Object namespace resolution, and the required Container Application create/update plus rollout request were accepted and recorded. Cloudflare may still be converging the native rollout; verify the application resource and business route separately. A Docker image build or registry push is a separate prerequisite and is never implied by an xAPI Artifact upload.

For incomplete observations report **unknown**, not zero or success. Keep deployment completion, resource behavior, xAPI consumption, storage-day finalization, provider invoice reconciliation, and physical cleanup as separate verdicts. Report only verified outcomes and the next concrete unresolved check.
