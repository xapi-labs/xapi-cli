# Application access and first deployment

## Toolchain and CLI build

Use Node.js 22.12.0 or newer for this template's current Wrangler toolchain.
Check `node --version` before `npm install`. The xAPI CLI's own lower Node
minimum does not guarantee that the generated project's development tools run.

Use the same xAPI CLI build that initialized this project. Published-build
examples below use `npx xapi-to`; no global `xapi` command is required.
For an unreleased local checkout, replace `npx xapi-to` with
`node /absolute/path/to/xapi-cli/dist/index.js`. A local package version is not
proof that these template changes are already on npm. Do not regenerate this
project with an older release that lacks APP_TOKEN authentication.

## Application access

`GET /health` is public. `POST /chat` requires
`Authorization: Bearer <APP_TOKEN>` before any model request is sent.
Missing APP_TOKEN returns 503; a missing or incorrect authorization header
returns 401. MODEL_KEY is a separate, server-only model credential.
Never put your deployment XAPI_KEY or MODEL_KEY in a browser request.

New Agent/Chat projects default to a preview daily Worker budget of $0.25.
Model calls have their own charges against MODEL_KEY, outside that Worker budget.
Use a separate runtime Key with a spending limit configured in the xAPI Console;
this does not imply a restriction to AI-only services. Production has no default
daily limit. Choose a production budget before promotion.
Explicit `--preview-budget USD|none` overrides the new-project default.

Load APP_TOKEN and MODEL_KEY into your secure environment without printing them,
then create/link the project once:

```bash
node --version
npm install
npx xapi-to workers create --config xapi.worker.json
# Use the returned Worker ID below.
npx xapi-to workers secrets set <worker-id> APP_TOKEN --env preview --from-env APP_TOKEN
npx xapi-to workers secrets set <worker-id> MODEL_KEY --env preview --from-env MODEL_KEY
npx xapi-to workers plan --env preview
npx xapi-to workers push --env preview
```

Check /health, then send a small message with APP_TOKEN to verify the business
route. For local Wrangler development, put the two runtime values in the
ignored .dev.vars file before running npm run dev. Preview and production Secrets
are separate; configure the intended production values before promotion.
