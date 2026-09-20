---
name: xapi-workers
description: Deploy, operate, and verify applications on xAPI-managed Cloudflare Workers for Platforms through the xAPI CLI. Use for Workers projects, preview/production deployment, KV, D1, R2, Durable Objects, Queues, Workflows, schedules, runtime logs, consumption queries, billing reconciliation, retention, recovery, and test-resource cleanup. Includes real resource acceptance and cost evidence; does not administer a Cloudflare account directly.
---

# xAPI Workers for Platforms

Use the `xapi` CLI (`xapi-to` is the same executable). Verify `xapi workers --help` before using it; an older installation may lack these commands. Do not silently replace managed deployment with Wrangler direct deployment.

## Start with scope

- Identify the control-plane host, Worker ID, and **preview or production** from the project and `workers get`. Test control plane and preview environment are separate choices.
- Authentication precedence: `XAPI_KEY`, `XAPI_API_KEY`, then `~/.xapi/config.json`. Keys need `workers:read` and, for changes, `workers:write`, plus access to the target Worker. A scoped-out Worker can return 404.
- Production API host is `api.xapi.to`; testing uses `XAPI_API_HOST=api.test.xapi.to` (host only). Load secrets from the user's existing secure environment. Never print keys, include them in code/artifacts, or send the xAPI key to a public Worker URL or Cloudflare. Runtime application authentication is separate.
- Start with `workers get <worker-id>`, `workers capabilities`, and `workers resources list <worker-id> --env <environment>`. Read-only inspection needs no extra approval. Use existing user authorization for changes; don't expand cleanup from a test environment to production.
- Treat Worker execution and data placement separately. Worker code remains global. Use environment `defaultResourceLocation` only as the default for newly created D1/R2 resources and `placementMode: smart` only for Cloudflare Smart Placement. Never claim either setting migrates existing data.

## Load the relevant workflow

- **Build/deploy/import/CI:** read [deployment.md](references/deployment.md).
- **Use and verify resources:** read [resources.md](references/resources.md).
- **How much did it cost?** Read [billing.md](references/billing.md) before answering, collecting, or reconciling consumption.
- **Pause/recover/delete/refund:** read [lifecycle.md](references/lifecycle.md) before lifecycle mutations.
- **Buy or bind an xdomain domain:** read [domains.md](references/domains.md). Use the combined CLI command; do not manually create a CNAME to the Dispatcher or expose Cloudflare zone IDs.

## Evidence and completion

Follow a full round: execute real business operations → collect failures → confirm reproduction and affected paths → fix together → rerun affected real operations. Unit tests supplement this; label them separately from live acceptance.

`ACTIVE` deployment, a provisioned resource, an accepted asynchronous job, and a passing HTTP health check prove different things. Verify the intended business result and persisted state. Preserve sanitized evidence: host, environment, IDs, times, request/job IDs, statuses, snapshot and ledger IDs, exact decimal amounts, and unresolved gaps. Exclude tokens, cookies, passwords, and customer file contents.

For incomplete observations report **unknown**, not zero or success. Keep deployment completion, resource behavior, xAPI consumption, storage-day finalization, provider invoice reconciliation, and physical cleanup as separate verdicts. Report only verified outcomes and the next concrete unresolved check.
