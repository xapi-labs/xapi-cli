# Worker Secrets

Cloudflare User Worker secret bindings are the only long-term store for values. xAPI authenticates the caller, resolves the owned account/namespace/script from the Worker environment, forwards the value once, and stores name/status/audit metadata only. There is no reveal or export command.

Preview and production are separate. Configure each environment explicitly; never copy a preview credential into production without the user requesting that exact rotation.

## Choose vars or Secrets

| Value | Configure it in | Takes effect |
| --- | --- | --- |
| Public origin, GitHub App ID/slug, feature flags | Wrangler `vars` | Next code deployment with the rebuilt Artifact |
| OAuth client secret, private key, session/signing secret | `workers secrets set/apply` | Independent Secret write to the selected environment |
| Names the application requires | `environments.preview.secrets` / `production.secrets` in `xapi.worker.json` | Deployment prerequisite check; no values in this file |

A project needing OAuth credentials is a normal application setup requirement. Do not turn every environment variable into a Secret. Identify confidentiality from its purpose, and preserve the application's expected names/types. Public vars are in the deployment Artifact, not a safe place for credentials. Build-time variables compiled into browser assets are public too; runtime Secrets do not configure that build.

Keep ordinary values in the selected Wrangler environment, for example:

```json
{
  "env": {
    "preview": { "vars": { "PUBLIC_APP_ORIGIN": "https://preview.example.com", "FEATURE_ENABLED": true } },
    "production": { "vars": { "PUBLIC_APP_ORIGIN": "https://app.example.com", "FEATURE_ENABLED": false } }
  }
}
```

When a named Wrangler environment exists, its vars do not inherit root vars. Repeat shared public values explicitly. If no named environment exists, the CLI uses root config. Build native bundles for the same selected environment; plan rejects stale or mismatched vars. Do not duplicate public values in `xapi.worker.json` or put them into the Secret file just to satisfy setup instructions. Verify the healthCheck path exists in this application; a SPA HTML fallback returning 200 alone is not a business test.

## First project setup

For an existing linked project, use its saved Worker ID directly. For a new project with required Secrets, choose either supported path:

- **Interactive:** run `workers plan --env preview`, review the missing Secret names, then `workers push --env preview`. After confirmation, push saves the Worker ID and may provision planned resources; it stops before Artifact upload/deploy if Secrets are still missing. Use the returned ID to set values, then rerun push. This first stop is incomplete setup, not a successful release. Do not delete the saved ID or create another Worker.
- **Non-interactive/CI, or to configure Secrets before provisioning resources:** use `workers create` with the name, slug, template and both budgets from `xapi.worker.json` (and placement/location when configured). Save its returned ID as top-level `workerId` in that same file, set Secrets, then plan/push. `create` does not link the local config automatically. A non-interactive push with missing prerequisites intentionally makes no changes.

Creation syntax (substitute the project's actual configuration):

```sh
xapi workers create --name "My service" --slug my-service --template worker \
  --preview-budget 0.25 --production-budget 2
# Save the returned id as xapi.worker.json's top-level workerId.
xapi workers secrets apply <worker-id> --env preview --env-file .env.worker
xapi workers plan --env preview
xapi workers push --env preview --non-interactive
```

If the application needs its assigned origin before its first build, create/link the project first and run `xapi workers get <worker-id> --format json`. Read the selected environment's `publicOrigin`, `publicBasePath`, `publicUrl`, `routingMode`, and `webAppReady`; do not construct a hostname from the slug. For HOSTNAME routing with webAppReady=true, use publicOrigin for origin-valued settings and the application's real callback path for OAuth. PATH_FALLBACK includes a base path and is not interchangeable with a root-hosted application URL; only use it if the app supports that base path. HOSTNAME_PENDING is not proof of an accessible website. If the required routing is not ready, report that routing prerequisite instead of treating it as a missing Secret. Then set public vars and OAuth callback configuration before rebuilding.

Only application Secret values belong in `.env.worker`, never the xAPI management Key. `apply` sets the supplied names; omitted names are not deleted. Missing required values must be provided, not removed from the required-name list to make a plan look ready.

## Safe input

Prefer an existing process environment:

```sh
xapi workers secrets set <worker-id> MODEL_KEY \
  --env preview --from-env MODEL_KEY
```

Use stdin when a password manager emits the value:

```sh
password-manager read MODEL_KEY | \
  xapi workers secrets set <worker-id> MODEL_KEY --env preview --stdin
```

Apply a local env file in one Cloudflare provider version:

```sh
xapi workers secrets apply <worker-id> --env preview --env-file .env.worker
```

The env file must remain outside source control. The CLI reads it in memory and creates no plaintext temporary file. Do not pass values as command arguments, echo them, include them in JSON output, or enable HTTP debug/body logging.

## Verification and uncertain results

```sh
xapi workers secrets list <worker-id> --env preview
xapi workers secrets status <worker-id> --env preview
```

`list` returns xAPI metadata. `status` performs a read-only name comparison against Cloudflare and still never returns values. If a write times out, treat its result as unknown and run `status`; do not automatically replay a captured value. Name presence cannot prove a value. The user may explicitly set their intended value again; do not require credential rotation merely because a response was lost.

JSON lists required Secret names, not values or an exclusive allowlist. Removing a name does not delete its value. Value writes are independent for each environment/key; unrelated resource work and code publication do not create a global Secret lock. The first write to an absent script may briefly coordinate script initialization.

Code deploy, promotion, rollback, pause, and resume preserve provider secrets with Cloudflare native binding inheritance. They do not read values from xAPI or copy values between environments. A missing required binding should block activation rather than opening a route with incomplete runtime configuration.

Delete only with explicit authorization:

```sh
xapi workers secrets delete <worker-id> OLD_KEY --env preview --yes
```
