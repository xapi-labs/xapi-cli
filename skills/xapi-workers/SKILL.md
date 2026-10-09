---
name: xapi-workers
description: Deploy, operate, and verify applications on xAPI-managed Cloudflare Workers for Platforms through the xAPI CLI. Use for Workers projects, preview/production deployment, KV, D1, R2, Durable Objects, Queues, Workflows, Containers, schedules, runtime logs, consumption queries, billing reconciliation, retention, recovery, and test-resource cleanup. Includes real resource acceptance and cost evidence; does not administer a Cloudflare account directly.
---

# xAPI Workers for Platforms

Use the `xapi` CLI (`xapi-to` is the same executable). Verify `xapi workers --help` before using it; an older installation may lack these commands. Do not silently replace managed deployment with Wrangler direct deployment.

## Start with scope

- Identify the control-plane host, Worker ID, and **preview or production** from the project and `workers get`. Test control plane and preview environment are separate choices.
- Authentication precedence: `XAPI_KEY`, `XAPI_API_KEY`, then `~/.xapi/config.json`. Keys need `workers:read` and, for changes, `workers:write`, plus access to the target Worker. A scoped-out Worker can return 404.
- Production API host is `api.xapi.to`; testing uses `XAPI_API_HOST=api.test.xapi.to` (host only). Load secrets from the user's existing secure environment. Never print keys, include them in code/artifacts, or send the xAPI key to a public Worker URL or Cloudflare. Runtime application authentication is separate.
- Start with `workers get <worker-id>`, `workers capabilities`, and `workers resources list <worker-id> --env <environment>`. Read-only inspection needs no extra approval. Use existing user authorization for changes; don't expand cleanup from a test environment to production.

## Load the relevant workflow

- **Build/deploy/import/CI:** read [deployment.md](references/deployment.md).
- **Use and verify resources, including Containers:** read [resources.md](references/resources.md).
- **Configure runtime credentials:** read [secrets.md](references/secrets.md). Values go to the environment's Cloudflare User Worker binding; never ask xAPI to reveal them.
- **How much did it cost?** Read [billing.md](references/billing.md) before answering, collecting, or reconciling consumption.
- **Pause/recover/delete/refund:** read [lifecycle.md](references/lifecycle.md) before lifecycle mutations.
- **Buy or bind an xdomain domain:** read [domains.md](references/domains.md). Use the combined CLI command; do not manually create a CNAME to the Dispatcher or expose Cloudflare zone IDs.

## Evidence and completion

Follow a full round: execute real business operations → collect failures → confirm reproduction and affected paths → fix together → rerun affected real operations. Unit tests supplement this; label them separately from live acceptance.

`ACTIVE` deployment, a provisioned resource, an accepted asynchronous job, and a passing HTTP health check prove different things. Verify the intended business result and persisted state. Preserve sanitized evidence: host, environment, IDs, times, request/job IDs, statuses, snapshot and ledger IDs, exact decimal amounts, and unresolved gaps. Exclude tokens, cookies, passwords, and customer file contents.

For Cloudflare Containers, `ACTIVE` means the Worker upload, matching Durable Object namespace resolution, Container Application reconciliation, and required rollout all completed. A Docker image build or registry push is a separate prerequisite and is never implied by an xAPI Artifact upload.

For incomplete observations report **unknown**, not zero or success. Keep deployment completion, resource behavior, xAPI consumption, storage-day finalization, provider invoice reconciliation, and physical cleanup as separate verdicts. Report only verified outcomes and the next concrete unresolved check.

### Direct artifact uploads and deployment configuration

The CLI checks `artifact-provider/status`. When R2 direct upload is available,
it prepares an owned temporary session, uploads checksummed bytes directly to
R2 without the xAPI key, then asks xAPI to verify and seal the immutable artifact.
There is no deployment/fund hold while uploading. Cancelled or expired sessions
do not block the next push; native deployment starts only after confirmation.
The temporary channel has a 15-minute lifetime; restart the upload after expiry.
Never paste signed object URLs in reports. The legacy upload API remains usable
when the configured storage does not support direct upload.

Use `xapi workers pull --env preview --format json` to inspect the confirmed
active deployment's public configuration and differences against local Wrangler
settings. `--output deployment-snapshot.json` saves that snapshot separately,
preserving unknown native metadata. It does not rewrite Wrangler, download code
or restore business data. `resources pull` refreshes resource IDs/declarations.
The explicit output may be outside the project, for example
`--output ../evidence/deployment.json` or an absolute file path. Relative paths
remain based on the Worker project root; the parent directory must already
exist. Pull protects this project's configuration files and refuses a symbolic
link output. It atomically replaces a chosen existing snapshot and checks for
local changes on a best-effort basis; coordinate simultaneous writers yourself.
Snapshots contain public variable values, but only Secret names; protect local
snapshot files. A legacy deployment without a recorded snapshot reports that
configuration is unavailable. Pull does not force a subsequent deployment.
For `workers push` and `workers rollback`, JSON-mode stdout contains one final
result. Build logs and intermediate plan diagnostics go to stderr; capture the
streams separately when parsing receipts. Confirmation requirements are
unchanged. Pull treats absent and empty Queue binding-alias maps as equivalent
for differences, while preserving the actual saved deployment snapshot.

A successful native deletion with pending financial bookkeeping is already
physically deleted. Inspect returned `financialFinalization` and access status;
do not repeat deletion to repair platform accounting. Funds remain frozen until
verified local close and existing tail-invoice/refund rules permit release.

### 删除确认与部署声明

- 删除回执标记 `deletionCompleted: false` 表示尚未完成；CLI 命令结束不能代替这个字段。若操作记录证明原生 DELETE 已成功、只缺 script GET 确认，SDK `recoverWorkerControlOperation` / `POST /api/v1/workers/:id/control-operations/:operationId/recover` 只补查询和本地收尾，不重复 DELETE。其他资源尚未清理或原生 DELETE 本身 UNKNOWN 时不会通过这条路径重放。
- 回滚操作身份包含当前版本和目标版本；更新后再次选择相同历史版本会发起一次新的显式回滚，不复用旧成功回执。
- 部署快照 `requiredSecrets` 记录项目环境和所选 Wrangler 环境的必需 Secret 名称，不保存值。

### Platform authentication failures

A complete CF 401 authentication rejection is a recorded failed write, not an
unknown accepted mutation. Report the platform credential error accurately.
Do not automatically replay the write or expand permissions. Incomplete
responses/transport failures remain UNKNOWN; old UNKNOWN records need their
own evidence and are not silently rewritten by this classifier.
