import { readFile } from 'node:fs/promises';
import { parseYAML } from 'confbox/yaml';
import { getConfig, requireApiKey } from '../config.ts';
import { HttpError, isRetryableRequestError } from '../client.ts';
import { output, err, type OutputFormat } from '../format.ts';
import { waitForPoll } from '../poll-wait.ts';
import { providerRequest, object, redactProvider, collectProviderSecrets, type ProviderObject } from '../provider-client.ts';

export const PROVIDER_ONBOARDING_HELP = `xapi-to provider - Import and publish your API services

COMMANDS
  spec-rules                       Read current OpenAPI rules (public)
  import --file openapi.json|yaml   Create a service from OpenAPI JSON or YAML
    --default-price <USD>           Price for unpriced PER_CALL operations (0 = free)
    --private-headers-file <path>   Upstream credentials as a JSON object
  update <service-id> --revision <id> --file config.json
    --mode merge|replace           PATCH merge (default) or PUT replacement
    --allow-new-endpoints          Allow ID-less merge entries; backend key matching applies
  submit <service-id> --revision <id>
    --changelog <text>             Submit for review; passing review may publish
  review <service-id> --revision <id>
                                   Read latest review and previous attempts
  wait <service-id> --revision <id>
    --interval <duration>          Poll interval (default: 2s; ms/s/m/h)
    --timeout <duration>           Overall deadline (default: 10m; ms/s/m/h)
    --max-attempts <number>         Optional cap, including transient failures

COMMON FLAGS
  --format json|pretty|table
  --help

--file - reads stdin. Import accepts a raw JSON or YAML OpenAPI object;
configuration and credential files remain JSON. Swagger 2.0 conversion and
OpenAPI validation happen on the server. Missing prices require an explicit
choice; --default-price affects only unpriced PER_CALL operations, including
hidden ones, and preserves existing prices and other billing types.
Merge updates to existing endpoints require their IDs. Use --mode replace
to replace the endpoint list, or --allow-new-endpoints to intentionally add.
Creation with endpoints starts in PREVIEW (formerly SANDBOX); empty services
start in DRAFT. Saving a draft configuration moves it to PREVIEW, ready for submit.

PERMISSIONS
  import: service:create (legacy allowRegister also accepted)
  list/get/review/wait: service:read; update: service:update
  submit: service:publish. Grant scopes in the xAPI Console API Keys settings.

wait succeeds only for PUBLISHED. Rejection, unpublished terminal states,
manual review, invalid responses, and timeouts exit nonzero with details.
Writes are not retried automatically. Credentials are redacted from output.
`;

const FLAGS: Record<string, string[]> = {
  'spec-rules': [], import: ['file', 'private-headers-file', 'default-price'],
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

async function jsonFile(path: string, allowYaml = false): Promise<ProviderObject> {
  let text: string;
  try {
    if (path === '-') {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      text = Buffer.concat(chunks).toString('utf8');
    } else text = await readFile(path, 'utf8');
  } catch { throw new Error('Could not read input file'); }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch {
    // Parser errors and warnings can quote input credentials.
    if (!allowYaml) throw new Error('Input must be valid JSON');
    try {
      value = parseYAML(text, { onWarning() { throw new Error('Unsupported YAML'); } });
      JSON.stringify(value, (_key, item) => {
        if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Non-finite YAML number');
        return item;
      }); // Reject cyclic aliases and numbers that JSON would silently replace with null.
    } catch { throw new Error('Input must be valid JSON or single-document YAML with finite numbers and no cyclic aliases'); }
  }
  const result = object(value);
  if (!result) throw new Error(`Input must be a ${allowYaml ? 'JSON or YAML' : 'JSON'} object`);
  return result;
}

function applyImportPricing(spec: ProviderObject, rawDefault: string | undefined): void {
  const defaultPrice = rawDefault === undefined ? undefined : Number(rawDefault);
  if (rawDefault !== undefined && (!rawDefault.trim() || !Number.isFinite(defaultPrice) || defaultPrice! < 0)) {
    throw new Error('--default-price must be a finite non-negative USD amount (0 explicitly means free)');
  }
  for (const pathItem of Object.values(object(spec.paths) ?? {})) {
    const path = object(pathItem);
    if (!path) continue;
    for (const [method, value] of Object.entries(path)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method.toLowerCase())) continue;
      const operation = object(value);
      if (!operation) continue;
      const rawBilling = operation['x-xapi-billing'];
      const billing = object(rawBilling) ?? {};
      if (rawBilling != null && !object(rawBilling)) throw new Error('x-xapi-billing must be an object');
      const type = billing.type || 'PER_CALL';
      if (type === 'PER_CALL' && billing.costPerCall == null) {
        if (defaultPrice === undefined) {
          throw new Error('Import has unpriced PER_CALL operations. Set x-xapi-billing.costPerCall or choose --default-price <USD> (0 explicitly means free)');
        }
        operation['x-xapi-billing'] = { ...billing, costPerCall: defaultPrice };
      } else if (type === 'PER_RESOURCE' && billing.costPerResource == null) {
        throw new Error('Import has unpriced PER_RESOURCE operations. Set x-xapi-billing.costPerResource; --default-price applies only to PER_CALL');
      } else if (type === 'PER_TOKEN') {
        const pricing = object(billing.tokenPricing);
        const rates = pricing && ('inputPricePerToken' in pricing || 'outputPricePerToken' in pricing)
          ? [pricing] : Object.values(pricing ?? {}).map(object);
        if (!rates.length || rates.some(rate => !rate || (rate.inputPricePerToken == null && rate.outputPricePerToken == null))) {
          throw new Error('Import has unpriced PER_TOKEN operations. Set x-xapi-billing.tokenPricing; --default-price applies only to PER_CALL');
        }
      } else if (type === 'DYNAMIC' && !object(billing.dynamicRules)) {
        throw new Error('Import has DYNAMIC operations without x-xapi-billing.dynamicRules; --default-price applies only to PER_CALL');
      }
    }
  }
}

function segment(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error('Invalid service or revision ID');
  }
  return encodeURIComponent(normalized);
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
      const spec = await jsonFile(file, true);
      applyImportPricing(spec, flag(flags, 'default-price'));
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
      if (changelog !== undefined && changelog.length > 2000) {
        throw new Error('--changelog must be at most 2000 characters');
      }
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
        if (revision?.id !== revisionId || !['DRAFT', 'PREVIEW', 'SANDBOX', 'IN_REVIEW', 'PUBLISHED', 'SUSPENDED'].includes(String(state))) {
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
      await waitForPoll(delay, deadline);
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
        message += ': revision is not editable. Only DRAFT or PREVIEW can be updated; use a working revision for changes to a published API';
      }
      if (['import', 'update', 'submit'].includes(command)) message += '. No automatic retry was made; inspect provider list/get/review before retrying';
    } else message = e instanceof SyntaxError ? 'Invalid JSON response from provider API' : e instanceof Error ? e.message : 'Unknown error';
    err(`provider ${command} failed`, redactProvider(message, secrets));
  }
}
