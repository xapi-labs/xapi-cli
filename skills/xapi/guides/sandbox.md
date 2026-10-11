# Managed Sandbox Compute Guide

Use xAPI Sandbox when a user or AI agent needs an isolated cloud computer for
code execution, file processing, CI reproduction, a temporary Web/API preview,
GPU work, or a resumable multi-step job. It is a billable lifecycle service,
not an ordinary per-call action, so cleanup and audit are part of task success.

## Contents

- [Product boundary](#product-boundary)
- [Choose the shortest safe lifecycle](#choose-the-shortest-safe-lifecycle)
- [Authentication and gateway selection](#authentication-and-gateway-selection)
- [Inspect offerings and quote first](#inspect-offerings-and-quote-first)
- [One-shot execution](#one-shot-execution)
- [Multi-step client lifecycle](#multi-step-client-lifecycle)
- [Files and artifacts](#files-and-artifacts)
- [Web preview and background processes](#web-preview-and-background-processes)
- [Suspend and resume](#suspend-and-resume)
- [GPU jobs](#gpu-jobs)
- [Parallel isolated instances](#parallel-isolated-instances)
- [OpenAI SandboxAgent integration example](#openai-sandboxagent-integration-example)
- [Audit, history, and billing](#audit-history-and-billing)
- [Run the real Playground recipe acceptance suite](#run-the-real-playground-recipe-acceptance-suite)
- [Failure and interruption recovery](#failure-and-interruption-recovery)
- [AI operating rules](#ai-operating-rules)

## Product boundary

xAPI is the Sandbox resource and capability provider. The CLI is a thin client
for discovery, quote, lifecycle, exec, files, ports, provider extensions,
history, audit, and billing. It does not implement prompts, model loops, memory,
multi-agent orchestration, job DAGs, queues, or human approval workflows.

Agent, CI, browser, and data examples in this guide are client-side recipes that
compose Sandbox primitives. They are not additional Gateway workflow APIs.
Provider-native features remain valid Sandbox extensions when the live Offering
declares their schemas, limits, state effects, and billing behavior.

## Choose the shortest safe lifecycle

| Need                           | Preferred command              | Cleanup behavior         |
| ------------------------------ | ------------------------------ | ------------------------ |
| Run one command and get stdout | `sandbox run`                  | Terminates automatically |
| Several exec/file calls        | `create` + primitives          | Agent must terminate     |
| Inspect price/capabilities     | `offerings`, `quote`           | No instance created      |
| Publish a temporary port       | `port` after starting a server | Terminate afterward      |
| Pause a reusable workspace     | `suspend`                      | Storage may keep billing |
| Inspect prior work/cost        | `history`, `get`, `audit`      | Read-only                |

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

The local candidate also accepts `--provider <registered-host-prefix>` with a
localhost/loopback gateway. It connects to that configured local address and
uses the matching Gateway's `/providers/<prefix>/v1` route; no DNS setup
is needed. Older Gateways return 404 for this route, rather than silently
choosing a different provider. This requires the matching Gateway candidate.
The prefix must correspond to a published Sandbox service in that local
environment. Unknown prefixes return the ordinary provider-not-found error,
with no fallback to a different provider. Public provider URLs and aliases
continue to use their normal HTTPS hosts.
`--provider` selects a published service host, not every offering whose upstream
vendor has that name. When given an exact `--offering-id` from the aggregation
catalog, omit `--provider` unless that offering belongs to the selected host.
The Offering's `provider.name` is a display label. Use its `provider.hostPrefix`
when present, or the prefix published for an older deployment, when pinning.
A local deployment can publish E2B or
Daytona under a different prefix, so a brand-name 404 does not establish that
the vendor has no available Offering. Aggregated resource or extension selection
works without a pin; check the returned Offering before creating.


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
  --min-runtime 24h \
  --max-hourly-usd 0.20 \
  --format pretty
```

Use `--format table` for a compact comparison and JSON when a complete quote ID
or nested rate card must be copied. Table truncation is marked with `…`.

Use `--requirements '<json>'` for fields that do not have a shortcut. Treat
`--max-hourly-usd` as a hard guardrail chosen before creation. A quote is
short-lived; create promptly or quote again.

The complete `--requirements` object has the following fields. Each top-level
field is optional; `{}` selects without additional requirements. These are the
Gateway's accepted fields, rather than an Offering's `resources` response shape:

| Field | JSON value and existing validation |
| --- | --- |
| `environmentId` | String, 1–120 characters, letters/digits plus `.`, `_`, `-`; starts with a letter or digit |
| `cpu` | `{"min": 2}`; `min` is a number at least 0 |
| `memoryGiB` | `{"min": 4}`; `min` is a number at least 0, in GiB |
| `volumeGiB` | `{"min": 7}`; `min` is a number at least 0, in GiB |
| `gpu` | `{"count": 1, "model": "A100"}`; positive safe-integer `count`, optional string `model` |
| `regions` | Unique string array; each string at most 120 characters |
| `capabilities` | Unique string array; each string at most 160 characters; extension selection uses `extension:<ID>` |
| `minContinuousRuntimeSeconds` | Positive safe integer; matches documented continuous-runtime support |

Resource objects contain `min`, not `max`. `offeringId`, `quoteId` and `resources`
are not fields inside `requirements`. The price ceiling is separate from that
object and is supplied through `--max-hourly-usd`:

```bash
npx xapi-to sandbox quote \
  --requirements '{"cpu":{"min":2},"memoryGiB":{"min":4},"capabilities":["exec","files"]}' \
  --max-hourly-usd 0.20

# Require a provider extension by its declared ID:
npx xapi-to sandbox quote \
  --capabilities exec,files,extension:cloudflare.files.watch \
  --memory 4 --max-hourly-usd 0.15
```

The extension selector checks `capabilities.extensionIds`; a bare
`cloudflare.files.watch` is not that selector. Inspect
`capabilities.extensions` for each extension's `inputSchema`, state effects and
billing declaration. Top-level `terminal: false` or `snapshot: false` describes
the common protocol surface; a provider can still declare native terminal or
snapshot extensions. Select those through `extension:<ID>` and invoke them
with `sandbox extension`.

`quote` chooses a compatible Offering by requirements and price; check its
returned `offering.id` before `create --quote-id`. For an exact catalog entry,
inspect its resources and rate card through `offerings`, then use
`create --offering-id ID`. `quote` has no `--offering-id` flag. Exact Offering
creation does not accept requirement flags or `--max-hourly-usd`; use a
requirements quote and its quote ID when enforcing a price ceiling.

The two rate-card version fields have different meanings: `rateCard.version`
is the pricing document format (1 or 2); `rateCardVersion` is the Offering's
published price revision, which increases when its price card changes. They
need not be equal. For example, format 2 with price revision 1 is valid. The
instance keeps the accepted price snapshot; compare that snapshot and its
billing periods when reconciling charges.

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

## Multi-step client lifecycle

Use granular commands when a client must alternate between files and commands.
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

An unconfirmed create does not prevent a deliberate new creation. If you choose
to try again, use a new key for that new request and keep the original instance
ID for tracking: any late resource remains attached to your account. Reusing
the original key only observes that original creation; it does not create a
replacement. This choice does not require operator approval. Check your owned
instances afterward and decide whether to terminate an extra resource.

If your Cloudflare SDK 1 Offering supports native creation cancellation, you
can explicitly `sandbox terminate <instanceId>` even before creation was
confirmed. Success requires the provider to confirm deletion of the original
creation identity. The original create record remains auditable; late replies
cannot restart that deleted instance. Other providers keep tracking when no
safe native identity is available and report that deletion was not dispatched.
A failed deletion is returned to you; the platform does not retry it silently.
Reuse the same idempotency key to read the recorded result.

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
# Native streaming download (E2B / Cube, CF, Runloop, Vercel and the Daytona local candidate):
npx xapi-to sandbox file download <id> large-output.bin --output ./large-output.bin
```

Local `--output` uses create-new semantics and refuses to overwrite an existing
file. `file write` base64-encodes local input bytes for the JSON interface.

For binary upload, use `sandbox file upload <id> <remote> --file <local>`.
The E2B, Daytona and CF local Gateway candidates declare `fileUploadStream:true` and forward native
bytes with backpressure, without an entire-file JSON/base64 copy or its receive
budget. `file write` remains available for inline text and JSON compatibility.
CF requires its matching independently deployed RPC Bridge for this path; an old Bridge acknowledgement fails explicitly without replay.
Providers without a native upload implementation return 501 before dispatch;
the CLI does not replay an upload through another route after an unknown result.
Cancellation aborts the transfer; a partial remote file may remain under native
provider semantics. Inspect it before choosing whether to overwrite or delete.
File bytes are not stored in the platform operation journal.
E2B streaming upload requires native template envd 0.5.7 or newer; older templates
report the native compatibility gap instead of buffering a complete upload.

Pass command environment values with `sandbox exec <id> --env '{"MODE":"demo"}'`.
This works with JSON output, `--stream` and `--background`; values are forwarded
as strings. Foreground commands default to a 60-second execution budget.
Background launch does not inject that default; use an explicit `--timeout` when
you want a command deadline. The sandbox lease, idle policy and billing still apply.
The CF SDK 1.0 candidate maps an explicit background `--timeout` to
`cloudflare.process.start`'s `timeoutMs`. Its launch response is still an
acknowledgement; read `cloudflare.process.get` using the returned `commandId`
as `processId` for completion. A command deadline reports `exitCode: 124` and
`timedOut: true`, stopping that task's process group rather than other background
tasks or the Sandbox. Omitting the timeout adds no command deadline. Check the
live extension schema for `timeoutMs` before relying on this candidate behavior;
older Bridge deployments have their own implementation.

Ordinary `exec` dispatches one native shell command per invocation. Command
POSTs are not automatically retried, and this command has no caller-supplied
`--idempotency-key`; repeating it is a new execution. A timeout or lost response
does not prove that its business side effects did not happen. Inspect the
original command's logs, process state or artifacts before choosing another
execution. Business keys and checkpoints remain the project's responsibility;
an audit operation's generated key is not a promise of caller command deduplication.

Use `sandbox exec <id> --stream --command 'your-command'` for complete native
foreground stdout/stderr on E2B/Cube-code, Daytona, Runloop, Vercel or the CF Bridge candidate (`execStream`
capability). It writes raw bytes to the matching terminal channel, honors
backpressure and the real exit code. Redirect locally when needed; no R2 or
sandbox temporary output file is required. Existing JSON exec still returns a
preview with `truncated`. Do not combine `--stream` and `--background`: the latter
launches and returns process identifiers using the existing command API.
Stopping the output stream never replays the command. Process effects remain
provider-specific: Daytona closes the log reader and deletes the private
foreground session, which can stop that command and its shell-backgrounded
children. Its `--background` mode retains the provider session. Disconnecting
an output reader does not request termination of a user background process.
Vercel's detached native foreground command continues after output disconnect
until completion or its own deadline. See the Daytona stream notes below for
the cleanup and confirmation boundary; Sandbox lease/idle rules still apply.
E2B preserves binary stdout; CF/Runloop/Vercel preserve their native UTF-8 text output.
The candidate forwards command/cwd/file paths without the old fixed character
ceilings or dot-segment block. Native filesystem/argument limits and the existing
HTTP JSON receive budgets still apply; diagnostic previews are separate.
`file download` uses backpressure, keeps binary
bytes intact and removes an incomplete local file after interruption. Providers
without a native file stream return 501; their existing `file read` still works. CF's locally tested Bridge candidate adds pull-based native decoding and cancellation;
older deployed Bridges retain their own path and converter behavior. Vercel is
native-tested; Cube has not yet had a separate real-provider acceptance run.

E2B/Cube, Runloop, Vercel and CF JSON file reads use native streams within the Gateway's
existing 16 MiB serialized JSON budget (including base64 and JSON escaping).
`413 SANDBOX_JSON_FILE_TOO_LARGE` means use `file download` for the full artifact;
it does not mean the container's file was deleted or capped. The local CF Bridge
candidate accepts native absolute read/write paths such as `/tmp` and preserves
significant whitespace. Old Bridges still enforce their own workspace paths.
`--depth` has no xAPI 20-level ceiling; recursive support remains provider-specific.
Vercel's native update API requires at least 1000 ms; xAPI forwards the original
native rejection rather than replaying a configuration write.

Daytona exposes `daytona.update_network_settings` through the extension API,
with native `networkBlockAll`, `networkAllowList` and `domainAllowList` parameters.
xAPI does not add a destination whitelist. The provider may reject policy changes
because organization-level restrictions take precedence; do not claim a sandbox
has unrestricted internet access merely because the update interface exists.
Command transport allows the requested duration plus startup overhead. A timeout
does not replay the command. Provider runtime/lease limits still apply.
Identified Daytona command and Vercel completion-wait budget expiries return
HTTP 408; that does not by itself prove that the process has stopped. A provider
can instead report an actual timeout exit code, such as CF background exit 124.
Actual upstream connection failures retain their error. Inspect the original
command before deciding to cancel it or start another execution.

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
Daytona uses `x-daytona-preview-token` in those returned headers. An ordinary
browser opening that URL without the header can receive 401 even when the
authenticated HTTP page and API work. This is native preview authentication;
port publication does not promise browser access without configuration. Fetch
a fresh port response after resume because those credentials can change.

Port publication can allocate provider resources even when the API uses GET.
The CLI sends it once; a failed response is not automatically replayed. Inspect
the existing instance before deciding to publish again.

The CF SDK 1.0 candidate uses native Worker port forwarding. A URL containing
`/xapi/public/.../` is a mounted base URL: resolve API/assets paths relative to
that URL (for example `new URL('api', previewUrl)`). Root-absolute `/api` or
`/assets` does not target that publication. Use the returned default URL; no
custom domain or DNS setup is required. The prefixed URL does not provide a
separate origin, so applications must support the mounted base path. Public
traffic does not auto-start a stopped
container; explicitly resume/use the Sandbox first. Stopping a native CF
container resets its guest filesystem unless you explicitly save elsewhere.

Cloudflare declares the standard background command surface and maps it to its
native managed process API. Pin `cf-edge` only when the user explicitly wants
Cloudflare. For a one-day workspace, require `--min-runtime 24h` and explicitly
enable `cloudflare.set_keep_alive`; the runtime requirement filters offerings,
while keepAlive prevents the default ten-minute idle reset:

```bash
box_json="$(npx xapi-to sandbox create \
  --provider cf-edge \
  --capabilities exec,backgroundExec,files,ports,lifecycle.keep_alive \
  --min-runtime 24h \
  --wait)"
box_id="$(printf '%s' "$box_json" | jq -r '.id')"
port=8080

cleanup() { npx xapi-to sandbox terminate "$box_id" --provider cf-edge || true; }
trap cleanup EXIT INT TERM

npx xapi-to sandbox file write "$box_id" index.html \
  --provider cf-edge \
  --content '<!doctype html><h1>xAPI preview</h1>'

npx xapi-to sandbox extension "$box_id" cloudflare.set_keep_alive \
  --provider cf-edge --input '{"keepAlive":true}'

npx xapi-to sandbox exec "$box_id" --provider cf-edge --background --command \
  "python3 -m http.server $port --directory /workspace"

npx xapi-to sandbox port "$box_id" "$port" --provider cf-edge
```

Validate that the returned public URL serves the expected marker before calling
the workflow successful. Quick Tunnel DNS/TLS readiness can be intermittent, so
use bounded retries (for example, one request every two seconds for up to two
minutes). If it still fails, verify localhost again, record the URL/error, and
terminate instead of leaving the instance billing. The URL stops working after
termination. Quick Tunnels are for previews; use a stable, supported named
tunnel or application deployment for production traffic.

Cloudflare extensions also expose managed process logs/readiness, persistent
shell sessions, stateful Python/JavaScript/TypeScript code contexts, Git
checkout, file-change cursors, bucket mounts, and R2 backup/restore. Inspect
`capabilities.extensionIds` before calling them. A default idle reset starts a
fresh container and does not retain files, processes, sessions, or interpreter
state. `keepAlive` removes that idle cutoff but does not guarantee that platform
maintenance can never restart the host. The candidate's account-debt maintenance
uses a separate native filesystem snapshot before stopping; see
[Account funding and safe debt maintenance](#account-funding-and-safe-debt-maintenance-local-candidate-2026-10-11).
Use R2 backup or external storage for
state that must survive restarts, disable keepAlive in `finally`, and terminate.

If the Offering declares `cloudflare.browser.*`, Cloudflare Browser Run can be
used through the same generic extension command. Prefer a Quick Action for
read-only page understanding before paying for a multi-step browser session:

```bash
npx xapi-to sandbox extension "$box_id" cloudflare.browser.snapshot \
  --provider cf-edge \
  --input '{"url":"https://example.com/","formats":["screenshot","markdown","accessibilityTree"]}'

npx xapi-to sandbox extension "$box_id" cloudflare.browser.automate \
  --provider cf-edge \
  --input '{"url":"https://demo.playwright.dev/todomvc/","actions":[{"type":"fill","selector":".new-todo","value":"xAPI task"},{"type":"press","selector":".new-todo","key":"Enter"}],"extract":[{"name":"todos","selector":".todo-list li label","all":true}],"screenshot":{"type":"png","fullPage":true}}'
```

Browser Run and the Sandbox container do not share a filesystem. Write the
returned page data into the sandbox through `sandbox file write` if a later
container command must analyze it. Browser operations have separate operation
prices; inspect the quote instead of assuming the container hourly cap includes
them. The current automation extension is one-shot and closes the browser.

The provider manifest's optional `runtimeAccess` describes Sandbox container
access independently from operation price. `NONE` means the operation does not
access or start that container; `MAY_START` and omission require runtime funding.
Do not infer either behavior from `changesState: false`. On a Gateway/Adapter
with this capability, CF DO-only keep-alive/idle settings and Browser-only calls
do not require a container running reserve. Their own operation fees still
apply; only a genuinely zero-price management call can proceed with no available
funds. A container-backed read can cold-start the runtime and needs funding,
even if the suspended storage reservation has not expired. Refreshing the
platform's verified manifest is required after an Adapter update. This is a
local candidate capability, not evidence that a public deployment supports it.
E2B/Cube timeout, Daytona idle configuration and Runloop keep-alive are also
control-plane calls in this candidate. They do not resume a stopped resource;
native state errors pass through. Extending an existing lease/idle timer still
uses ordinary runtime billing and does not grant free compute.

Persistent CDP/Live View/HITL are not supported until xAPI owns and authorizes
the session and proxies its WebSocket without exposing Cloudflare credentials.

For `cloudflare.browser.automate`, `timeoutMs` is the budget for each Playwright
action, not a deadline for the entire sequence. It defaults to 30,000 milliseconds.
Multiple actions, extractions and explicit `wait` steps can take longer in total;
the CLI transport covers that cumulative work and Gateway communication time.
Quick Actions also account for sequential navigation, selector, action and wait
budgets. Native Browser Run errors remain authoritative for unsupported options.
Platform request and response byte budgets protect transport and memory; they
are not character quotas for HTML, prompts, user agents or selectors.

Each browser invocation can incur usage charges. Inspect its operation price before
invoking it; a new idempotency key means a new operation. The CLI does not replay
an extension POST after a timeout or lost response. An operation can still be
pending after the connection ends: use the read-only `sandbox audit <id>`
operation query to inspect its outcome instead of sending the write again.
The one-shot automation closes its browser in cleanup after success or failure;
it does not leave a
persistent browser session for a later call.

When Cloudflare returns an explicit HTTP error, the gateway reports
`SANDBOX_EXTENSION_PROVIDER_ERROR` with the native `providerError.status`,
optional `code`, and a sanitized `message`. Its execution status is `FAILED`;
its separate billing status can remain `UNVERIFIED`, because earlier actions
or resource startup may have incurred usage. The same idempotency key and
input retrieve that recorded error without executing or charging again.
CF failures can include sanitized
`providerError.usageEvidence`: native Quick Action `browserMsUsed`, or a
one-shot session ID, observed elapsed time and whether close succeeded. Session
elapsed time is trace evidence, not a supplier invoice; do not interpret it as
a confirmed fee, zero cost or permission to replay the original operation.
CF Browser rate cards can use `OPERATION` / `SECOND`: the public `priceUsd`
is USD per browser second, and the final charge uses the supplier's measured
milliseconds divided by 1000. The temporary reservation estimates the execution
budget; it is not a minimum charge. There is no extra per-call fee on a SECOND
meter. Existing COUNT quotes retain their quoted unit and are not converted
retroactively. Sandbox runtime/storage billing stays independent.

Successful Quick Actions retain native `X-Browser-Ms-Used`, including fractional
milliseconds. Do not truncate that measured quantity before pricing. One-shot sessions
can attach `CF_BROWSER_SESSION_RECORD` with native start/end timestamps and a
classified close reason. Successful calls and failed actions with confirmed
normal-session use settle that measured duration against the admitted price.
Explicit zero usage or confirmed native session eviction can finalize a failed
operation at zero. A positive used-time header alone is not proof that a failed
Quick Action is billable; Cloudflare has timeout exemptions.

A successful task can return `billingStatus: UNVERIFIED` while its supplier
usage is delayed. Its output remains available and its temporary wallet hold is
released. Background observation queries the original operation, never executes
it again. The final billing breakdown retains sanitized native evidence,
quantity, unit and price; USD is rounded once to the wallet's existing 8 decimal
places. A pending record is not an invoice for zero usage. The CLI preserves
operation ID and execution/billing status even when a native message is long.
CF's account-level included hours and concurrency invoice are distinct from
the public retail tariff; do not describe a test price as the supplier invoice.

The default billing audit lists settled charges. To inspect pending holds or
all statuses, use the explicit financial view; `reservedAmount` is a hold,
`amount: null` is not a confirmed zero charge, and `operationId` links the fee
to its operation:

```bash
xapi-to sandbox audit "$box_id" --kind billingPeriods --billing-status pending
xapi-to sandbox audit "$box_id" --kind billingPeriods --billing-status all
```

For the tested CF SDK/image 0.12.4 candidate, code interpreter `cwd`, `env` and
`timeoutMs` did not take effect in real acceptance. Do not rely on those
interpreter options until this provider gap is corrected; ordinary command,
shell session and process options were tested separately. Always inspect the
native code result's `error`: a completed extension request (`SUCCEEDED` or CLI
exit 0) does not mean the executed code succeeded. This is a known capability
gap, not a new parameter restriction.
Transport failures remain pending until the original operation is observed.
For PDF Quick Actions, native format names are lowercase, such as
`"pdfOptions":{"format":"a4"}`; use the native error to correct an invalid
option and use a new key only for a deliberate new invocation.

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
If `lifecycle.suspension.supported` is false, do not call suspend/resume;
terminate and create a new instance. The CF SDK 1.0 candidate supports explicit
STOP_RESET: suspend stops the physical container, and resume starts a clean one.
Its files, memory and processes do not survive a normal user-requested stop.
Account-debt maintenance is separate: where the deployed maintenance capability
declares filesystem preservation, the platform saves a native snapshot and
restores files on a funded resume. Memory and processes still do not survive;
see [Account funding and safe debt maintenance](#account-funding-and-safe-debt-maintenance-local-candidate-2026-10-11).
E2B PAUSE and Daytona
STOP have different preservation semantics; always use the live Offering fields.

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

## Parallel isolated instances

Give each concurrent worker or agent a separate instance. Do not share a mutable
workspace when the goal is isolation. Use unique idempotency keys and record every instance ID.
Run cleanup for all IDs even if one agent fails; then verify `sandbox list` has
no active instance from the job.

Limit concurrency based on budget. Parallel creation multiplies reservation and
running cost, even when the individual hourly quote is small.

## OpenAI SandboxAgent integration example

The OpenAI Agents SDK keeps the model provider and sandbox provider separate.
Use the SDK's OpenAI-compatible model provider for DeepSeek through
`https://ai.xapi.to/v1`, and the xAPI adapter for Sandbox compute:

The Agents SDK owns the model loop, tool choice, prompt, and conversation state.
xAPI owns only the Sandbox resource, execution, lifecycle, audit, and billing.

```ts
import { OpenAIProvider, Runner } from "@openai/agents";
import { Manifest, SandboxAgent, shell } from "@openai/agents/sandbox";
import { XapiAgentsSandboxClient } from "xapi-to/openai-sandbox";

const sandboxApiKey = process.env.XAPI_SANDBOX_KEY;
const aiApiKey = process.env.XAPI_AI_KEY;
if (!sandboxApiKey) throw new Error("XAPI_SANDBOX_KEY is required");
if (!aiApiKey) throw new Error("XAPI_AI_KEY is required");

const sandbox = new XapiAgentsSandboxClient({
  apiKey: sandboxApiKey,
  sandboxHost: "sandbox.test.xapi.to",
  provider: "daytona",
  model: "deepseek-v4-pro",
});
const modelProvider = new OpenAIProvider({
  apiKey: aiApiKey,
  baseURL: "https://ai.xapi.to/v1",
  useResponses: false,
  strictFeatureValidation: true,
});
const runner = new Runner({ modelProvider, tracingDisabled: true });
const agent = new SandboxAgent({
  name: "xAPI DeepSeek sandbox agent",
  model: "deepseek-v4-pro",
  defaultManifest: new Manifest({ root: sandbox.workspaceRoot }),
  capabilities: [shell()],
  instructions: "Use shell to complete and verify the task.",
});

try {
  const result = await runner.run(
    agent,
    "Write SDK_OK=42 to result.txt and read it.",
    {
      maxTurns: 8,
      sandbox: { client: sandbox },
    },
  );
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

In this local candidate, a lifecycle action before the upstream resource ID is
confirmed returns `SANDBOX_RESOURCE_NOT_CONFIRMED` with `dispatched: false`,
`requestedAction`, and `creationTracking.operationId/status/active`. HTTP 409
means original creation tracking continues; HTTP 503 with inactive tracking
means the platform allocation record needs reconciliation. Neither means the
resource was cancelled or deleted. Inspect that original operation and the
owned instance list; once a late resource appears, decide whether to terminate
it. The failed early action does not queue an automatic deletion or another
create. Do not treat it as successful cleanup.

Inspect current state and service-calculated total:

```bash
npx xapi-to sandbox get <id> --format pretty
```

`totalCost` is the settled cumulative charge, not a live estimate of an open
usage segment. It can still be zero before the first rolling settlement even
though the instance is running and consuming paid time. An `OPEN` segment can
have a null amount until settlement; inspect the audit and final terminated
instance to reconcile the complete charge.

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

## Run the real Playground recipe acceptance suite

From an xapi-cli development checkout, run the same nine client recipes shown
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

## Cloudflare user-owned bucket mounts

`cloudflare.mount_bucket` accepts the native `mountPath` and object `options`.
For your own S3/R2 bucket, omit `binding`, provide `bucket` and
`options.endpoint`, and supply your storage credentials in `options.credentials`.
`credentialProxy: true` keeps those credentials in the Durable Object; native
SDK defaults may otherwise write them into your own container. Preserve
`prefix`, `readOnly`, `provider` and `s3fsOptions` as needed. The candidate forwards these native options unchanged and never uses platform deployment credentials for your remote mount.
R2 fees belong to the bucket account (including a separately configured xAPI Worker R2 resource); Sandbox runtime billing is independent. A Worker binding is
an alternative, not a requirement for every user. Native SDK validates
binding/endpoint choices and paths; a provider error does not authorize an
automatic mount retry or establish zero cost. Unmount uses `mountPath`.

Only use storage you are authorized to access. Do not treat an available
platform binding or someone else's backup UUID as ownership. Shared backup
restoration has separate deployment and ownership prerequisites; an extension
catalog alone is not evidence that it is configured or tested.

Runloop foreground streaming uses native execution IDs and stdout/stderr SSE.
An explicit command timeout requires GNU `timeout` and `/bin/bash` in the selected
Linux image; `optimistic_timeout` alone is only a response wait. Missing native
tools fail through the provider command result without replay. No timeout supplied
means no additional process-kill deadline; cancelling output does not kill the command.

The CLI explicitly supplies its configurable `--timeout` (default 60 seconds).
For the SDK/HTTP foreground stream, omitting `timeoutSeconds` preserves the native
command lifetime: the connection-startup budget is not a whole-stream deadline.
HTTP error body sampling remains bounded; an explicit timeout and caller cancel
still apply. This does not change the JSON exec default.


### Modal SKU lease and snapshot parameters (local candidate, 2026-10-09)

Modal Offering lifecycle metadata now follows the selected native SKU's
`create.timeoutMs`; the one-hour Adapter default is not a universal maximum.
For example, a SKU with `timeoutMs: 7200000` advertises 7200 seconds and can match
`minContinuousRuntimeSeconds: 5400`. Reverify the Adapter to refresh Offering
metadata. Existing instance price/capability snapshots remain unchanged.

`modal.snapshot_directory` preserves the supplied path byte-for-byte, including
trailing spaces; native validation decides whether it is valid. `ttlSeconds`
defaults to 30 days only when omitted; `null` follows Modal's indefinite image
retention and a positive integer supplies the native image TTL. Zero is invalid
in Modal's SDK and is rejected before a native snapshot call. This TTL belongs
to the snapshot image, not the Sandbox account-funding retention period.
Explicit pre-dispatch rejections release only the operation fee and return 400;
running-resource charges continue. Other received native errors may still have
side effects/costs and require reconciliation.

Modal file listing uses one native read by default. A supplied depth traverses
only actual directories, not symbolic links. No extra depth or SKU-count ceiling
was introduced; the old 200-entry manifest SKU cap was removed. These changes do
not implement Modal's full command stream, native download, PTY or all snapshot
SDK options. Do not claim those incomplete paths as available.

### Resource requirements without catalog-sized caps (local candidate, 2026-10-09)

The Gateway no longer treats 1024 GPUs or one year of requested minimum runtime
as universal provider limits. GPU model length is not capped at 120 characters;
CPU, memory and volume minima accept native fractional precision. For example,
`--gpu-count 2048 --gpu-model <native-model> --min-runtime 366d` can reach quote
selection. Matching still requires a verified Offering that actually declares
that capacity/runtime. An accepted request does not guarantee provider capacity.

Provider resource snapshots no longer have 32 GPU entries or a one-million
quantity cap. Finite, non-negative scalar quantities and positive GPU quantities
remain required, within the JSON-number representation range. GPU snapshot
fractions remain valid; the common GPU requirement `count` continues to express
a positive integer device count. Native resource allocation uses the selected
Offering, not the requested minimum quantity.

`--min-runtime` now computes integer duration units and rounds partial seconds
up before converting to a JSON number, preventing large millisecond inputs from
losing a second. Numeric precision checks are not a provider lifetime policy.
Ownership, quotes, initial/rolling reserves and operation charges are unchanged.
Large catalog fixtures are not evidence of thousands of real provider GPUs or
multi-year endurance; real supplier fees and extreme monetary precision still
need separate verification.

### Daytona file download (local candidate, 2026-10-09)

Daytona now implements the existing `sandbox file download` endpoint through
the pinned SDK's public `downloadFileStream`. Binary bytes and native paths,
including trailing spaces, pass through unchanged. Downloads consume the native
stream with backpressure; cancelling the consumer cancels the native transfer.
This does not stop or delete the Sandbox or automatically retry the download.

`file read` also uses this native stream and the existing JSON response budget.
Use `file download` for artifacts that exceed that budget; there is no total file
size quota added to the Sandbox. The candidate disables the SDK's implicit
30-minute whole-download timeout and retains caller cancellation.

The download addition alone does not implement PTY,
remove its organization-level egress policy, or prove supplier billing.
The candidate must be deployed before these new download semantics are available
on an existing public endpoint.

After terminate completes, the CLI returns the same operation from the final
Sandbox detail when available, so the outer operation status reflects that
confirmed observation rather than its original launch acknowledgement. It does
not synthesize success or repeat the terminate request.


### Daytona foreground command stream (local candidate, 2026-10-09)

Use `sandbox exec <id> --provider daytona --stream --command '<command>'` for
complete foreground output. The candidate follows native Toolbox WebSocket logs,
keeps stdout/stderr separate, and confirms the native exit code. It delivers
output before exit; the existing JSON exec remains a bounded preview.

Only one command is launched. On disconnect or an explicit command timeout,
the candidate closes its log reader and deletes its private foreground session;
it does not terminate the Sandbox or retry the command. Background commands
continue to use `--background` and retain their provider session.

`--timeout` is the foreground command budget starting at dispatch; identity lookup
and session preparation use the existing upstream HTTP waiting budget. SDK writes
and session cleanup can take that HTTP budget to confirm; losing the client is
not proof the supplier instantly cancelled. Without an explicit command timeout,
there is no new whole-command lifetime cap. The native WebSocket uses the same
100MiB single-message receiving budget as the SDK, not a total-output quota;
native output framing/line normalization still applies. PTY, general native
snapshot parameters, and organization network conditions remain separate.

### Lifecycle receipts and preview credentials (local candidate, 2026-10-09)

After suspend/resume completes, the CLI returns the matching operation id from
the final Sandbox detail when available, as terminate already does. It does not
infer operation success just from the observed state, add a read, or repeat the
mutation. If the matching operation is not present, the original acknowledgement
is retained.

Daytona preview credentials may change after a stop/start. Obtain a fresh
`sandbox port` response after resume before accessing the service again; use its
returned headers. An old credential returning 401 is not proof the service or
its preserved files were lost.

### CF SDK 1.0 candidate lifecycle notes (2026-10-10)

Idle STOP_RESET preserves the logical xAPI instance, not the container filesystem,
memory or background processes. Native data access may cold-start a new physical
container. The candidate preserves user keepAlive/idle preferences across that
replacement without waking the container merely to change a setting. Browser
operations also run without starting an idle Sandbox. Delete confirms the native
physical stop before reporting TERMINATED; an upstream destroy failure is reported
and remains traceable, with no automatic replay of a user deletion.

`cloudflare.process.cleanup` in the SDK 1.0 candidate removes completed managed
process records and returns the actual cleaned count and identities; it does not
kill running user processes. The legacy SDK 0.12.4 implementation returned a
constant zero and remains excluded from that legacy manifest.

Remote R2/S3 mounts use the caller's bucket and credentials, including temporary
credentials. An independently provisioned xAPI Worker R2 bucket can be used too;
there is no required Worker pairing or implicit shared platform bucket. The SDK
1.0 candidate uses native DirectoryBackup (`tar+zstd/1`), requiring an explicit
R2 binding in its Bridge deployment. This is separate from credential-based
mounts; an arbitrary mounted bucket is not automatically a DirectoryBackup
binding. Legacy squashfs backup import is not implemented.

### Additional native management extensions (local candidate, 2026-10-10)

Discover the live Offering before using these additions. Their source/owner
scope is enforced; list commands do not enumerate the shared provider account.
The local candidate has real E2B/Daytona/Vercel lifecycle and consumer tests.
Supplier billing evidence, Daytona organization egress and snapshot management
remain separate gaps. This guide is not evidence of a public deployment.

- E2B: `e2b.command.list`, `e2b.command.kill` (`pid`),
  `e2b.snapshot.list` (`limit`, `nextToken`, `name`) and
  `e2b.snapshot.delete` (`snapshotId`). Listing returns one page; follow
  `nextToken`/`hasNext`. Snapshot action results preserve native `snapshotId`
  and `names`. Kill returns native `signalSent`; it is not an exit receipt.
- Daytona: `daytona.session.list`, `daytona.session.get` / `.delete`
  (`sessionId`), and `daytona.command.get` (`sessionId`, `commandId`). These
  address only the current sandbox; command queries preserve native null exits.
- Vercel: `vercel.update_network_policy` (`networkPolicy`),
  `vercel.snapshot.create` (`expiration`, native milliseconds; 0 means no
  native expiration), `.list` (`limit`, `cursor`, `sortOrder`, optional `sourceOperationId`) and `.delete`
  (`snapshotId`). `.get` also accepts `snapshotId`. Snapshot creation stops runtime.
  Native `.list` accepts `limit` from 1 to 50; a larger value is rejected upstream.
  New Sandbox allocations retain native source-session ownership, so get/delete
  work with `snapshotId` even after source deletion. For historical allocations
  lacking retained provenance, pass `sourceOperationId` from the snapshot creation
  receipt with `snapshotId` to get/delete. The server verifies that receipt belongs
  to this Sandbox; supplying a native ID alone does not prove ownership. New
  Sandbox allocations retain their native session identities, so listing also works
  after source deletion and includes automatic snapshots from those sessions.
  Listing reads one native project page and returns only this allocation's proven
  sessions; Vercel's name filter cannot find snapshots after source deletion.
  Follow the native cursor even when a filtered page is empty. A historical allocation
  without retained session evidence returns an explicit provenance error; pass its
  successful snapshot creation `sourceOperationId` to list that proven session.
  Deleted runtime does not mean
  its snapshots were deleted; storage cost is separate upstream.

Operation pricing comes from the Offering; none of these extensions introduces
a new fixed surcharge. An absent test surcharge is not proof of zero supplier
cost. They do not expose native PTY, Drives, or arbitrary native create options.

### CF terminal, process log subscriptions, backups and snapshots

Discover the live Offering extensions first. These APIs are specific to the CF
SDK 1.0 candidate; they are not advertised on the legacy Bridge.
Top-level `terminal`/`snapshot` describes the common API protocol, which remains
unmapped for CF. Those fields being false does not disable the provider extensions
listed below. For `exec --background`, use the returned `commandId` as the CF
extension's `processId`.

```sh
xapi sandbox extension ID cloudflare.terminal.open --input '{"sessionId":"my shell","cols":120,"rows":40}' --stream
xapi sandbox extension ID cloudflare.terminal.close --input '{"sessionId":"my shell"}'
xapi sandbox extension ID cloudflare.process.log_stream --input '{"processId":"PROCESS","follow":true,"offsets":{"stdout":0,"stderr":0}}' --stream
xapi sandbox extension ID cloudflare.files.watch --input '{"path":"/workspace/project","recursive":true}' --stream
xapi sandbox extension ID cloudflare.backup.create --input '{"dir":"/workspace/project","storage":{"binding":"MY_R2","prefix":"backups/"}}'
xapi sandbox extension ID cloudflare.backup.list
xapi sandbox extension ID cloudflare.backup.restore --input '{"backupId":"BACKUP","dir":"/workspace/restored"}'
xapi sandbox extension ID cloudflare.backup.delete --input '{"backupId":"BACKUP"}'
xapi sandbox extension ID cloudflare.snapshot.create --input '{"name":"before-change"}'
xapi sandbox extension ID cloudflare.snapshot.list
xapi sandbox extension ID cloudflare.snapshot.restore --input '{"snapshotId":"SNAPSHOT"}'
```

PTY uses a native tmux session. Disconnect detaches the client; reconnect with
the same sessionId and a new grant to retain the shell. `terminal.close` ends
that shell. STOP_RESET still loses its state. Native tmux reserves one row for
its status bar. Session labels may contain spaces, Unicode and punctuation.
cwd/env initialize a new shell; reconnect retains the existing shell's state.
Extension JSON keeps the native response envelope: the payload is usually
`response.result.result` (or `response.result` when already unwrapped). The
CLI's `--stream` handles both forms; existing JSON consumers remain compatible.

The SDK 1.0 candidate's `cloudflare.files.watch` uses native inotify filesystem
events. An optional `sessionId` resolves relative paths against that session's
cwd. `--stream` prints newline-delimited JSON: `ready` confirms the watcher,
and `change` preserves the path, native event masks and rename cookie. Unicode
and newline-containing filenames remain JSON-escaped. Cancelling closes that
watcher only; it does not stop your application. There is no automatic reconnect
or event replay: after a disconnect, open a new grant and inspect the filesystem
if you need to reconcile missed changes. The live Offering must advertise this
extension; older Bridge deployments do not implement it.

Log events carry base64 bytes with per-channel offsets; binary stdout/stderr
are preserved. `--stream` prints those bytes. Without `--stream`, the result
includes a single-use HTTPS or WSS connection URL. The API key and provider
credentials are never attached to that URL or connection. Cancelling a log
subscription closes its reader and leaves the business process running. Open
a new grant after a disconnect; use offsets to avoid duplicate bytes. The CLI
does not automatically reconnect or replay the business command.

Backups are recorded per account owner, can restore into another owned sandbox,
and use the explicitly configured R2 storage. List/delete do not start runtime,
including after sandbox termination. Runtime and configured R2 charges remain
separate. R2 is an optional external resource, not included sandbox disk: use
the storage you configure, including a compatible xAPI Worker R2 resource.
The sandbox adapter does not provision that resource or bill its storage again.
Extension operation fees, if configured, come from the Offering quote; no
additional backup/terminal/log surcharge is introduced by these commands.
For CF backup/snapshot per-operation fees, a confirmed native failure releases
the operation reservation while preserving the original error and artifact ID.
Runtime charges remain separate. A transport timeout remains unverified until
the original operation journal confirms its outcome; do not replay the write.

CF snapshot list is scoped to your account owner, so it can include snapshots
from your other sandboxes. Each record includes its source; this permits
same-owner cross-sandbox restoration and is not a shared-provider account list.
Native snapshots preserve the writable filesystem, excluding mounted directories,
require the same source image version, and stop the destination container before
restoring. They do not restore memory or processes. CF currently retains each
snapshot for 30 days after creation or its last restore; restoring refreshes that
period. The native API provides neither custom TTL nor early deletion. This is
CF's snapshot policy, separate from any xAPI account-funding retention period.
A sandbox termination ends its running usage when the native stop is confirmed;
it is not a snapshot deletion receipt. Keep the snapshot identity and source for
inspection. An estimated expiry derived from the latest creation/restore time is
not a confirmed native deletion receipt. Do not restore repeatedly just to keep
it alive, and do not promise recovery across image upgrades.

CF native snapshots belong to the CF account deploying the Sandbox Bridge. In
the xAPI-managed deployment, that account is the platform's, so any supplier
snapshot cost is a platform cost. Users pay the disclosed Offering quote; do not
invent a separate storage charge after termination. The current local QA card
has zero snapshot operation fees, but supplier snapshot cost and the production
price have not been verified. CF's Containers pricing page currently gives no
separate native snapshot storage rate: do not substitute R2 rates or label native
snapshot retention free. Native snapshots do not require a caller R2 bucket.

External R2/S3 mounting and DirectoryBackup are different resources. Their
storage and requests belong to the configured bucket's billing account/resource:
a caller's own bucket follows that supplier's bill; a separately provisioned xAPI
Worker R2 resource follows that resource's disclosed price card. A platform-owned
backup binding is a platform-owned resource and needs its own disclosed cost
arrangement; a binding name alone does not prove caller ownership or free storage.
Sandbox does not silently provision a bucket or charge its storage again. Backup
objects can outlive the Sandbox until deleted through `cloudflare.backup.delete`
or the configured resource's own lifecycle policy; terminating the Sandbox does
not delete them. These optional resources do not change native snapshot retention.

Policy references: [CF snapshot retention and API boundary](https://developers.cloudflare.com/sandbox/files/save-a-sandbox-automatically/),
[image compatibility](https://developers.cloudflare.com/containers/guides/snapshots/),
[Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/),
and [R2 pricing](https://developers.cloudflare.com/r2/pricing/). Check the live
Offering for the actual xAPI price before a billable operation.

Native in-flight operations and keepAlive can keep the container running. Status
reads, preference updates, Browser operations and public access do not cold-start
idle runtime. Explicit resume starts it. Explicit suspend stops it even with
keepAlive; terminate from a stopped state does not wake it. A terminated public
handle returns 404, while a stopped resumable instance returns 503.

When testing native idle/access cycles, explicitly create with
`--resume-on-access` if the tool should wake on access. After a successful wake
operation, `get` is a stored confirmed observation and may briefly show the
previous SUSPENDED state until the state event is ingested (the Offering
discovery publishes its observation delay). Wait for the new RUNNING event and
state before treating a later SUSPENDED event as another idle cycle; compare
audit event sequences or stateVersion. Reusing an old SUSPENDED value can produce
a false idle/reset result even when the operation and billing succeeded.

### Close a published Cloudflare port (local candidate, 2026-10-10)

If the live Offering declares `cloudflare.ports.close`, revoke a published port
through the existing extension command:

```bash
xapi sandbox extension ID cloudflare.ports.close --input '{"port":3000}'
```

This closes access through the published URL; it does not stop the listening
process, destroy the Sandbox, or wake a stopped container. A later explicit
`sandbox port ID 3000` publishes a new URL; the old URL remains closed. The
operation uses the Offering's existing extension pricing and introduces no
separate port fee. This is a provider extension, not a new `sandbox port close`
CLI subcommand. Do not automatically retry a failed call; report its result and
let the user choose whether to retry.

### Native snapshot action and Vercel ports (local candidate, 2026-10-10)

`xapi sandbox snapshot ID --idempotency-key KEY` invokes the existing common
snapshot action once and returns its operation. Inspect `sandbox get` and the
provider snapshot extensions for artifacts and resulting state; a native
snapshot may stop runtime. The CLI does not resume or repeat the action.
Daytona exposes `daytona.snapshot.list` (`page`, `limit`), `.get` and `.delete`
(`name` from the common snapshot receipt). These management calls do not start
the source Sandbox and remain available after its termination. Follow `nextPage`
until absent, even when the owned snapshots array is empty: an upstream page may
contain only other users' resources, which are filtered out. The supplier Key needs
`delete:snapshots` for deletion; a native 403 is a failed deletion, never success.
New creation receipts retain native identity beyond expiry of their full output.
Management also verifies the original immutable native snapshot ID. A name-only
creation receipt needs platform recovery of that original ID; reading the current
same-name object is not proof, and does not justify creating another snapshot.
Historical Adapter receipts predating this change can expire after seven days;
missing ownership evidence must be recovered from platform records, not guessed
from a shared-account snapshot name.

Vercel can expose a new port through `vercel.update` with `{"ports":[3000]}`.
Start a listening server, update ports, then use `sandbox port ID 3000`.
Vercel snapshot expiration is native milliseconds: positive values must be at
least 86400000 (one day); 0 means no expiration. This is an upstream constraint,
not an xAPI surcharge or retention policy. Delete test snapshots explicitly
after source deletion, default get/delete/list on new allocations use retained
native session evidence. Historical get/delete requires its original snapshot
creation `sourceOperationId` with `snapshotId`. For historical listing, optional
`sourceOperationId` lists only the session proven by that creation receipt;
automatic snapshots from other historical sessions still need management before
deleting the source.

### Vercel command completion without a hidden wake (local candidate, 2026-10-10)

`vercel.command.get` reads the current native session without resuming it.
The default preserves native `exitCode:null`. To read completion explicitly:

```bash
xapi sandbox extension ID vercel.command.get --input '{"commandId":"CMD","wait":true,"timeoutMs":10000}'
```

Check the returned operation status and native result. A CLI exit of zero after
retrieving an existing receipt does not turn `TIMED_OUT` into command success.
If the read times out, query the original command with a new read request;
do not execute the business command again to discover its result.
In the updated candidate, expiry of this local wait budget returns HTTP 408
while the original command may continue. The read receipt can remain TIMED_OUT
with a zero-fee settlement; that is not a failure or a zero-cost claim for the command.
Network policy updates also use native metadata update without resuming runtime.
A fixed zero COUNT read can have a SETTLED zero-fee period while its execution
receipt remains TIMED_OUT; this does not establish zero supplier or runtime cost.


### Account funding and safe debt maintenance (local candidate, 2026-10-11)

Runtime and shutdown reserves use the account wallet from the first creation
window onward. The calling Key is still required for authentication and resource
ownership; its request budget continues to apply to separately priced operations,
not recurring runtime funds. Reservations are holds, not final fees; actual
state-time periods settle against the accepted instance rate card.

Only confirmed account insufficiency authorizes debt suspension. Key-budget
errors and unavailable platform billing/state services are not proof of account
debt and do not authorize deleting a workspace. Status/history remain available.
Add account funds, then use the normal supported resume or runtime operation.
Daytona requires an explicit resume; use the live Offering's auto-resume support
for other providers. Native session/lease and memory retention differences remain.

When the deployed CF Adapter advertises
`maintenance.suspendPreservesFilesystem: true`, confirmed debt invokes an
internal native filesystem snapshot before stopping the physical container.
This is separate from normal user `STOP_RESET`: ordinary suspend/idle stop still
has the published reset semantics. Maintenance snapshot identity is retained and
registered under the same owner as user snapshots. Public preview/terminal/log
URLs cannot restart that stopped container; after funding, a normal authorized
runtime call restores its files and prepares the runtime. Restart your business
processes and obtain a current port URL. Memory/process state and mounted external
resources are not included. R2, a Worker, or a user-owned domain is not required.

Native CF snapshots follow the upstream 30-day policy, refreshed on restoration;
this is not an unlimited xAPI data-retention promise. The snapshot belongs to the
CF account running the Bridge. This internal maintenance action does not add a
user-selected snapshot operation charge; running time and any separately declared
state/storage charges still follow the accepted rate card. User-requested
snapshots/backups keep their own declared billing and external storage ownership.
If preservation fails or its dispatched result is unknown, the platform retains
the existing data and reports pending maintenance rather than pretending a blank
restart is recovery. Historical native-wake settings must be checked against
actual provider state; changing a catalog entry does not revoke them.
