# Managed Sandbox Compute Guide

Use xAPI Sandbox when a user or AI agent needs an isolated cloud computer for
code execution, file processing, CI reproduction, a temporary Web/API preview,
GPU work, or a resumable multi-step job. It is a billable lifecycle service,
not an ordinary per-call action, so cleanup and audit are part of task success.

## Contents

- [Choose the shortest safe lifecycle](#choose-the-shortest-safe-lifecycle)
- [Authentication and gateway selection](#authentication-and-gateway-selection)
- [Inspect offerings and quote first](#inspect-offerings-and-quote-first)
- [One-shot execution](#one-shot-execution)
- [Multi-step agent lifecycle](#multi-step-agent-lifecycle)
- [Files and artifacts](#files-and-artifacts)
- [Web preview and background processes](#web-preview-and-background-processes)
- [Suspend and resume](#suspend-and-resume)
- [GPU jobs](#gpu-jobs)
- [Parallel agents](#parallel-agents)
- [OpenAI SandboxAgent with xAPI DeepSeek](#openai-sandboxagent-with-xapi-deepseek)
- [Audit, history, and billing](#audit-history-and-billing)
- [Run the real Playground acceptance suite](#run-the-real-playground-acceptance-suite)
- [Failure and interruption recovery](#failure-and-interruption-recovery)
- [AI operating rules](#ai-operating-rules)

## Choose the shortest safe lifecycle

| Need | Preferred command | Cleanup behavior |
|---|---|---|
| Run one command and get stdout | `sandbox run` | Terminates automatically |
| Several exec/file calls | `create` + primitives | Agent must terminate |
| Inspect price/capabilities | `offerings`, `quote` | No instance created |
| Publish a temporary port | `port` after starting a server | Terminate afterward |
| Pause a reusable workspace | `suspend` | Storage may keep billing |
| Inspect prior work/cost | `history`, `get`, `audit` | Read-only |

Prefer `sandbox run` whenever the task fits one remote shell command. A shorter
lifecycle reduces orphan risk and returns one machine-readable JSON result.

## Authentication and gateway selection

The CLI reads `XAPI_KEY`, then `XAPI_API_KEY`, then `~/.xapi/config.json`.
Do not print, interpolate into a URL, or pass the key inside the remote command.
The CLI sends Sandbox credentials only to `*.xapi.to` or localhost.

Production uses `sandbox.xapi.to`. The test service is selected explicitly:

```bash
export XAPI_SANDBOX_HOST=sandbox.test.xapi.to
```

Omit `--provider` (or use `--provider auto`) for lowest-price compatible
selection. Pin only when the task or test requires a particular provider:

```bash
npx xapi-to sandbox offerings --provider cf-edge --format table
npx xapi-to sandbox quote --provider daytona --capabilities exec,files
```

Provider pinning derives a controlled hostname such as
`cf-edge.sandbox.test.xapi.to`; it does not accept arbitrary provider URLs.
For production, canonical `--provider daytona` and `--provider e2b` are mapped
to the deployed `daytona-sandbox.sandbox.xapi.to` and
`e2b-sandbox.sandbox.xapi.to` aliases; their test hosts remain
`daytona.sandbox.test.xapi.to` and `e2b.sandbox.test.xapi.to`.
Available providers and capabilities can change, so inspect `offerings` rather
than assuming a static capability matrix.

## Inspect offerings and quote first

`offerings` shows provider-declared resources, capabilities, lifecycle support,
and hourly estimates. `quote` applies requirements without creating or billing
an instance:

```bash
npx xapi-to sandbox offerings --format table

npx xapi-to sandbox quote \
  --capabilities exec,files \
  --cpu 2 \
  --memory 4 \
  --max-hourly-usd 0.20 \
  --format pretty
```

Use `--format table` for a compact comparison and JSON when a complete quote ID
or nested rate card must be copied. Table truncation is marked with `…`.

Use `--requirements '<json>'` for fields that do not have a shortcut. Treat
`--max-hourly-usd` as a hard guardrail chosen before creation. A quote is
short-lived; create promptly or quote again.

## One-shot execution

`sandbox run` performs quote → create → wait for `RUNNING` → exec → terminate →
read final cost. Its default price ceiling is `$0.20/hour`:

```bash
npx xapi-to sandbox run \
  --capabilities exec \
  --command 'python3 -c "print(sum(range(1000)))"' \
  --format pretty
```

Arguments after a bare `--` are joined into the remote command:

```bash
npx xapi-to sandbox run -- node --version
```

Read these output fields first:

- `result.exitCode`, `result.stdout`, `result.stderr`: remote result;
- `cleanup.operationStatus`, `cleanup.state`: teardown result;
- `finalState`: should be `TERMINATED` (or provider-terminal `FAILED`);
- `totalCost`: service-calculated cost, not a client estimate.

A remote non-zero exit code becomes the local CLI exit code after cleanup, so
shells and AI runners can detect failure without parsing stdout.

`--keep` suppresses automatic termination. Use it only after the user explicitly
asks to retain the instance and understands that billing continues.

## Multi-step agent lifecycle

Use granular commands when an agent must alternate between files and commands.
Capture the instance ID without logging credentials:

```bash
box_json="$(npx xapi-to sandbox create \
  --capabilities exec,files \
  --idempotency-key "job-${JOB_ID}" \
  --wait)"
box_id="$(printf '%s' "$box_json" | jq -r '.id')"

npx xapi-to sandbox wait "$box_id" --state RUNNING --wait-timeout 5m

cleanup() {
  npx xapi-to sandbox terminate "$box_id" --wait-timeout 5m || true
}
trap cleanup EXIT INT TERM

npx xapi-to sandbox file write "$box_id" task.md --file ./task.md
npx xapi-to sandbox exec "$box_id" --command 'npm test' --timeout 120
npx xapi-to sandbox file read "$box_id" report.json --output ./report.json
```

Use a stable business `--idempotency-key` when the caller might repeat create
after a lost response. Do not blindly repeat mutations with a new key: the first
request may already have created a billable instance.

The CLI rejects unknown Sandbox flags before making a request. Exact
`--offering-id` selection cannot be combined with `--max-hourly-usd`; select by
requirements under a ceiling or create from a previously checked quote instead.
Successful create output returns `clientIdempotencyKey`. If `create --wait`
fails after acceptance, retain the structured `instanceId`, `observedState`,
`clientIdempotencyKey`, and recovery commands from stderr, then inspect and
terminate the instance as appropriate.

## Files and artifacts

Write inline text or a local file:

```bash
npx xapi-to sandbox file write <id> instructions.txt --content 'Run tests.'
npx xapi-to sandbox file write <id> input.csv --file ./input.csv
```

Read and list artifacts:

```bash
npx xapi-to sandbox file list <id> --path . --depth 3
npx xapi-to sandbox file read <id> output.json
npx xapi-to sandbox file read <id> output.zip --output ./output.zip
```

Local `--output` uses create-new semantics and refuses to overwrite an existing
file. The CLI base64-encodes local input bytes so binary files survive transfer.

## Web preview and background processes

For providers that declare both `backgroundExec` and `ports`, use the explicit
provider-managed background command. Daytona needs this mode because deleting a
foreground command session also kills shell-backgrounded child processes:

```bash
box_json="$(npx xapi-to sandbox create \
  --provider daytona \
  --capabilities exec,backgroundExec,ports \
  --wait)"
box_id="$(printf '%s' "$box_json" | jq -r '.id')"
port=25319

cleanup() { npx xapi-to sandbox terminate "$box_id" --provider daytona || true; }
trap cleanup EXIT INT TERM

npx xapi-to sandbox exec "$box_id" --provider daytona --background --command \
  "python3 -m http.server $port --bind 0.0.0.0"
npx xapi-to sandbox port "$box_id" "$port" --provider daytona
```

`--background` returning a session/command ID is only launch acknowledgement.
Poll the public URL with bounded retries and verify an expected marker. If the
port response contains `headers`, include them in external requests; they can
carry a provider preview token. Do not emulate this mode with `nohup ... &` on
an Offering that does not declare `backgroundExec`.

Cloudflare currently uses its provider-specific command/preview behavior rather
than the standard background session capability. Pin `cf-edge` only when the
user explicitly wants Cloudflare. Port `8080` is the currently verified preview
path for the deployed bridge:

```bash
box_json="$(npx xapi-to sandbox create \
  --provider cf-edge \
  --capabilities exec,files,ports \
  --wait)"
box_id="$(printf '%s' "$box_json" | jq -r '.id')"
port=8080

cleanup() { npx xapi-to sandbox terminate "$box_id" --provider cf-edge || true; }
trap cleanup EXIT INT TERM

npx xapi-to sandbox file write "$box_id" index.html \
  --provider cf-edge \
  --content '<!doctype html><h1>xAPI preview</h1>'

npx xapi-to sandbox exec "$box_id" --provider cf-edge --command \
  "nohup python3 -m http.server $port >/tmp/server.log 2>&1 & \
   for i in 1 2 3 4 5 6 7 8 9 10; do \
     curl -sf http://127.0.0.1:$port/ && exit 0; sleep 1; done; \
   cat /tmp/server.log >&2; exit 1"

npx xapi-to sandbox port "$box_id" "$port" --provider cf-edge
```

Validate that the returned public URL serves the expected marker before calling
the workflow successful. Quick Tunnel DNS/TLS readiness can be intermittent, so
use bounded retries (for example, one request every two seconds for up to two
minutes). If it still fails, verify localhost again, record the URL/error, and
terminate instead of leaving the instance billing. The URL stops working after
termination. Quick Tunnels are for previews; use a stable, supported named
tunnel or application deployment for production traffic.

## Suspend and resume

Check offering lifecycle fields first because not every provider supports an
explicit suspend operation:

```bash
npx xapi-to sandbox offerings --format pretty
npx xapi-to sandbox suspend <id>
npx xapi-to sandbox get <id>
npx xapi-to sandbox resume <id>
```

The CLI waits for `SUSPENDED` and `RUNNING` by default. Files may persist while
memory/processes do not; rely on the selected offering's declared lifecycle
semantics. Suspension can reduce compute cost but storage may still accrue cost.
If `lifecycle.suspension.supported` is false (as with a current cf-edge
offering), do not call suspend/resume; terminate and create a new instance.

## GPU jobs

Request GPU resources instead of assuming a provider or model. The current
RunPod offering is a managed GPU resource without standard `exec`/`files`, so
inspect its declared extension and obtain connection details instead of sending
an impossible shell command:

```bash
npx xapi-to sandbox quote \
  --gpu-count 1 \
  --gpu-model L4 \
  --capabilities exec \
  --max-hourly-usd 2.00

npx xapi-to sandbox create \
  --provider runpod \
  --gpu-count 1 \
  --max-hourly-usd 2.00 \
  --wait

npx xapi-to sandbox extension <id> runpod.connection_info \
  --provider runpod \
  --input '{}'

npx xapi-to sandbox terminate <id> --provider runpod
```

GPU work is usually more expensive. Quote first, set a deliberate ceiling, use
a command timeout, and terminate immediately after artifacts are retrieved.

## Parallel agents

Give each agent a separate instance. Do not share a mutable workspace when the
goal is isolation. Use unique idempotency keys and record every instance ID.
Run cleanup for all IDs even if one agent fails; then verify `sandbox list` has
no active instance from the job.

Limit concurrency based on budget. Parallel creation multiplies reservation and
running cost, even when the individual hourly quote is small.

## OpenAI SandboxAgent with xAPI DeepSeek

The OpenAI Agents SDK keeps the model provider and sandbox provider separate.
Use the SDK's OpenAI-compatible model provider for DeepSeek through
`https://ai.xapi.to/v1`, and the xAPI adapter for Sandbox compute:

```ts
import { OpenAIProvider, Runner } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { XapiAgentsSandboxClient } from 'xapi-to/openai-sandbox';

const sandboxApiKey = process.env.XAPI_SANDBOX_KEY;
const aiApiKey = process.env.XAPI_AI_KEY;
if (!sandboxApiKey) throw new Error('XAPI_SANDBOX_KEY is required');
if (!aiApiKey) throw new Error('XAPI_AI_KEY is required');

const sandbox = new XapiAgentsSandboxClient({
  apiKey: sandboxApiKey,
  sandboxHost: 'sandbox.test.xapi.to',
  provider: 'daytona',
  model: 'deepseek-v4-pro',
});
const modelProvider = new OpenAIProvider({
  apiKey: aiApiKey,
  baseURL: 'https://ai.xapi.to/v1',
  useResponses: false,
  strictFeatureValidation: true,
});
const runner = new Runner({ modelProvider, tracingDisabled: true });
const agent = new SandboxAgent({
  name: 'xAPI DeepSeek sandbox agent',
  model: 'deepseek-v4-pro',
  defaultManifest: new Manifest({ root: sandbox.workspaceRoot }),
  capabilities: [shell()],
  instructions: 'Use shell to complete and verify the task.',
});

try {
  const result = await runner.run(agent, 'Write SDK_OK=42 to result.txt and read it.', {
    maxTurns: 8,
    sandbox: { client: sandbox },
  });
  console.log(result.finalOutput);
} finally {
  await sandbox.lastSession?.close();
}
```

Use `useResponses: false` because `ai.xapi.to` currently implements the OpenAI
Chat Completions-compatible protocol. Disable tracing unless a separate OpenAI
telemetry credential is configured; do not send an xAPI key to OpenAI tracing.
Keep `XAPI_AI_KEY` and `XAPI_SANDBOX_KEY` separate for a mixed environment:
the former is sent only to production `ai.xapi.to`, while the latter is sent
only to `sandbox.test.xapi.to`. A production key with both permissions may be
injected into both variables, but a Sandbox test key must not be assumed to
have production AI Gateway access.
The current adapter honestly supports an empty Manifest and Shell capability.
It rejects Manifest file/mount/environment materialization until those mappings
are implemented and tested.

Run the real SDK + DeepSeek + Daytona acceptance test from the CLI repository:

```bash
XAPI_SANDBOX_KEY='<sandbox-test-key>' \
XAPI_AI_KEY='<ai-production-key>' \
npm run test:sandbox:openai -- \
  --host sandbox.test.xapi.to \
  --provider daytona \
  --model deepseek-v4-pro
```

The script writes a redacted report, audits operations/events/usage/billing,
terminates its instance, and fails if any active test instance remains.

## Audit, history, and billing

Inspect current state and service-calculated total:

```bash
npx xapi-to sandbox get <id> --format pretty
```

Read individual audit streams:

```bash
npx xapi-to sandbox audit <id> --kind operations
npx xapi-to sandbox audit <id> --kind events
npx xapi-to sandbox audit <id> --kind usageSegments
npx xapi-to sandbox audit <id> --kind billingPeriods
npx xapi-to sandbox history --state HISTORY --page-size 100
```

`history` is a separate paginated endpoint for prior instances; it is not an
`audit --kind`. Filter it with `--search`, `--from`, and `--to` when reconciling
a specific agent run.

For acceptance, verify:

1. create/exec/file/port/terminate operations have terminal success statuses;
2. state events reach `TERMINATED`;
3. no usage segment or billing period remains open;
4. `totalCost` agrees with settled billing periods;
5. `sandbox list` shows no active instance from the test.

Use the returned billing data rather than recomputing cost from wall-clock time.

## Run the real Playground acceptance suite

From an xapi-cli development checkout, run the same nine real workflows shown
in the Web Playground. The suite uses normal CLI configuration, never accepts a
key on argv, records audit/billing evidence, terminates every tracked instance
in `finally`, and fails if any instance created after its baseline remains
ACTIVE (unrelated pre-existing account instances are still reported):

```bash
npm run test:sandbox:playground -- --host sandbox.test.xapi.to

# Focus a rerun or avoid the higher-cost GPU reservation
npm run test:sandbox:playground -- --host sandbox.test.xapi.to --only 8,9
npm run test:sandbox:playground -- --host sandbox.test.xapi.to --skip-gpu
```

The JSON report path is printed at completion. A provider capacity or HTTP 402
balance error is an external test precondition failure, not proof that the
scenario works; retain the error and a previous successful provider-specific
report separately. For Cloudflare, success requires an external HTTP 200 with
the expected page marker, not merely a returned Quick Tunnel hostname.

## Failure and interruption recovery

`sandbox run` handles ordinary exceptions, remote non-zero exits, `SIGINT`, and
`SIGTERM` by attempting termination before it exits. `SIGKILL`, machine loss, or
a network partition cannot run local cleanup.

After an uncertain interruption:

```bash
npx xapi-to sandbox list --format table
npx xapi-to sandbox get <suspected-id>
npx xapi-to sandbox terminate <suspected-id> --wait-timeout 5m
```

If terminate returns a state-change conflict, inspect state and retry after the
in-flight transition finishes. Do not treat an accepted operation response as
completion; wait for the instance's observed terminal state.

## AI operating rules

When exposing Sandbox to an AI agent:

1. Inject the xAPI key in the tool execution layer; never place it in prompts,
   files, environment dumps, remote commands, logs, or model-visible output.
2. Start with `offerings`/`quote` when selection or budget is uncertain.
3. Prefer `sandbox run` for one-shot work and granular primitives only when the
   task needs persistent state across calls.
4. Set capabilities and a price ceiling narrowly enough for the task.
5. Use `--background` only when the selected Offering declares
   `backgroundExec`; then verify the listening port independently.
6. Treat instance IDs as cleanup obligations and keep them in structured state.
7. Put termination in `finally`; on interruption, enumerate and reconcile any
   uncertain instances.
8. Report stdout, exit code, final state, cost, and cleanup outcome separately.
9. Never claim success from page/API structure alone—execute the relevant path,
   verify its artifact or public URL, then check audit and residual instances.
