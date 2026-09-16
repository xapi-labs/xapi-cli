# Deployment and CI

## Project workflow

```sh
export XAPI_API_HOST=api.test.xapi.to
xapi workers templates
xapi workers init my-service --template persistent-agent
cd my-service
xapi workers plan --env preview
```

For an existing project use `xapi workers init --from-wrangler ./wrangler.jsonc` (TOML also supported). Read its import report; do not auto-accept unsupported settings. xAPI creates environment-specific resources; do not copy another Cloudflare account's IDs.

`xapi.worker.json` holds desired xAPI state and Worker ID; Wrangler holds entrypoint, compatibility and binding declarations. The persistent-agent template declares all six managed resource types; it is a starter, not proof those paths work. Install/build according to the generated project instructions. Inspect plans for missing permissions, prices, secrets, budget, and policy requirements.

```sh
xapi workers push --env preview
xapi workers get <worker-id> --format json
xapi workers secrets set <worker-id> APP_TOKEN --env preview --from-env APP_TOKEN
xapi workers logs <worker-id> --env preview --since 10m
```

If provisioning requires an accepted retention quote, follow lifecycle.md and pass its exact `--retention-price-version VERSION`; do not invent a version. Supply secrets when the Worker exists and rerun the unchanged project command if a missing secret blocked deployment. Never report a blocked preflight as successful deployment.

Use the environment's returned `publicUrl` for actual requests. A custom-domain URL needs verified DNS/TLS readiness; do not construct a hostname or infer readiness from the organization name. Use application authentication, never the control-plane key, on this URL.

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

For explicit artifact operations: `workers upload <worker-id> --file dist/worker.mjs --idempotency-key <stable-key>`, then `workers deploy <worker-id> --artifact <artifact-id> --env preview --idempotency-key <stable-release-key>`. Reuse a key only for identical inputs. `workers build` is an optional managed Sandbox build, not a requirement for deploying locally built code.
