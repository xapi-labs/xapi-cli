# Persistent Agent template

This template declares all managed resources in `xapi.worker.json`. During
`xapi workers push --env preview`, xAPI plans and provisions them, injects the
resulting bindings, uploads the artifact, and deploys it. Secrets are declared
by name only and must be set separately.

## Routes

- `GET /health` — public readiness check.
- `POST /setup` — initializes D1, KV, and R2 sample records.
- `POST /chat` — calls DeepSeek through `ai.xapi.to` and stores session state.
- `GET /state?session=demo` — reads Durable Object session state.
- `POST /queue` — submits asynchronous work to `TASK_QUEUE`.
- Native `queue(batch, env)` — verifies signed tasks and commits each D1 outcome before ack.
- `POST /queue-consume` — compatibility HTTP callback for previously deployed clients.
- `POST /workflow` — starts `AGENT_WORKFLOW`.
- `POST /workflow-step` — Workflow callback used by the managed runtime.
- `POST /cron` — schedule target; enqueue recurring work here.

Interactive routes require `Authorization: Bearer <APP_TOKEN>`. The generated
code authenticates Queue message bodies and Workflow callbacks with an HMAC envelope derived
from that token (the token itself is never placed in a message) and accepts
`/cron` only from xAPI's verified scheduler path.

## First deployment

```bash
npm install
xapi workers plan --env preview
xapi workers push --env preview
xapi workers secrets set <worker-id> APP_TOKEN --env preview --from-env APP_TOKEN
xapi workers secrets set <worker-id> MODEL_KEY --env preview --from-env MODEL_KEY
WORKER_URL=https://... APP_TOKEN=... npm run test:remote
```

Create a schedule after deployment:

```bash
xapi workers schedules create <worker-id> \
  --name heartbeat --cron "*/15 * * * *" --env preview --path /cron
```


## Queue acceptance

Run `/setup` before submitting work. Queue sends a signed payload to the native `queue()` handler; the platform does not route `message.body.path` to `fetch()`. The handler verifies the signature, uses the producer's stable `taskId` as D1's event key with `INSERT OR IGNORE`, and acknowledges only after that write succeeds. Invalid signatures and failed writes explicitly request retry. Repeated delivery cannot create another outcome for the same task.

The smoke script submits Queue and Workflow work; its `accepted` result is not proof of task completion. For Queue acceptance, inspect the D1 `agent_events` row with `id = taskId` and `kind = queue`, and correlate the delivery/invocation receipt. For an existing fetch-only Worker, export a native Queue handler and redeploy; changing the producer envelope alone does not make the platform call an HTTP route. No automatic replay or background repair of previously accepted messages is performed.
