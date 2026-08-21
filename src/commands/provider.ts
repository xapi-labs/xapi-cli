/** Provider service management through narrowly scoped XAPI-KEY routes. */

import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { apiKeyApiRequest } from '../client.ts';
import {
  getConfig,
  requireApiKey,
  XAPI_API_HOST,
} from '../config.ts';
import { err, output } from '../format.ts';

const READ_RETRIES = 2;
const BASE = '/api/api-services/agent';

export const PROVIDER_HELP = `xapi-to provider - Manage provider services and their content

USAGE
  xapi-to provider list
  xapi-to provider get <service-id> [--version <version>]
  xapi-to provider create --file <service.json>
  xapi-to provider update <service-id> [metadata flags]
  xapi-to provider versions <service-id>
  xapi-to provider version update <service-id> <version-id> --file <contract.json> [--replace]
  xapi-to provider major create <service-id>
  xapi-to provider revision start <service-id> <major>
  xapi-to provider publish <service-id> <revision-id> [--changelog <text>|--changelog-file <path>]
  xapi-to provider rollback <service-id> <major> --revision <revision-id> [--reason <text>|--reason-file <path>]
  xapi-to provider default-major <service-id> <major>
  xapi-to provider deprecate|restore <service-id> <major>
  xapi-to provider review <service-id> <revision-id>
  xapi-to provider diff <service-id> <major>
  xapi-to provider metrics [service-id] [--days 30]
  xapi-to provider events [--after <cursor>] [--limit 50]
  xapi-to provider skill context <service-id>
  xapi-to provider skill scaffold <service-id> --output <SKILL.md> [--force]
  xapi-to provider skill link <service-id> <skill-id>
  xapi-to provider skill unlink <service-id>
  xapi-to provider skill fingerprint <service-id> [--skill-version-id <id>]
  xapi-to provider delete <service-id> --confirm <service-name-or-id>

METADATA FLAGS
  --file <metadata.json>            Read metadata from JSON
  --name <name>                    Service display name
  --description <text>             Marketplace card description
  --description-file <path|->      Read description from a file or stdin
  --about <markdown>               Long About content
  --about-file <path|->            Read About Markdown from a file or stdin
  --clear-about                    Clear About content
  --website <url>                  Public service website
  --clear-website                  Clear website
  --logo-url <url>                 Service logo URL
  --category <category>            Marketplace category

SCOPES
  list/get/versions/review/diff/skill context: service:read
  create: service:create
  update/version update/skill link/fingerprint: service:update
  major/revision start: version:create
  publish: service:publish
  rollback/default-major/deprecate/restore: service:rollback
  metrics/events: observability:read
  delete: service:delete
`;

function servicePath(serviceId: string, suffix = ''): string {
  return `${BASE}/services/${encodeURIComponent(serviceId)}${suffix}`;
}

function required(value: string | undefined, usage: string): string {
  if (!value?.trim()) err(`usage: ${usage}`);
  return value!.trim();
}

function requiredFlag(value: string | undefined, usage: string): string {
  if (!value?.trim() || value === 'true') err(`usage: ${usage}`);
  return value!.trim();
}

function optionalFlag(value: string | undefined, flagName: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') err(`${flagName} requires a value`);
  return value;
}

function positiveInt(raw: string | undefined, name: string, max?: number): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    err(`invalid ${name}`, `Expected an integer from 1${max ? ` to ${max}` : ''}.`);
  }
  return value;
}

function boolFlag(flags: Record<string, string>, name: string): boolean {
  return ['true', '1', 'yes'].includes((flags[name] || '').toLowerCase());
}

async function readText(path: string, flagName: string): Promise<string> {
  if (path === 'true') err(`${flagName} requires a path or - for stdin`);
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(resolve(path), 'utf8');
}

async function textOption(
  flags: Record<string, string>,
  directName: string,
  fileName: string,
): Promise<string | undefined> {
  const direct = flags[directName];
  const file = flags[fileName];
  if (direct !== undefined && file !== undefined) {
    err(`--${directName} and --${fileName} are mutually exclusive`);
  }
  if (direct === 'true') err(`--${directName} requires a value`);
  if (file !== undefined) return readText(file, `--${fileName}`);
  return direct;
}

async function readJsonObject(path: string, flagName = '--file'): Promise<Record<string, unknown>> {
  if (!path || path === 'true') err(`${flagName} requires a JSON file path or - for stdin`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readText(path, flagName));
  } catch (error: any) {
    err(`invalid JSON from ${flagName}`, error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    err(`${flagName} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

async function metadataBody(flags: Record<string, string>): Promise<Record<string, unknown>> {
  const body = flags.file ? await readJsonObject(flags.file) : {};
  const description = await textOption(flags, 'description', 'description-file');
  const about = await textOption(flags, 'about', 'about-file');
  if (boolFlag(flags, 'clear-about') && about !== undefined) {
    err('--clear-about cannot be combined with --about or --about-file');
  }
  if (boolFlag(flags, 'clear-website') && flags.website !== undefined) {
    err('--clear-website cannot be combined with --website');
  }
  if (description !== undefined) body.description = description;
  if (about !== undefined) body.aboutMarkdown = about;
  for (const [flagName, fieldName] of [
    ['name', 'name'],
    ['website', 'website'],
    ['logo-url', 'logoUrl'],
    ['category', 'category'],
  ] as const) {
    if (flags[flagName] === 'true') err(`--${flagName} requires a value`);
    if (flags[flagName] !== undefined) body[fieldName] = flags[flagName];
  }
  if (boolFlag(flags, 'clear-about')) body.aboutMarkdown = null;
  if (boolFlag(flags, 'clear-website')) body.website = null;
  if (Object.keys(body).length === 0) {
    err('no provider metadata supplied', 'Pass --file or at least one metadata flag.');
  }
  return body;
}

async function writeExclusive(path: string, content: string, force: boolean) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const handle = await open(target, force ? 'w' : 'wx');
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
  return target;
}

export async function provider(args: string[], flags: Record<string, string>) {
  if (flags.help || args.length === 0) {
    console.log(PROVIDER_HELP);
    return;
  }
  const cfg = getConfig();
  requireApiKey(cfg);
  const apiKey = cfg.apiKey!;
  const [command, ...rest] = args;

  try {
    let result: unknown;
    switch (command) {
      case 'list':
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, `${BASE}/services`, { retries: READ_RETRIES });
        break;

      case 'get': {
        const id = required(rest[0], 'xapi-to provider get <service-id>');
        const path = new URL(`https://placeholder${servicePath(id)}`);
        const version = optionalFlag(flags.version, '--version');
        if (version !== undefined) path.searchParams.set('version', version);
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, `${path.pathname}${path.search}`, { retries: READ_RETRIES });
        break;
      }

      case 'create':
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, `${BASE}/services`, {
          method: 'POST',
          body: await readJsonObject(required(flags.file, 'xapi-to provider create --file <service.json>')),
        });
        break;

      case 'update': {
        const id = required(rest[0], 'xapi-to provider update <service-id> [metadata flags]');
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id), {
          method: 'PATCH',
          body: await metadataBody(flags),
        });
        break;
      }

      case 'versions': {
        const id = required(rest[0], 'xapi-to provider versions <service-id>');
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, '/version-overview'), { retries: READ_RETRIES });
        break;
      }

      case 'version': {
        if (rest[0] !== 'update') err('usage: xapi-to provider version update <service-id> <version-id> --file <contract.json> [--replace]');
        const id = required(rest[1], 'xapi-to provider version update <service-id> <version-id> --file <contract.json>');
        const versionId = required(rest[2], 'xapi-to provider version update <service-id> <version-id> --file <contract.json>');
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, `/versions/${encodeURIComponent(versionId)}`), {
          method: boolFlag(flags, 'replace') ? 'PUT' : 'PATCH',
          body: await readJsonObject(required(flags.file, 'xapi-to provider version update <service-id> <version-id> --file <contract.json>')),
        });
        break;
      }

      case 'major': {
        if (rest[0] !== 'create') err('usage: xapi-to provider major create <service-id>');
        const id = required(rest[1], 'xapi-to provider major create <service-id>');
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, '/majors'), { method: 'POST' });
        break;
      }

      case 'revision': {
        if (rest[0] !== 'start') err('usage: xapi-to provider revision start <service-id> <major>');
        const id = required(rest[1], 'xapi-to provider revision start <service-id> <major>');
        const major = positiveInt(required(rest[2], 'xapi-to provider revision start <service-id> <major>'), 'major')!;
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, `/majors/${major}/working-revision`), { method: 'POST' });
        break;
      }

      case 'publish': {
        const id = required(rest[0], 'xapi-to provider publish <service-id> <revision-id>');
        const revisionId = required(rest[1], 'xapi-to provider publish <service-id> <revision-id>');
        const changelog = await textOption(flags, 'changelog', 'changelog-file');
        if (changelog !== undefined && changelog.length > 2000) err('changelog is too long', 'Maximum length is 2000 characters.');
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, `/revisions/${encodeURIComponent(revisionId)}/submit`), {
          method: 'POST',
          body: changelog === undefined ? {} : { changelog },
        });
        break;
      }

      case 'rollback': {
        const id = required(rest[0], 'xapi-to provider rollback <service-id> <major> --revision <revision-id>');
        const major = positiveInt(required(rest[1], 'xapi-to provider rollback <service-id> <major> --revision <revision-id>'), 'major')!;
        const revisionId = requiredFlag(flags.revision, 'xapi-to provider rollback <service-id> <major> --revision <revision-id>');
        const reason = await textOption(flags, 'reason', 'reason-file');
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, `/majors/${major}/rollback`), {
          method: 'POST', body: { revisionId, ...(reason !== undefined ? { reason } : {}) },
        });
        break;
      }

      case 'default-major': {
        const id = required(rest[0], 'xapi-to provider default-major <service-id> <major>');
        const major = positiveInt(required(rest[1], 'xapi-to provider default-major <service-id> <major>'), 'major')!;
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, '/default-major'), { method: 'PUT', body: { major } });
        break;
      }

      case 'deprecate':
      case 'restore': {
        const id = required(rest[0], `xapi-to provider ${command} <service-id> <major>`);
        const major = positiveInt(required(rest[1], `xapi-to provider ${command} <service-id> <major>`), 'major')!;
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, `/majors/${major}/deprecated`), {
          method: 'PUT', body: { deprecated: command === 'deprecate' },
        });
        break;
      }

      case 'review': {
        const id = required(rest[0], 'xapi-to provider review <service-id> <revision-id>');
        const revisionId = required(rest[1], 'xapi-to provider review <service-id> <revision-id>');
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, `/revisions/${encodeURIComponent(revisionId)}/review`), { retries: READ_RETRIES });
        break;
      }

      case 'diff': {
        const id = required(rest[0], 'xapi-to provider diff <service-id> <major>');
        const major = positiveInt(required(rest[1], 'xapi-to provider diff <service-id> <major>'), 'major')!;
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, `/majors/${major}/diff-preview`), { retries: READ_RETRIES });
        break;
      }

      case 'metrics': {
        const days = positiveInt(flags.days, 'days', 365);
        const path = new URL(`https://placeholder${rest[0] ? servicePath(rest[0], '/metrics') : `${BASE}/metrics`}`);
        if (days) path.searchParams.set('days', String(days));
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, `${path.pathname}${path.search}`, { retries: READ_RETRIES });
        break;
      }

      case 'events': {
        const limit = positiveInt(flags.limit, 'limit', 100);
        const path = new URL('https://placeholder/api/agent/events');
        const after = optionalFlag(flags.after, '--after');
        if (after !== undefined) path.searchParams.set('after', after);
        if (limit) path.searchParams.set('limit', String(limit));
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, `${path.pathname}${path.search}`, { retries: READ_RETRIES });
        break;
      }

      case 'skill': {
        const subcommand = required(rest[0], 'xapi-to provider skill context|scaffold|link|unlink|fingerprint ...');
        const id = required(rest[1], `xapi-to provider skill ${subcommand} <service-id>`);
        if (subcommand === 'context' || subcommand === 'scaffold') {
          const destination = subcommand === 'scaffold'
            ? requiredFlag(flags.output, 'xapi-to provider skill scaffold <service-id> --output <SKILL.md>')
            : undefined;
          const context = await apiKeyApiRequest<any>(XAPI_API_HOST, apiKey, servicePath(id, '/skill-context'), { retries: READ_RETRIES });
          if (subcommand === 'scaffold') {
            if (!context || typeof context.scaffoldMarkdown !== 'string') throw new Error('skill context response is missing scaffoldMarkdown');
            const savedTo = await writeExclusive(destination!, context.scaffoldMarkdown, boolFlag(flags, 'force'));
            result = { serviceId: id, savedTo, currentFingerprint: context.currentFingerprint };
          } else {
            result = context;
          }
        } else if (subcommand === 'link') {
          const skillId = required(rest[2], 'xapi-to provider skill link <service-id> <skill-id>');
          result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id), { method: 'PATCH', body: { linkedSkillId: skillId } });
        } else if (subcommand === 'unlink') {
          result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id), { method: 'PATCH', body: { linkedSkillId: null } });
        } else if (subcommand === 'fingerprint') {
          const skillVersionId = optionalFlag(flags['skill-version-id'], '--skill-version-id');
          result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id, '/skill-fingerprint'), {
            method: 'PUT',
            body: skillVersionId !== undefined
              ? { skillVersionId }
              : {},
          });
        } else {
          err(`unknown provider skill command: ${subcommand}`, 'Valid commands: context, scaffold, link, unlink, fingerprint.');
        }
        break;
      }

      case 'delete': {
        const id = required(rest[0], 'xapi-to provider delete <service-id> --confirm <service-name-or-id>');
        const confirm = requiredFlag(flags.confirm, 'xapi-to provider delete <service-id> --confirm <service-name-or-id>');
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, servicePath(id), { method: 'DELETE', body: { confirm } });
        break;
      }

      default:
        err(`unknown provider command: ${command}`, 'Run "xapi-to provider --help".');
    }

    output(result, flags.format as any);
  } catch (error: any) {
    err('provider request failed', error.message);
  }
}
