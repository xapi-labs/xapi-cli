# Worker Secrets

Cloudflare User Worker secret bindings are the only long-term store for values. xAPI authenticates the caller, resolves the owned account/namespace/script from the Worker environment, forwards the value once, and stores name/status/audit metadata only. There is no reveal or export command.

Preview and production are separate. Configure each environment explicitly; never copy a preview credential into production without the user requesting that exact rotation.

## Safe input

Prefer an existing process environment:

```sh
MODEL_KEY='...' xapi workers secrets set <worker-id> MODEL_KEY \
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

`list` returns xAPI metadata. `status` performs a read-only name comparison against Cloudflare and still never returns values. If a write times out, treat its result as unknown and run `status`; do not automatically replay a captured value. If the intended value cannot be proven, obtain or generate a fresh credential and rotate it.

Code deploy, promotion, rollback, pause, and resume preserve provider secrets with Cloudflare native binding inheritance. They do not read values from xAPI or copy values between environments. A missing required binding should block activation rather than opening a route with incomplete runtime configuration.

Delete only with explicit authorization:

```sh
xapi workers secrets delete <worker-id> OLD_KEY --env preview --yes
```
