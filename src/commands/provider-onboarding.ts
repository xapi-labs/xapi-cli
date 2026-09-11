import { readFile } from 'node:fs/promises';
import { getConfig, requireApiKey } from '../config.ts';
import { HttpError, isRetryableRequestError } from '../client.ts';
import { output, err, type OutputFormat } from '../format.ts';
import { providerRequest, object, redactProvider, collectProviderSecrets, type ProviderObject } from '../provider-client.ts';

export const PROVIDER_ONBOARDING_HELP = `xapi-to provider - Import and publish your API services

COMMANDS
  spec-rules                       Read current OpenAPI rules (public)
  import --file openapi.json        Create a DRAFT service from OpenAPI JSON
    --private-headers-file <path>   Upstream credentials as a JSON object
  update <service-id> --revision <id> --file config.json
    --mode merge|replace           PATCH merge (default) or PUT replacement
    --allow-new-endpoints          Allow merge entries without IDs to create endpoints
  submit <service-id> --revision <id>
    --changelog <text>             Submit for review; this alone is not publication
  review <service-id> --revision <id>
                                   Read latest review and previous attempts
  wait <service-id> --revision <id>
    --interval <duration>          Poll interval (default: 2s; ms/s/m/h)
    --timeout <duration>           Overall deadline (default: 10m; ms/s/m/h)
    --max-attempts <number>         Optional cap, including transient failures

COMMON FLAGS
  --format json|pretty|table
  --help

Files must contain JSON objects; --file - reads stdin. Import reads a raw
OpenAPI spec; update reads version configuration (not a raw OpenAPI spec).
Merge updates to existing endpoints require their IDs. Use --mode replace
to replace the endpoint list, or --allow-new-endpoints to intentionally add.
Saving a draft configuration moves it to SANDBOX, ready for submit.

PERMISSIONS
  import: service:create (legacy allowRegister also accepted)
  list/get/review/wait: service:read; update: service:update
  submit: service:publish. Grant scopes in the xAPI Console API Keys settings.

wait succeeds only for PUBLISHED. Rejection, unpublished terminal states,
manual review, invalid responses, and timeouts exit nonzero with details.
Writes are not retried automatically. Credentials are redacted from output.
`;

const FLAGS: Record<string, string[]> = {
  'spec-rules': [], import: ['file', 'private-headers-file'],
  update: ['revision', 'file', 'mode', 'allow-new-endpoints'],
  submit: ['revision', 'changelog'], review: ['revision'],
  wait: ['revision', 'interval', 'timeout', 'max-attempts'],
};
const SCOPES: Record<string, string> = {
  import: 'service:create',
  update: 'service:update', submit: 'service:publish', review: 'service:read', wait: 'service:read',
};

function flag(flags: Record<string, string>, name: string, required = false): string | undefined {
  const value = flags[name];
  if ((required && value === undefined) || value === '' || value === 'true') {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function duration(raw: string, name: string): number {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(raw);
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const ms = match ? Number(match[1]) * units[match[2] || 'ms'] : NaN;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) {
    throw new Error(`--${name} must be a positive duration (ms/s/m/h), at most 2147483647ms`);
  }
  return ms;
}

async function jsonFile(path: string): Promise<ProviderObject> {
  let text: string;
  try {
    if (path === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      text = Buffer.concat(chunks).toString('utf8');
    } else text = await readFile(path, 'utf8');
  } catch { throw new Error('Could not read JSON input file'); }
  let value: unknown;
  try { value = JSON.parse(text); }
  // JSON.parse error messages can quote input credentials.
  catch { throw new Error('Input must be valid JSON (JSON objects only; YAML is not supported)'); }
  const result = object(value);
  if (!result) throw new Error('Input must be a JSON object');
  return result;
}

function segment(value: string): string {
  if (value === '.' || value === '..') throw new Error('Invalid service or revision ID');
  return encodeURIComponent(value);
}

export async function providerOnboarding(args: string[], flags: Record<string, string>): Promise<void> {
  const [command, ...rest] = args;
  if (flags.help || !command) { console.log(PROVIDER_ONBOARDING_HELP); return; }
  const secrets: string[] = [];
  const emit = (value: unknown) => output(redactProvider(value, secrets), flags.format as OutputFormat | undefined);
  try {
    if (!Object.hasOwn(FLAGS, command)) throw new Error(`Unknown provider command: ${command}`);
    for (const key of Object.keys(flags)) {
      if (!['format', ...FLAGS[command]].includes(key)) throw new Error(`Unknown flag for provider ${command}: --${key}`);
    }
    const needsService = !['spec-rules', 'import'].includes(command);
    if (rest.length !== (needsService ? 1 : 0)) throw new Error(`provider ${command} expects ${needsService ? 'one service ID' : 'no positional arguments'}`);
    const serviceId = rest[0];
    const base = serviceId ? `services/${segment(serviceId)}` : 'services';
    const revisionId = flag(flags, 'revision', ['update', 'submit', 'review', 'wait'].includes(command));
    const revisionPath = revisionId ? `${base}/revisions/${segment(revisionId)}` : '';
    const cfg = getConfig();
    if (cfg.apiKey) secrets.push(cfg.apiKey);
    if (command !== 'spec-rules') requireApiKey(cfg);
    const read = <T = ProviderObject>(path: string) => providerRequest<T>(path, cfg.apiKey);

    if (command === 'spec-rules') { emit(await providerRequest('spec-rules', undefined)); return; }
    if (command === 'import') {
      const file = flag(flags, 'file', true)!;
      const headersFile = flag(flags, 'private-headers-file');
      if (file === '-' && headersFile === '-') throw new Error('Only one input may read stdin');
      const spec = await jsonFile(file);
      const body: ProviderObject = { openApiSpec: spec };
      if (headersFile) {
        body.privateHeaders = await jsonFile(headersFile);
        if (Object.values(body.privateHeaders as ProviderObject).some(v => typeof v !== 'string')) {
          throw new Error('Private header values must be strings');
        }
      }
      secrets.push(...collectProviderSecrets(body));
      const result = await providerRequest('register-api-service', cfg.apiKey, 'POST', body);
      if (result?.success === false) { emit(result); process.exitCode = 1; return; }
      const service = object(result?.apiService);
      if (result?.success !== true || typeof service?.id !== 'string') {
        throw new Error('Unexpected import response; creation may have succeeded. Check provider list before retrying');
      }
      const active = object(service.activeVersion);
      const revision = active ?? (Array.isArray(service.versions) ? object(service.versions[0]) : undefined);
      emit({ ...result, serviceId: service.id, revisionId: revision?.id ?? service.activeVersionId ?? null,
        state: revision?.state ?? service.status ?? null });
      return;
    }
    if (command === 'update') {
      const mode = flag(flags, 'mode') ?? 'merge';
      if (!['merge', 'replace'].includes(mode)) throw new Error('--mode must be merge or replace');
      if (flags['allow-new-endpoints'] !== undefined && flags['allow-new-endpoints'] !== 'true') {
        throw new Error('--allow-new-endpoints is a boolean flag');
      }
      const body = await jsonFile(flag(flags, 'file', true)!);
      secrets.push(...collectProviderSecrets(body));
      if ('openapi' in body) throw new Error('update expects version configuration, not a raw OpenAPI spec');
      if (body.endpoints !== undefined) {
        if (!Array.isArray(body.endpoints) || body.endpoints.some(ep => !object(ep))) throw new Error('endpoints must be an array of objects');
        if (mode === 'merge' && !flags['allow-new-endpoints'] && body.endpoints.some(ep => typeof ep.id !== 'string' || !ep.id.trim())) {
          throw new Error('Merge endpoints require IDs. Use --mode replace for a full list, or --allow-new-endpoints to intentionally create endpoints');
        }
      }
      const revision = await providerRequest(`${base}/versions/${segment(revisionId!)}`, cfg.apiKey, mode === 'merge' ? 'PATCH' : 'PUT', body);
      emit({ serviceId, revisionId, state: revision?.state ?? null, revision });
      return;
    }
    if (command === 'submit') {
      const changelog = flag(flags, 'changelog');
      const submission = await providerRequest(`${revisionPath}/submit`, cfg.apiKey, 'POST', changelog ? { changelog } : {});
      emit({ serviceId, revisionId, submission });
      return;
    }
    if (command === 'review') { emit(await read(`${revisionPath}/review`)); return; }

    const intervalMs = duration(flag(flags, 'interval') ?? '2s', 'interval');
    const timeoutMs = duration(flag(flags, 'timeout') ?? '10m', 'timeout');
    const attemptsFlag = flag(flags, 'max-attempts');
    const maxAttempts = attemptsFlag === undefined ? Infinity : Number(attemptsFlag);
    if (attemptsFlag !== undefined && (!/^\d+$/.test(attemptsFlag) || !Number.isSafeInteger(maxAttempts) || maxAttempts <= 0)) {
      throw new Error('--max-attempts must be a positive integer');
    }
    const deadline = Date.now() + timeoutMs;
    let attempts = 0;
    let last: ProviderObject | undefined;
    while (true) {
      if (Date.now() >= deadline) {
        emit({ serviceId, revisionId, success: false, reason: 'timeout', attempts, last });
        process.exitCode = 1; return;
      }
      let delay = intervalMs;
      let report: ProviderObject | undefined;
      let received = false;
      attempts++;
      try {
        report = await providerRequest(`${revisionPath}/review`, cfg.apiKey, 'GET', undefined, Math.max(1, deadline - Date.now()), 0);
        received = true;
      } catch (e) {
        if (!isRetryableRequestError(e)) throw e;
        if (e instanceof HttpError && e.retryAfterMs !== undefined) delay = Math.max(intervalMs, e.retryAfterMs);
      }
      if (Date.now() >= deadline) continue;
      if (received) {
        const revision = object(report?.revision);
        const state = revision?.state;
        if (revision?.id !== revisionId || !['DRAFT', 'SANDBOX', 'IN_REVIEW', 'PUBLISHED', 'SUSPENDED'].includes(String(state))) {
          throw new Error('Invalid review response: expected requested revision ID and known state');
        }
        last = report;
        const review = object(report?.review);
        const manual = review?.outcome === 'pending_human' || review?.status === 'PENDING_HUMAN';
        const rejected = review?.outcome === 'rejected' || ['REJECTED', 'AUTO_FAILED'].includes(String(review?.status));
        if (state === 'PUBLISHED' || state !== 'IN_REVIEW' || manual || rejected) {
          const success = state === 'PUBLISHED';
          emit({ ...report, serviceId, revisionId, success, reason: success ? 'published' : manual ? 'manual_review_required' : rejected ? 'rejected' : 'not_published' });
          if (!success) process.exitCode = 1;
          return;
        }
      }
      if (attempts >= maxAttempts) {
        emit({ serviceId, revisionId, success: false, reason: 'max_attempts', attempts, last });
        process.exitCode = 1; return;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
    }
  } catch (e) {
    let message: string;
    if (e instanceof HttpError) {
      // Server errors may echo request bodies (including truncated credentials).
      message = `HTTP ${e.status}`;
      if (e.status === 403) message += `: requires ${SCOPES[command]}; check key permissions, service ownership, and IP restrictions in the xAPI Console`;
      else if (e.status === 401) message += ': invalid or expired API key';
      else if (e.status === 400) message += ': request rejected; check spec-rules, configuration, and revision state';
      else if (e.status === 409 && /"code"\s*:\s*"REVISION_NOT_EDITABLE"/.test(e.message)) {
        message += ': revision is not editable. Only DRAFT or SANDBOX can be updated; use a working revision for changes to a published API';
      }
      if (['import', 'update', 'submit'].includes(command)) message += '. No automatic retry was made; inspect provider list/get/review before retrying';
    } else message = e instanceof SyntaxError ? 'Invalid JSON response from provider API' : e instanceof Error ? e.message : 'Unknown error';
    err(`provider ${command} failed`, redactProvider(message, secrets));
  }
}
