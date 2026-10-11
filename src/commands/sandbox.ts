/** Sandbox lifecycle and one-shot execution commands. */

import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HttpError } from '../client.ts';
import { getConfig, requireApiKey, XAPI_SANDBOX_HOST } from '../config.ts';
import { err, getFormat, output } from '../format.ts';
import * as sandbox from '../sandbox-client.ts';
import type { SandboxClientOptions, SandboxDetail, SandboxRequirements } from '../sandbox-client.ts';
import { consumeCfLogs, consumeCfTerminal, consumeCfFileEvents } from '../sandbox-cf-streams.ts';

export const SANDBOX_HELP = `xapi-to sandbox - Managed, auditable cloud sandboxes

USAGE
  xapi-to sandbox <command> [args] [flags]

QUICK START
  sandbox run --command <shell>     Quote, create, wait, execute, and terminate
  sandbox run -- <command...>       Positional shorthand after a bare --

LIFECYCLE
  offerings                         List available provider offerings
  quote                             Quote requirements without creating
  list                              List sandbox instances
  history                           Search paginated instance history
  get <id>                          Get instance state, usage, and cost
  create                            Create from a quote, offering, or requirements
  wait <id>                         Wait for a state (default: RUNNING)
  exec <id> --command <shell>       Execute a shell command
    --stream                        Full raw stdout/stderr, with backpressure
  suspend|resume|terminate <id>     Change state and wait for completion
  snapshot <id>                     Invoke the native snapshot action

FILES, PORTS, AUDIT
  file download <id> <remote> --output <local>
  file upload <id> <remote> --file <local>
  file write <id> <remote> --file <local>
  file write <id> <remote> --content <text>
  file read <id> <remote> [--output <local>]
  file list <id> [--path <remote>] [--depth N]
  port <id> <port>                  Get a public URL for a listening port
  extension <id> <extension-id>     Invoke an offering-declared extension
  audit <id> [--kind operations|events|usageSegments|billingPeriods]

SELECTION FLAGS
  --provider auto|daytona|cf-edge|e2b|runpod|runloop|modal|vc-sandbox|fly|blaxel|cubesandbox
                                      Pin a published host prefix (default: auto)
  --capabilities exec,files,ports   Required capabilities
    extension:<ID>                  Require a declared provider extension
  --cpu N  --memory N  --volume N  Minimum CPU, memory GiB, volume GiB
  --gpu-count N  --gpu-model NAME   GPU requirements
  --regions a,b                     Allowed regions
  --min-runtime 24h                 Minimum documented continuous runtime
  --requirements <json>             Complete requirements object
  --max-hourly-usd N                Price ceiling (sandbox run default: 0.20)

COMMON FLAGS
  --host <sandbox.xapi.to>          Override gateway; must be *.xapi.to/localhost
  --wait-timeout 5m                 State wait timeout (default: 5m)
  --interval 2s                     State polling interval (default: 2s)
  --format json|pretty|table        Output format

HISTORY FLAGS
  --state ALL|ACTIVE|HISTORY|RUNNING|SUSPENDED|TERMINATED|FAILED
  --search <text>  --from <ISO time>  --to <ISO time>
  --page N  --page-size N           Pagination (page size: 1-100)

SAFETY
  sandbox run terminates in finally, including command failure. Use --keep only
  when you intentionally want billing to continue after the CLI exits.
  Provider names above are deployment aliases; a local published host prefix
  can differ from the upstream vendor name. Inspect offerings without a pin first.

EXAMPLES
  xapi-to sandbox offerings --format table
  xapi-to sandbox quote --capabilities exec,files --max-hourly-usd 0.20
  xapi-to sandbox quote --capabilities exec,files,extension:cloudflare.files.watch --memory 4 --max-hourly-usd 0.15
  xapi-to sandbox run --command 'python3 -c "print(6*7)"'
  xapi-to sandbox run --provider cf-edge --capabilities exec,files,ports --command 'pwd'
  xapi-to sandbox exec <id> -- npm test
  xapi-to sandbox extension <id> runpod.connection_info --input '{}'
  xapi-to sandbox terminate <id>
`;

type SandboxCommand =
  | 'offerings' | 'quote' | 'list' | 'history' | 'get' | 'create' | 'wait'
  | 'exec' | 'file' | 'port' | 'extension' | 'audit' | 'suspend' | 'resume'
  | 'terminate' | 'snapshot' | 'run';

const SANDBOX_COMMAND_HELP: Record<SandboxCommand, string> = {
  offerings: `USAGE
  xapi-to sandbox offerings [--provider NAME] [--format json|pretty|table]

Lists current resources, capabilities, lifecycle support, and hourly prices.
Use JSON for extensionIds, extension inputSchema and the full rate card.
Provider display names do not reveal a deployment's published host prefix;
--provider pins that prefix, which need not be the upstream vendor name.
This command does not create or bill an instance.`,
  quote: `USAGE
  xapi-to sandbox quote [selection flags] [--max-hourly-usd N]

SELECTION
  --capabilities exec,files,ports   Required capabilities
    extension:<ID>                  Require an extension from extensionIds
  --cpu N  --memory N  --volume N  Minimum CPU, memory GiB, volume GiB
  --gpu-count N  --gpu-model NAME   GPU requirements
  --regions a,b                     Allowed regions
  --min-runtime 24h                 Minimum documented continuous runtime
  --requirements <json>             Complete requirements object
  --max-hourly-usd N                Hard hourly price ceiling

REQUIREMENTS JSON (all fields optional)
  environmentId: string
  cpu: {min: number >= 0}
  memoryGiB: {min: number >= 0}
  volumeGiB: {min: number >= 0}
  gpu: {count: positive safe integer, model?: string}
  regions: unique string[]
  capabilities: unique string[]
  minContinuousRuntimeSeconds: positive safe integer
  Example: --requirements '{"cpu":{"min":2},"memoryGiB":{"min":4},"capabilities":["exec","files"]}'
  offeringId, resources and resource max fields are not requirements fields.

EXTENSION SELECTION
  xapi-to sandbox quote --capabilities exec,files,extension:cloudflare.files.watch --memory 4 --max-hourly-usd 0.15
  Common terminal/snapshot=false does not disable declared provider extensions.

Quotes choose the cheapest compatible offering under the ceiling; check the
returned offering.id, then create with --quote-id. For an exact catalog entry,
inspect offerings and use create --offering-id; quote has no --offering-id flag.
Returns a short-lived quote without creating or billing an instance.`,
  list: `USAGE
  xapi-to sandbox list [--provider NAME] [--format json|pretty|table]

Lists current Sandbox instances visible to the configured xAPI key.`,
  history: `USAGE
  xapi-to sandbox history [--state STATE] [--search TEXT] [--from ISO] [--to ISO]
    [--page N] [--page-size 1-100] [--format json|pretty|table]

Searches current and historical Sandbox instances with server-side pagination.`,
  get: `USAGE
  xapi-to sandbox get <id> [--format json|pretty|table]

Returns current state, operations, usage, billing, and service-calculated cost.`,
  create: `USAGE
  xapi-to sandbox create [selection flags] [--max-hourly-usd N] [--wait]

SELECTION MODES
  --quote-id ID                      Create from an existing quote
  --offering-id ID                   Create an exact offering (cannot use a price ceiling)
  --requirements <json>              Create from requirements
  --capabilities/--cpu/--memory/...  Requirements shortcuts

CONTROL
  --idempotency-key KEY              Stable retry key; generated and returned if omitted
  --metadata <json>                  Instance metadata
  --resume-on-access                 Request automatic resume on supported providers
  --wait                             Wait until RUNNING
  --wait-timeout 5m  --interval 2s   Polling controls

Quote selection uses requirements; --offering-id chooses an exact catalog entry
and cannot be combined with requirements or --max-hourly-usd. Review its rate card
in offerings first, or quote requirements under a ceiling and use --quote-id.
On a wait failure, the error includes the instance ID and recovery instructions.`,
  wait: `USAGE
  xapi-to sandbox wait <id> [--state RUNNING[,STATE]]
    [--wait-timeout 5m] [--interval 2s]

State names are case-insensitive and validated before polling.`,
  exec: `USAGE
  xapi-to sandbox exec <id> --command <shell> [--cwd PATH] [--env <json>] [--timeout SECONDS]
    [--background|--stream]
  xapi-to sandbox exec <id> -- <command...>

Executes a command and maps a remote non-zero exit code to the local process.
Each invocation launches once; command POSTs are not automatically retried.
Ordinary exec has no caller --idempotency-key. After a timeout or lost response,
inspect the original command's logs/state/artifacts before choosing a new execution.
Foreground --timeout defaults to 60 seconds; background has no injected default.
--background requires offering.capabilities.backgroundExec=true and returns a
provider-managed session immediately; this is launch acknowledgement, not readiness.
Use it for long-running Web servers and verify the listening service separately.
Stream disconnection has provider-specific process effects: Daytona deletes its
private foreground session, which can stop that command and its shell children.
--background retains its provider session; disconnecting an output reader does
not request termination of a user background process.`,
  file: `USAGE
  xapi-to sandbox file upload <id> <remote> --file <local>
  xapi-to sandbox file download <id> <remote> --output <local>
  xapi-to sandbox file write <id> <remote> (--file <local>|--content <text>)
  xapi-to sandbox file read <id> <remote> [--output <local>]
  xapi-to sandbox file list <id> [--path <remote>] [--depth N]

file download streams native binary files when the provider supports it.
file upload streams native binary uploads when the provider supports it.
file write uses JSON/base64 for compatibility. --output never overwrites a file.`,
  port: `USAGE
  xapi-to sandbox port <id> <1-65535>

Returns the provider's temporary public URL for a listening instance port.
Include returned headers in HTTP requests. Daytona uses x-daytona-preview-token;
a browser opening the URL without that header can receive 401.
Vercel ports may first require vercel.update with input {"ports":[3000]}.`,
  extension: `USAGE
  xapi-to sandbox extension <id> <extension-id> [--input <json>]
    [--idempotency-key KEY] [--stream]

Invoke extension IDs declared by the offering. --stream connects CF native PTY
or a log/file subscription returned by the extension; it does not replay the operation.
Inspect offering.capabilities.extensions for inputSchema and extensionIds for IDs.
To select an offering by extension, quote --capabilities extension:<ID>.
Common terminal/snapshot=false does not disable these provider-specific APIs.
vercel.snapshot.list uses native input.limit 1-50; follow its cursor even when
an ownership-filtered page is empty. These are provider limits, not new CLI flags.`,
  audit: `USAGE
  xapi-to sandbox audit <id> [--kind operations|events|usageSegments|billingPeriods]
    [--billing-status settled|pending|all]
    [--page N] [--page-size 1-100] [--format json|pretty|table]`,
  snapshot: `USAGE
  xapi-to sandbox snapshot <id> [--idempotency-key KEY]

Returns the snapshot operation. Native snapshot behavior differs by provider;
inspect sandbox get and provider snapshot extensions for state and artifacts.
A snapshot may stop runtime. No automatic resume or repeat is performed.`,
  suspend: `USAGE
  xapi-to sandbox suspend <id> [--no-wait] [--idempotency-key KEY]
    [--wait-timeout 5m] [--interval 2s]

Check offering lifecycle support before suspending; storage may continue billing.`,
  resume: `USAGE
  xapi-to sandbox resume <id> [--no-wait] [--idempotency-key KEY]
    [--wait-timeout 5m] [--interval 2s]`,
  terminate: `USAGE
  xapi-to sandbox terminate <id> [--no-wait] [--idempotency-key KEY]
    [--wait-timeout 5m] [--interval 2s]

Waits for TERMINATED or FAILED by default.`,
  run: `USAGE
  xapi-to sandbox run --command <shell> [selection flags] [run flags]
  xapi-to sandbox run [selection flags] -- <command...>

RUN FLAGS
  --max-hourly-usd N                Hard ceiling (default: 0.20)
  --timeout SECONDS                 Remote command timeout (default: 60)
  --cwd PATH                        Remote working directory
  --metadata <json>                 Instance metadata for audit correlation
  --idempotency-key KEY             Stable create retry key
  --wait-timeout 5m  --interval 2s  Lifecycle polling controls
  --keep                            Keep the instance running and billing

Runs quote -> create -> wait -> exec -> terminate. Cleanup also runs after
command failure, SIGINT, or SIGTERM.`,
};

const COMMON_FLAGS = ['help', 'host', 'provider', 'format'] as const;
const SELECTION_FLAGS = [
  'capabilities', 'cpu', 'memory', 'volume', 'gpu-count', 'gpu-model',
  'regions', 'min-runtime', 'requirements', 'max-hourly-usd',
] as const;
const POLL_FLAGS = ['wait-timeout', 'interval'] as const;

function help(flags: Record<string, string>, command: SandboxCommand): void {
  if (flags.help) {
    console.log(`xapi-to sandbox ${command}\n\n${SANDBOX_COMMAND_HELP[command]}\n\nCOMMON\n  --host HOST  --provider NAME  --format json|pretty|table  --help\n  --provider pins a published host prefix; vendor names need a deployed alias.\n  Omit it (or use auto) for compatible selection across the aggregation catalog.`);
    process.exit(0);
  }
}

function validateFlags(
  flags: Record<string, string>,
  command: SandboxCommand,
  allowed: readonly string[] = [],
): void {
  const valid = new Set<string>([...COMMON_FLAGS, ...allowed]);
  const unknown = Object.keys(flags).filter((flag) => !valid.has(flag));
  if (unknown.length) {
    err(`unknown flag${unknown.length > 1 ? 's' : ''} for sandbox ${command}: ${unknown.map((flag) => `--${flag}`).join(', ')}`, {
      hint: `run xapi-to sandbox ${command} --help`,
      validFlags: [...valid].sort().map((flag) => `--${flag}`),
    });
  }
  if (flags.format && !['json', 'pretty', 'table'].includes(flags.format)) {
    err('--format must be one of: json, pretty, table');
  }
}

type SandboxTableView = 'offerings' | 'quote' | 'instances' | 'detail' | 'run';

function collection(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.data)) return data.data;
  return data ? [data] : [];
}

function capability(value: any, name: string): string {
  const enabled = value?.capabilities?.[name];
  return enabled === true ? 'yes' : enabled === false ? 'no' : '';
}

/** Produce compact, stable rows instead of truncating nested Sandbox JSON. */
export function sandboxTableRows(view: SandboxTableView, data: any): Record<string, unknown>[] {
  if (view === 'offerings') {
    return collection(data).map((item) => ({
      id: item.id,
      name: item.name,
      cpu: item.resources?.cpu,
      memoryGiB: item.resources?.memoryGiB,
      volumeGiB: item.resources?.volumeGiB,
      gpu: Array.isArray(item.resources?.gpu)
        ? item.resources.gpu.map((gpu: any) => `${gpu.count || 1}x ${gpu.model || 'GPU'}`).join(', ')
        : '',
      exec: capability(item, 'exec'),
      background: capability(item, 'backgroundExec'),
      files: capability(item, 'files'),
      ports: capability(item, 'ports'),
      suspend: item.lifecycle?.suspension?.supported === true ? 'yes' : 'no',
      hourlyUsd: item.billing?.estimatedHourlyUsdByState?.RUNNING,
      extensions: Array.isArray(item.capabilities?.extensionIds)
        ? item.capabilities.extensionIds.join(',')
        : '',
    }));
  }
  if (view === 'quote') {
    return collection(data).map((item) => ({
      quoteId: item.quoteId || item.id,
      offeringId: item.offeringId || item.offering?.id,
      offering: item.offering?.name || item.offeringName,
      provider: item.provider?.name || item.providerName || item.provider,
      hourlyUsd: item.estimatedHourlyUsd || item.hourlyUsd
        || item.offering?.billing?.estimatedHourlyUsdByState?.RUNNING,
      expiresAt: item.expiresAt,
    }));
  }
  if (view === 'run') {
    return collection(data).map((item) => ({
      instanceId: item.instanceId,
      provider: item.provider,
      offering: item.offering?.name || item.offering,
      exitCode: item.result?.exitCode,
      finalState: item.finalState,
      cleanup: item.cleanup?.state || (item.cleanup?.kept ? 'KEPT' : ''),
      totalCost: item.totalCost,
    }));
  }
  return collection(data).map((item) => ({
    id: item.id || item.instanceId,
    state: item.observedState || item.state || item.finalState,
    desiredState: item.desiredState,
    offering: item.offering?.name || item.offeringName || item.offeringId,
    provider: item.provider?.name || item.providerName || item.provider,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    totalCost: item.totalCost,
  }));
}

function sandboxOutput(
  view: SandboxTableView,
  data: unknown,
  flags: Record<string, string>,
): void {
  const format = (flags.format || getFormat()) as 'json' | 'pretty' | 'table';
  if (format === 'table') {
    output(sandboxTableRows(view, data), 'table');
    return;
  }
  output(data, flags.format as 'json' | 'pretty' | undefined);
}

function flagValue(flags: Record<string, string>, name: string): string | undefined {
  const value = flags[name];
  if (value === 'true') err(`--${name} requires a value`);
  return value;
}

function booleanFlag(flags: Record<string, string>, name: string): boolean {
  const raw = flags[name];
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  err(`--${name} must be a boolean flag or --${name}=true|false`);
}

function positiveNumber(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) err(`--${name} must be a positive number`);
  return value;
}

function positiveInteger(raw: string | undefined, name: string): number | undefined {
  const value = positiveNumber(raw, name);
  if (value !== undefined && !Number.isInteger(value)) err(`--${name} must be a positive integer`);
  return value;
}

function durationMs(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  if (raw === 'true') err(`--${name} requires a value`);
  const match = raw.trim().toLowerCase().match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match || Number(match[1]) <= 0) err(`--${name} must be a duration like 500ms, 2s, 5m, 1h, or 1d`);
  const value = Number(match[1]);
  return value * ({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] || 'ms']!);
}

function jsonObject(raw: string, name: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value;
  } catch (error: any) {
    err(`--${name} must be a valid JSON object`, error.message);
  }
}

function csv(raw?: string): string[] | undefined {
  if (!raw) return undefined;
  return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

export function sandboxOptions(flags: Record<string, string>): SandboxClientOptions {
  const cfg = getConfig();
  requireApiKey(cfg);
  const host = flagValue(flags, 'host') || cfg.sandboxHost || XAPI_SANDBOX_HOST;
  const provider = flagValue(flags, 'provider');
  return { sandboxHost: host, apiKey: cfg.apiKey!, ...(provider ? { provider } : {}) };
}

/** Parse only the minimum lease requirement without rounding through milliseconds. */
function minimumRuntimeSeconds(raw: string): number {
  const match=raw.trim().toLowerCase().match(/^(\d+)(ms|s|m|h|d)?$/);
  if (!match || BigInt(match[1]) <= 0n) err('--min-runtime must be a duration like 500ms, 2s, 5m, 1h, or 1d');
  const factor={ms:1n,s:1000n,m:60000n,h:3600000n,d:86400000n}[match[2] || 'ms']!;
  const seconds=(BigInt(match[1])*factor+999n)/1000n;
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER)) err('--min-runtime exceeds exact integer seconds');
  return Number(seconds);
}

export function requirementsFromFlags(
  flags: Record<string, string>,
  defaultCapabilities?: string[],
): SandboxRequirements {
  const requirements = flagValue(flags, 'requirements')
    ? jsonObject(flagValue(flags, 'requirements')!, 'requirements') as SandboxRequirements
    : {};
  const capabilities = csv(flagValue(flags, 'capabilities'))
    || (Array.isArray(requirements.capabilities) ? undefined : defaultCapabilities);
  const regions = csv(flagValue(flags, 'regions'));
  const cpu = positiveNumber(flagValue(flags, 'cpu'), 'cpu');
  const memory = positiveNumber(flagValue(flags, 'memory'), 'memory');
  const volume = positiveNumber(flagValue(flags, 'volume'), 'volume');
  const gpuCount = positiveInteger(flagValue(flags, 'gpu-count'), 'gpu-count');
  if (gpuCount !== undefined && !Number.isSafeInteger(gpuCount)) err('--gpu-count must be a positive safe integer');
  const gpuModel = flagValue(flags, 'gpu-model');
  const minRuntime = flagValue(flags, 'min-runtime');
  if (gpuModel && gpuCount === undefined && !(Number(requirements.gpu?.count) > 0)) {
    err('--gpu-model requires --gpu-count (or requirements.gpu.count)');
  }
  if (capabilities?.length) requirements.capabilities = capabilities;
  if (regions?.length) requirements.regions = regions;
  if (cpu !== undefined) requirements.cpu = { ...(requirements.cpu || {}), min: cpu };
  if (memory !== undefined) requirements.memoryGiB = { ...(requirements.memoryGiB || {}), min: memory };
  if (volume !== undefined) requirements.volumeGiB = { ...(requirements.volumeGiB || {}), min: volume };
  if (gpuCount !== undefined || gpuModel) {
    requirements.gpu = {
      ...(requirements.gpu || {}),
      ...(gpuCount !== undefined ? { count: gpuCount } : {}),
      ...(gpuModel ? { model: gpuModel } : {}),
    };
  }
  if (minRuntime !== undefined) {
    requirements.minContinuousRuntimeSeconds = minimumRuntimeSeconds(minRuntime);
  }
  return requirements;
}

function quoteBody(flags: Record<string, string>, defaultCapabilities?: string[]): Record<string, unknown> {
  const max = positiveNumber(flagValue(flags, 'max-hourly-usd'), 'max-hourly-usd');
  return {
    requirements: requirementsFromFlags(flags, defaultCapabilities),
    ...(max !== undefined ? { maxEstimatedHourlyUsd: max.toFixed(8) } : {}),
  };
}

function createDefaultCapabilities(flags: Record<string, string>): string[] | undefined {
  // A complete requirements document and managed GPU offerings may intentionally
  // omit the standard exec surface. Do not silently make those selections impossible.
  if (flagValue(flags, 'requirements')
    || flagValue(flags, 'provider') === 'runpod'
    || flagValue(flags, 'gpu-count')
    || flagValue(flags, 'gpu-model')) return undefined;
  return ['exec'];
}

function waitSettings(flags: Record<string, string>) {
  return {
    timeoutMs: durationMs(flags['wait-timeout'], 300_000, 'wait-timeout'),
    intervalMs: durationMs(flags.interval, 2_000, 'interval'),
  };
}

function commandFrom(args: string[], flags: Record<string, string>, usage: string): string {
  const fromFlag = flagValue(flags, 'command');
  const command = fromFlag ?? args.join(' ');
  if (!command.trim()) err(usage);
  return command;
}

function instanceId(args: string[], usage: string): string {
  if (!args[0]) err(usage);
  return args[0];
}

async function terminateAndWait(
  opts: SandboxClientOptions,
  id: string,
  flags: Record<string, string>,
): Promise<{ operation?: unknown; sandbox: SandboxDetail; clientIdempotencyKey: string }> {
  const { timeoutMs, intervalMs } = waitSettings(flags);
  const deadline = Date.now() + timeoutMs;
  const clientIdempotencyKey = flagValue(flags, 'idempotency-key') || `cli:terminate:${randomUUID()}`;
  let operation: unknown;
  while (Date.now() < deadline) {
    const detail = await sandbox.sandboxGet(opts, id);
    if (['TERMINATED', 'FAILED'].includes(String(detail.observedState))) {
      return { operation, sandbox: detail, clientIdempotencyKey };
    }
    try {
      operation = await sandbox.sandboxStateAction(opts, id, 'terminate', {
        idempotencyKey: clientIdempotencyKey,
      });
      break;
    } catch (error) {
      // A 409 means another state change is still in progress and terminate was
      // rejected, so retrying after observing state is safe. Other ambiguous
      // mutation failures are not blindly retried.
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  const remaining = Math.max(1, deadline - Date.now());
  let detail: SandboxDetail;
  try {
    detail = await sandbox.sandboxWait(opts, id, ['TERMINATED', 'FAILED'], remaining, intervalMs);
  } catch (error) {
    // A provider-pinned edge can briefly stop resolving the instance after a
    // successful terminate. Reconcile through the aggregate read route instead
    // of retrying the mutation or reporting a leaked instance.
    if (!(error instanceof HttpError) || error.status !== 404 || !opts.provider) throw error;
    detail = await sandbox.sandboxWait(
      { ...opts, provider: undefined },
      id,
      ['TERMINATED', 'FAILED'],
      Math.max(1, deadline - Date.now()),
      intervalMs,
    );
  }
  const operationId = (operation as any)?.id;
  const confirmed = Array.isArray(detail.operations)
    ? detail.operations.find((item: any) => item.id === operationId)
    : undefined;
  return { operation: confirmed || operation, sandbox: detail, clientIdempotencyKey };
}

function cleanupSummary(cleanup: any): Record<string, unknown> | undefined {
  if (!cleanup) return undefined;
  if (cleanup.error) return { error: cleanup.error };
  return {
    operationId: cleanup.operation?.id,
    operationStatus: cleanup.sandbox?.operations?.find?.((item: any) => item.type === 'TERMINATE')?.status
      || cleanup.operation?.status,
    state: cleanup.sandbox?.observedState,
    totalCost: cleanup.sandbox?.totalCost,
  };
}

export function sandboxResultExitCode(result: unknown): number | undefined {
  const value = (result as any)?.exitCode;
  if (typeof value !== 'number' || value === 0) return undefined;
  return Math.min(255, Math.max(1, Math.trunc(value)));
}

export async function sandboxOfferings(args: string[], flags: Record<string, string>) {
  help(flags, 'offerings');
  validateFlags(flags, 'offerings');
  try { sandboxOutput('offerings', await sandbox.sandboxOfferings(sandboxOptions(flags)), flags); }
  catch (error: any) { err('sandbox offerings failed', error.message); }
}

export async function sandboxQuote(args: string[], flags: Record<string, string>) {
  help(flags, 'quote');
  validateFlags(flags, 'quote', SELECTION_FLAGS);
  try { sandboxOutput('quote', await sandbox.sandboxQuote(sandboxOptions(flags), quoteBody(flags)), flags); }
  catch (error: any) { err('sandbox quote failed', error.message); }
}

export async function sandboxList(args: string[], flags: Record<string, string>) {
  help(flags, 'list');
  validateFlags(flags, 'list');
  try { sandboxOutput('instances', await sandbox.sandboxList(sandboxOptions(flags)), flags); }
  catch (error: any) { err('sandbox list failed', error.message); }
}

export async function sandboxHistory(args: string[], flags: Record<string, string>) {
  help(flags, 'history');
  validateFlags(flags, 'history', ['state', 'search', 'from', 'to', 'page', 'page-size']);
  const state = flagValue(flags, 'state');
  const allowedStates = ['ALL', 'ACTIVE', 'HISTORY', 'PROVISIONING', 'RUNNING', 'SUSPENDED', 'TERMINATED', 'FAILED', 'UNKNOWN'];
  if (state && !allowedStates.includes(state.toUpperCase())) {
    err(`--state must be one of: ${allowedStates.join(', ')}`);
  }
  const page = positiveInteger(flagValue(flags, 'page'), 'page') || 1;
  const pageSize = positiveInteger(flagValue(flags, 'page-size'), 'page-size') || 100;
  if (pageSize > 100) err('--page-size must be at most 100');
  try {
    sandboxOutput('instances', await sandbox.sandboxHistory(sandboxOptions(flags), {
      ...(state ? { state: state.toUpperCase() } : {}),
      ...(flagValue(flags, 'search') ? { search: flagValue(flags, 'search') } : {}),
      ...(flagValue(flags, 'from') ? { from: flagValue(flags, 'from') } : {}),
      ...(flagValue(flags, 'to') ? { to: flagValue(flags, 'to') } : {}),
      page,
      pageSize,
    }), flags);
  } catch (error: any) { err('sandbox history failed', error.message); }
}

export async function sandboxGet(args: string[], flags: Record<string, string>) {
  help(flags, 'get');
  validateFlags(flags, 'get');
  const id = instanceId(args, 'usage: xapi-to sandbox get <id>');
  try { sandboxOutput('detail', await sandbox.sandboxGet(sandboxOptions(flags), id), flags); }
  catch (error: any) { err('sandbox get failed', error.message); }
}

export async function sandboxCreate(args: string[], flags: Record<string, string>) {
  help(flags, 'create');
  validateFlags(flags, 'create', [
    ...SELECTION_FLAGS, ...POLL_FLAGS, 'quote-id', 'offering-id', 'metadata',
    'idempotency-key', 'resume-on-access', 'wait',
  ]);
  const wait = booleanFlag(flags, 'wait');
  const resumeOnAccess = booleanFlag(flags, 'resume-on-access');
  const opts = sandboxOptions(flags);
  const quoteId = flagValue(flags, 'quote-id');
  const offeringId = flagValue(flags, 'offering-id');
  const maxHourly = flagValue(flags, 'max-hourly-usd');
  const requirementFlags = [
    'requirements', 'capabilities', 'cpu', 'memory', 'volume', 'gpu-count',
    'gpu-model', 'regions', 'min-runtime',
  ].filter((name) => flagValue(flags, name) !== undefined);
  if (quoteId && offeringId) err('--quote-id and --offering-id are mutually exclusive');
  if ((quoteId || offeringId) && requirementFlags.length) {
    err(`${quoteId ? '--quote-id' : '--offering-id'} cannot be combined with requirement flags`, {
      conflictingFlags: requirementFlags.map((name) => `--${name}`),
    });
  }
  if (quoteId && maxHourly) {
    err('--max-hourly-usd cannot be combined with --quote-id; the quote already fixes the price');
  }
  if (offeringId && maxHourly) {
    err('--max-hourly-usd cannot be combined with --offering-id; create from requirements to enforce a price ceiling');
  }
  const idempotencyKey = flagValue(flags, 'idempotency-key') || `cli:create:${randomUUID()}`;
  let created: SandboxDetail | undefined;
  try {
    let selection: Record<string, unknown>;
    if (quoteId) selection = { quoteId };
    else if (offeringId) selection = { offeringId };
    else if (maxHourly) {
      const quoted = await sandbox.sandboxQuote(opts, quoteBody(flags, createDefaultCapabilities(flags)));
      if (!quoted?.quoteId) throw new Error('quote response did not include quoteId');
      selection = { quoteId: quoted.quoteId };
    } else selection = { requirements: requirementsFromFlags(flags, createDefaultCapabilities(flags)) };
    const metadata = flagValue(flags, 'metadata')
      ? jsonObject(flagValue(flags, 'metadata')!, 'metadata')
      : { client: 'xapi-cli' };
    created = await sandbox.sandboxCreate(opts, {
      selection,
      metadata,
      idempotencyKey,
      policy: { resumeOnAccess },
    });
    let result = created;
    if (wait && created.id) {
      const settings = waitSettings(flags);
      result = await sandbox.sandboxWait(opts, created.id, ['RUNNING'], settings.timeoutMs, settings.intervalMs);
    }
    sandboxOutput('detail', { ...result, clientIdempotencyKey: idempotencyKey }, flags);
  } catch (error: any) {
    let latest = created;
    if (created?.id) {
      try { latest = await sandbox.sandboxGet(opts, created.id); }
      catch { /* Preserve the original failure and the known instance ID. */ }
    }
    err('sandbox create failed', {
      message: error.message,
      instanceId: created?.id,
      observedState: latest?.observedState,
      clientIdempotencyKey: idempotencyKey,
      recovery: created?.id
        ? {
            inspect: `xapi-to sandbox get ${created.id}`,
            terminate: `xapi-to sandbox terminate ${created.id}`,
          }
        : {
            retry: `repeat the create command with --idempotency-key ${idempotencyKey}`,
            reconcile: 'xapi-to sandbox history --state ACTIVE --page-size 100',
          },
    });
  }
}

export async function sandboxWait(args: string[], flags: Record<string, string>) {
  help(flags, 'wait');
  validateFlags(flags, 'wait', ['state', ...POLL_FLAGS]);
  const id = instanceId(args, 'usage: xapi-to sandbox wait <id> [--state RUNNING]');
  const allowedStates = ['PROVISIONING', 'RUNNING', 'SUSPENDING', 'SUSPENDED', 'RESUMING', 'TERMINATING', 'TERMINATED', 'FAILED', 'UNKNOWN'];
  const wanted = (csv(flagValue(flags, 'state')) || ['RUNNING']).map((state) => state.toUpperCase());
  const invalid = wanted.filter((state) => !allowedStates.includes(state));
  if (invalid.length) err(`--state must contain only: ${allowedStates.join(', ')}`);
  const settings = waitSettings(flags);
  try {
    output(await sandbox.sandboxWait(sandboxOptions(flags), id, wanted, settings.timeoutMs, settings.intervalMs), flags.format as any);
  } catch (error: any) { err('sandbox wait failed', error.message); }
}

export async function sandboxExec(args: string[], flags: Record<string, string>) {
  help(flags, 'exec');
  validateFlags(flags, 'exec', ['command', 'timeout', 'cwd', 'env', 'background', 'stream']);
  const id = instanceId(args, 'usage: xapi-to sandbox exec <id> --command <shell>');
  const command = commandFrom(args.slice(1), flags, 'usage: xapi-to sandbox exec <id> --command <shell>');
  const background = booleanFlag(flags, 'background');
  const timeoutSeconds = positiveInteger(flagValue(flags, 'timeout'), 'timeout') ?? (background ? undefined : 60);
  const envValue = flagValue(flags, 'env');
  const env = envValue === undefined ? undefined : jsonObject(envValue, 'env');
  if (env && Object.values(env).some(value => typeof value !== 'string')) err('--env must be a JSON object of string values');
  try {
    if (booleanFlag(flags, 'stream')) {
      if (background) err('--stream follows a foreground command; use --background without --stream to launch a process');
      const cancel = new AbortController();
      const interrupt = () => cancel.abort(new Error('Command output disconnected by caller'));
      process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
      try {
        for await (const event of sandbox.sandboxExecStream(sandboxOptions(flags), id,
          { command, timeoutSeconds, ...(env ? { env: env as Record<string, string> } : {}), ...(flagValue(flags, 'cwd') ? { cwd: flagValue(flags, 'cwd') } : {}) }, cancel.signal)) {
          if (event.type === 'stdout' || event.type === 'stderr') {
            const target = event.type === 'stdout' ? process.stdout : process.stderr;
            if (!target.write(Buffer.from(event.data, 'base64'))) await once(target, 'drain', { signal: cancel.signal });
          } else if (event.type === 'exit') {
            const exitCode = sandboxResultExitCode(event); if (exitCode !== undefined) process.exitCode = exitCode;
          }
        }
      } finally { cancel.abort(); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
      return;
    }
    const result = await sandbox.sandboxExec(sandboxOptions(flags), id, {
      command,
      ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
      ...(env ? { env: env as Record<string, string> } : {}),
      ...(flagValue(flags, 'cwd') ? { cwd: flagValue(flags, 'cwd') } : {}),
      ...(background ? { background: true } : {}),
    });
    output(result, flags.format as any);
    const exitCode = sandboxResultExitCode(result);
    if (exitCode !== undefined) process.exitCode = exitCode;
  } catch (error: any) { err('sandbox exec failed', error.message); }
}

export async function sandboxFile(args: string[], flags: Record<string, string>) {
  help(flags, 'file');
  validateFlags(flags, 'file', ['file', 'content', 'output', 'path', 'depth']);
  const [action, id, remote] = args;
  if (!action || !id) err('usage: xapi-to sandbox file <write|upload|read|download|list> <id> [remote-path]');
  const opts = sandboxOptions(flags);
  try {
    if (action === 'upload') {
      const local = flagValue(flags, 'file');
      if (!remote || !local) err('usage: xapi-to sandbox file upload <id> <remote-path> --file <local>');
      if (flagValue(flags, 'content')) err('file upload reads binary data from --file');
      const abort = new AbortController(), interrupted = () => abort.abort();
      process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
      const handle = await open(local, 'r');
      const source = handle.createReadStream({ autoClose: false });
      try { output(await sandbox.sandboxFileUpload(opts, id, remote, source, abort.signal), flags.format as any); }
      finally { source.destroy(); await handle.close(); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
      return;
    }
    if (action === 'write') {
      if (!remote) err('usage: xapi-to sandbox file write <id> <remote-path> (--file <local>|--content <text>)');
      const local = flagValue(flags, 'file');
      const inline = flagValue(flags, 'content');
      if (Boolean(local) === Boolean(inline)) err('provide exactly one of --file or --content');
      const body = local
        ? { path: remote, content: (await readFile(local)).toString('base64'), encoding: 'base64' as const }
        : { path: remote, content: inline!, encoding: 'utf8' as const };
      output(await sandbox.sandboxFileWrite(opts, id, body), flags.format as any);
      return;
    }
    if (action === 'download') {
      if (!remote) err('usage: xapi-to sandbox file download <id> <remote-path> --output <local>');
      const outputPath = flagValue(flags, 'output');
      if (!outputPath) err('sandbox file download requires --output');
      const target = resolve(outputPath);
      const abort = new AbortController();
      const interrupted = () => abort.abort();
      process.once('SIGINT', interrupted);
      process.once('SIGTERM', interrupted);
      try {
        const file = await open(target, 'wx');
        let complete = false;
        try {
          let bytes = 0;
          const stream = await sandbox.sandboxFileDownload(opts, id, remote, abort.signal);
          const reader = stream.getReader();
          const cancel = () => { void reader.cancel().catch(() => undefined); };
          abort.signal.addEventListener('abort', cancel, { once: true });
          try {
            if (abort.signal.aborted) throw new Error('Download interrupted');
            for (;;) {
              const next = await reader.read(); if (next.done) break;
              let offset = 0;
              while (offset < next.value.length) {
                const written = (await file.write(next.value, offset, next.value.length-offset)).bytesWritten;
                if (!written) throw new Error('Local file write made no progress');
                offset += written;
              }
              bytes += next.value.length;
            }
            if (abort.signal.aborted) throw new Error('Download interrupted');
          } finally {
            abort.signal.removeEventListener('abort', cancel);
            await reader.cancel().catch(() => undefined); reader.releaseLock();
          }
          complete = true;
          output({ output: target, bytes, path: remote }, flags.format as any);
        } finally {
          await file.close();
          if (!complete) await rm(target, { force: true });
        }
      } finally {
        process.removeListener('SIGINT', interrupted);
        process.removeListener('SIGTERM', interrupted);
      }
      return;
    }
    if (action === 'read') {
      if (!remote) err('usage: xapi-to sandbox file read <id> <remote-path> [--output <local>]');
      const outputPath = flagValue(flags, 'output');
      const result = await sandbox.sandboxFileRead(opts, id, remote, outputPath ? 'base64' : 'utf8');
      if (!outputPath) { output(result, flags.format as any); return; }
      const target = resolve(outputPath);
      const file = await open(target, 'wx'); let complete = false;
      try {
        const data = result?.encoding === 'base64' ? Buffer.from(String(result.content || ''), 'base64') : Buffer.from(String(result?.content || ''), 'utf8');
        await file.writeFile(data); complete = true;
        output({ output: target, bytes: data.length, path: remote }, flags.format as any);
      } finally { await file.close(); if (!complete) await rm(target, { force: true }); }
      return;
    }
    if (action === 'list') {
      const depth = positiveInteger(flagValue(flags, 'depth'), 'depth') || 2;
      output(await sandbox.sandboxFileList(opts, id, flagValue(flags, 'path') || remote || '.', depth), flags.format as any);
      return;
    }
    err(`unknown sandbox file command: ${action}`);
  } catch (error: any) { err(`sandbox file ${action} failed`, error.message); }
}

export async function sandboxPort(args: string[], flags: Record<string, string>) {
  help(flags, 'port');
  validateFlags(flags, 'port');
  const id = instanceId(args, 'usage: xapi-to sandbox port <id> <port>');
  const port = positiveInteger(args[1], 'port');
  if (!port || port > 65_535) err('port must be between 1 and 65535');
  try { output(await sandbox.sandboxPort(sandboxOptions(flags), id, port), flags.format as any); }
  catch (error: any) { err('sandbox port failed', error.message); }
}

export async function sandboxExtension(args: string[], flags: Record<string, string>) {
  help(flags, 'extension');
  validateFlags(flags, 'extension', ['input', 'idempotency-key', 'stream']);
  const id = instanceId(args, 'usage: xapi-to sandbox extension <id> <extension-id> --input <json>');
  const extensionId = args[1];
  if (!extensionId) err('usage: xapi-to sandbox extension <id> <extension-id> --input <json>');
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/i.test(extensionId)) err('invalid Sandbox extension id');
  const input = flagValue(flags, 'input') ? jsonObject(flagValue(flags, 'input')!, 'input') : {};
  const streaming = booleanFlag(flags, 'stream');
  if (streaming && !['cloudflare.terminal.open', 'cloudflare.process.log_stream', 'cloudflare.files.watch'].includes(extensionId))
    err('--stream consumes terminal.open, process.log_stream or files.watch; other extensions return JSON');
  const clientIdempotencyKey = flagValue(flags, 'idempotency-key')
    || `cli:extension:${extensionId}:${randomUUID()}`;
  let connectionReturned = false;
  try {
    const result = await sandbox.sandboxExtension(sandboxOptions(flags), id, extensionId, {
      input,
      idempotencyKey: clientIdempotencyKey,
    });
    if (streaming) {
      connectionReturned = true;
      const native = result?.result?.result ?? result?.result;
      if (typeof native?.url !== 'string') throw new Error('Extension did not return a connection URL');
      if (native.protocol === 'CF_NATIVE_PTY_V1') await consumeCfTerminal(native.url);
      else if (native.protocol === 'CF_PROCESS_LOG_SSE_V1') await consumeCfLogs(native.url);
      else if (native.protocol === 'CF_FILE_WATCH_SSE_V1') await consumeCfFileEvents(native.url);
      else throw new Error('Extension does not return a supported streaming protocol');
    } else output({ ...result, clientIdempotencyKey }, flags.format as any);
  } catch (error: any) {
    err('sandbox extension failed', {
      message: error.message,
      clientIdempotencyKey,
      retry: connectionReturned
        ? 'Open a new connection grant with a new idempotency key; reuse sessionId or log byte offsets. This does not replay the business command.'
        : `Check status with xapi-to sandbox audit ${id} --kind operations. For an unconfirmed outcome, reconcile with --idempotency-key ${clientIdempotencyKey}. For confirmed FAILED, fix the upstream reason, then deliberately use a NEW idempotency key; the original key returns the original failure.`,
    });
  }
}

export async function sandboxAudit(args: string[], flags: Record<string, string>) {
  help(flags, 'audit');
  validateFlags(flags, 'audit', ['kind', 'page', 'page-size', 'billing-status']);
  const id = instanceId(args, 'usage: xapi-to sandbox audit <id> [--kind operations]');
  const kind = flagValue(flags, 'kind') || 'operations';
  const allowed = ['operations', 'events', 'usageSegments', 'billingPeriods'];
  if (!allowed.includes(kind)) err(`--kind must be one of: ${allowed.join(', ')}`);
  const page = positiveInteger(flagValue(flags, 'page'), 'page') || 1;
  const pageSize = positiveInteger(flagValue(flags, 'page-size'), 'page-size') || 100;
  if (pageSize > 100) err('--page-size must be at most 100');
  const billingStatus = flagValue(flags, 'billing-status');
  if (billingStatus && !['settled', 'pending', 'all'].includes(billingStatus)) err('--billing-status must be settled, pending, or all');
  try { output(await sandbox.sandboxAudit(sandboxOptions(flags), id, kind, page, pageSize, billingStatus), flags.format as any); }
  catch (error: any) { err('sandbox audit failed', error.message); }
}

export async function sandboxSnapshot(args: string[], flags: Record<string, string>) {
  help(flags, 'snapshot');
  validateFlags(flags, 'snapshot', ['idempotency-key']);
  const id = instanceId(args, 'usage: xapi-to sandbox snapshot <id>');
  const clientIdempotencyKey = flagValue(flags, 'idempotency-key') || `cli:snapshot:${randomUUID()}`;
  try {
    const operation = await sandbox.sandboxStateAction(sandboxOptions(flags), id, 'snapshot', {
      idempotencyKey: clientIdempotencyKey,
    });
    output({ ...operation, clientIdempotencyKey }, flags.format as any);
  } catch (error: any) {
    err('sandbox snapshot failed', {
      message: error.message, instanceId: id, clientIdempotencyKey,
      recovery: { inspect: `xapi-to sandbox get ${id}`, retry: `repeat with --idempotency-key ${clientIdempotencyKey}` },
    });
  }
}

export async function sandboxState(
  action: 'suspend' | 'resume' | 'terminate',
  args: string[],
  flags: Record<string, string>,
) {
  help(flags, action);
  validateFlags(flags, action, [...POLL_FLAGS, 'no-wait', 'idempotency-key']);
  const id = instanceId(args, `usage: xapi-to sandbox ${action} <id>`);
  const opts = sandboxOptions(flags);
  const noWait = booleanFlag(flags, 'no-wait');
  const clientIdempotencyKey = flagValue(flags, 'idempotency-key') || `cli:${action}:${randomUUID()}`;
  try {
    if (action === 'terminate' && !noWait) {
      output(await terminateAndWait(opts, id, flags), flags.format as any);
      return;
    }
    const operation = await sandbox.sandboxStateAction(opts, id, action, {
      idempotencyKey: clientIdempotencyKey,
    });
    if (noWait) { output({ ...operation, clientIdempotencyKey }, flags.format as any); return; }
    const wanted = action === 'suspend' ? ['SUSPENDED'] : action === 'resume' ? ['RUNNING'] : ['TERMINATED', 'FAILED'];
    const settings = waitSettings(flags);
    const detail = await sandbox.sandboxWait(opts, id, wanted, settings.timeoutMs, settings.intervalMs);
    const confirmed = operation?.id && Array.isArray(detail.operations)
      ? detail.operations.find((item: any) => item.id === operation.id)
      : undefined;
    output({ operation: confirmed || operation, sandbox: detail, clientIdempotencyKey }, flags.format as any);
  } catch (error: any) {
    err(`sandbox ${action} failed`, {
      message: error.message,
      instanceId: id,
      clientIdempotencyKey,
      recovery: {
        inspect: `xapi-to sandbox get ${id}`,
        retry: `repeat with --idempotency-key ${clientIdempotencyKey}`,
      },
    });
  }
}

export async function sandboxRun(args: string[], flags: Record<string, string>) {
  help(flags, 'run');
  validateFlags(flags, 'run', [
    ...SELECTION_FLAGS, ...POLL_FLAGS, 'command', 'timeout', 'cwd', 'metadata', 'keep', 'idempotency-key',
  ]);
  const command = commandFrom(args, flags, 'usage: xapi-to sandbox run --command <shell>');
  const opts = sandboxOptions(flags);
  const maxHourly = flagValue(flags, 'max-hourly-usd') || '0.20';
  // Validate before any billable request.
  positiveNumber(maxHourly, 'max-hourly-usd');
  const timeoutSeconds = positiveInteger(flagValue(flags, 'timeout'), 'timeout') || 60;
  const settings = waitSettings(flags);
  const idempotencyKey = flagValue(flags, 'idempotency-key') || `cli:run:${randomUUID()}`;
  const metadata = flagValue(flags, 'metadata')
    ? jsonObject(flagValue(flags, 'metadata')!, 'metadata')
    : {};
  const keep = booleanFlag(flags, 'keep');
  let id: string | undefined;
  let failure: unknown;
  let quote: any;
  let created: SandboxDetail | undefined;
  let ready: SandboxDetail | undefined;
  let result: unknown;
  let cleanup: unknown;
  let interruptedBy: NodeJS.Signals | undefined;
  const waitAbort = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => {
    interruptedBy = signal;
    waitAbort.abort();
  };
  const interruptSigint = () => interrupt('SIGINT');
  const interruptSigterm = () => interrupt('SIGTERM');
  const throwIfInterrupted = () => {
    if (interruptedBy) throw new Error(`interrupted by ${interruptedBy}`);
  };
  process.once('SIGINT', interruptSigint);
  process.once('SIGTERM', interruptSigterm);
  try {
    quote = await sandbox.sandboxQuote(
      opts,
      quoteBody({ ...flags, 'max-hourly-usd': maxHourly }, ['exec']),
      waitAbort.signal,
    );
    if (!quote?.quoteId) throw new Error('quote response did not include quoteId');
    throwIfInterrupted();
    created = await sandbox.sandboxCreate(opts, {
      selection: { quoteId: quote.quoteId },
      metadata: { ...metadata, client: 'xapi-cli', command: 'sandbox run' },
      policy: { resumeOnAccess: false },
      idempotencyKey,
    });
    id = created?.id;
    if (!id) throw new Error('create response did not include sandbox id');
    throwIfInterrupted();
    ready = await sandbox.sandboxWait(
      opts, id, ['RUNNING'], settings.timeoutMs, settings.intervalMs, waitAbort.signal,
    );
    throwIfInterrupted();
    result = await sandbox.sandboxExec(opts, id, {
      command,
      timeoutSeconds,
      ...(flagValue(flags, 'cwd') ? { cwd: flagValue(flags, 'cwd') } : {}),
    }, waitAbort.signal);
    throwIfInterrupted();
  } catch (error) {
    failure = error;
  } finally {
    if (id && !keep) {
      try { cleanup = await terminateAndWait(opts, id, flags); }
      catch (cleanupError: any) {
        cleanup = { error: cleanupError.message };
        if (!failure) failure = new Error(`command completed but cleanup failed: ${cleanupError.message}`);
      }
    }
    process.removeListener('SIGINT', interruptSigint);
    process.removeListener('SIGTERM', interruptSigterm);
  }
  if (failure) {
    err('sandbox run failed', {
      message: (failure as any)?.message || String(failure),
      instanceId: id,
      clientIdempotencyKey: idempotencyKey,
      cleanup: keep
        ? { kept: true, warning: 'billing continues until terminated' }
        : cleanupSummary(cleanup),
      recovery: id
        ? { inspect: `xapi-to sandbox get ${id}`, terminate: `xapi-to sandbox terminate ${id}` }
        : {
            reconcile: 'xapi-to sandbox history --state ACTIVE --page-size 100',
            retryCreateWithSameKey: idempotencyKey,
          },
    });
  }
  let finalDetail: SandboxDetail | undefined;
  let finalReadError: string | undefined;
  if (id) {
    try { finalDetail = await sandbox.sandboxGet(opts, id); }
    catch (error: any) { finalReadError = error.message; }
  }
  const summary = {
    instanceId: id,
    clientIdempotencyKey: idempotencyKey,
    provider: opts.provider || 'auto',
    offering: quote?.offering,
    createdState: created?.observedState,
    readyState: ready?.observedState,
    result,
    cleanup: keep
      ? { kept: true, warning: 'billing continues until terminated' }
      : cleanupSummary(cleanup),
    finalState: finalDetail?.observedState || (cleanup as any)?.sandbox?.observedState,
    totalCost: finalDetail?.totalCost || (cleanup as any)?.sandbox?.totalCost,
    ...(finalReadError ? { finalReadError } : {}),
  };
  sandboxOutput('run', summary, flags);
  const remoteExitCode = sandboxResultExitCode(result);
  if (remoteExitCode !== undefined) process.exitCode = remoteExitCode;
}
