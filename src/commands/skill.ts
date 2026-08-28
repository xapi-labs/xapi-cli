/** Skill package submission and review status through scoped XAPI-KEY routes. */

import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import {
  apiKeyApiRequest,
  HttpError,
  isRetryableRequestError,
} from '../client.ts';
import { getConfig, requireApiKey, XAPI_API_HOST } from '../config.ts';
import { err, output } from '../format.ts';

const READ_RETRIES = 2;
const MAX_FILES = 100;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const BASE = '/api/skills/agent';
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules']);

type InlineFile = { path: string; contentBase64: string };

export const SKILL_HELP = `xapi-to skill - Upload and publish service usage skills

USAGE
  xapi-to skill spec
  xapi-to skill submit --dir <skill-directory>
  xapi-to skill submit --github <public-github-url> [metadata flags]
  xapi-to skill status <submission-id>
  xapi-to skill wait <submission-id> [--interval 2s] [--timeout 10m]

GITHUB METADATA FLAGS
  --version <semver>
  --name <display-name>
  --description <text>
  --category <value>                Repeat is not supported; use comma-separated values
  --tag <value>                     Repeat is not supported; use comma-separated values

Local submissions recursively upload regular files. Symlinks, .git, and
node_modules are excluded. The package must contain SKILL.md, have at most
100 files, keep each file at or below 512 KiB, and keep the encoded package
at or below 2 MiB.

SCOPES
  spec/status/wait: skill:read
  submit: skill:submit
`;

function required(value: string | undefined, usage: string): string {
  if (!value?.trim() || value === 'true') err(`usage: ${usage}`);
  return value!.trim();
}

function parseDuration(raw: string, flagName: string): number {
  const match = raw.trim().toLowerCase().match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) err(`${flagName} must be a duration such as 500ms, 2s, 5m, or 1h`);
  const value = Number(match![1]);
  const multiplier = match![2] === 'h' ? 3_600_000 : match![2] === 'm' ? 60_000 : match![2] === 's' ? 1_000 : 1;
  const result = value * multiplier;
  if (!Number.isSafeInteger(result) || result <= 0) err(`${flagName} must be greater than 0`);
  return result;
}

function listFlag(value: string | undefined): string[] | undefined {
  if (!value || value === 'true') return undefined;
  const items = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  return items.length ? items : undefined;
}

async function collectInlineFiles(directory: string): Promise<InlineFile[]> {
  const root = resolve(directory);
  const files: InlineFile[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_FILES) {
        throw new Error(`skill package exceeds ${MAX_FILES} files`);
      }
      const content = await readFile(absolute);
      if (content.byteLength > MAX_FILE_BYTES) {
        throw new Error(`skill file ${entry.name} exceeds ${MAX_FILE_BYTES} bytes`);
      }
      const path = relative(root, absolute).split(sep).join('/');
      if (!path || path.startsWith('../')) throw new Error('skill file escaped the selected directory');
      files.push({ path, contentBase64: content.toString('base64') });
    }
  }

  await walk(root);
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new Error('skill package root must contain SKILL.md');
  }
  const encodedBytes = Buffer.byteLength(JSON.stringify({ sourceType: 'inline', files }), 'utf8');
  if (encodedBytes > MAX_PACKAGE_BYTES) {
    throw new Error(`encoded skill package exceeds ${MAX_PACKAGE_BYTES} bytes`);
  }
  return files;
}

function statusOf(value: any): string | undefined {
  return value?.status || value?.submission?.status || value?.skill?.status;
}

function sleep(ms: number) {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function getSubmission(apiKey: string, id: string, timeoutMs = 30_000, retries = READ_RETRIES) {
  return apiKeyApiRequest<any>(
    XAPI_API_HOST,
    apiKey,
    `${BASE}/submissions/${encodeURIComponent(id)}`,
    { timeoutMs, retries },
  );
}

async function waitForSubmission(apiKey: string, id: string, flags: Record<string, string>) {
  const intervalMs = parseDuration(flags.interval || '2s', '--interval');
  const timeoutMs = parseDuration(flags.timeout || '10m', '--timeout');
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      err('skill wait timeout', `submission_id=${id}, elapsed_ms=${Date.now() - startedAt}, timeout_ms=${timeoutMs}`);
    }
    try {
      const result = await getSubmission(apiKey, id, remaining, 0);
      const status = statusOf(result);
      if (status === 'PUBLISHED') return result;
      if (['NEEDS_CHANGES', 'REJECTED', 'SUSPENDED', 'ARCHIVED'].includes(String(status))) {
        output(result, flags.format as any);
        process.exit(1);
      }
    } catch (error) {
      const pending = error instanceof HttpError && error.status === 404;
      if (!pending && !isRetryableRequestError(error)) throw error;
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
}

export async function skill(args: string[], flags: Record<string, string>) {
  if (flags.help || args.length === 0) {
    console.log(SKILL_HELP);
    return;
  }
  const cfg = getConfig();
  requireApiKey(cfg);
  const apiKey = cfg.apiKey!;
  const [command, ...rest] = args;

  try {
    let result: unknown;
    if (command === 'spec') {
      result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, `${BASE}/spec`, { retries: READ_RETRIES });
    } else if (command === 'submit') {
      const directory = flags.dir;
      const github = flags.github;
      if ((directory && github) || (!directory && !github)) {
        err('choose exactly one skill source', 'Pass either --dir <path> or --github <public-url>.');
      }
      if (directory) {
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, `${BASE}/submissions`, {
          method: 'POST',
          body: { files: await collectInlineFiles(required(directory, 'xapi-to skill submit --dir <skill-directory>')) },
        });
      } else {
        const body: Record<string, unknown> = {
          url: required(github, 'xapi-to skill submit --github <public-github-url>'),
        };
        for (const name of ['version', 'name', 'description'] as const) {
          if (flags[name] && flags[name] !== 'true') body[name] = flags[name];
        }
        const categories = listFlag(flags.category);
        const tags = listFlag(flags.tag);
        if (categories) body.categories = categories;
        if (tags) body.tags = tags;
        result = await apiKeyApiRequest(XAPI_API_HOST, apiKey, `${BASE}/submissions/github`, { method: 'POST', body });
      }
    } else if (command === 'status') {
      result = await getSubmission(apiKey, required(rest[0], 'xapi-to skill status <submission-id>'));
    } else if (command === 'wait') {
      result = await waitForSubmission(apiKey, required(rest[0], 'xapi-to skill wait <submission-id>'), flags);
    } else {
      err(`unknown skill command: ${command}`, 'Valid commands: spec, submit, status, wait.');
    }
    output(result, flags.format as any);
  } catch (error: any) {
    if (error instanceof Error && error.message === 'process.exit') throw error;
    err('skill request failed', error.message);
  }
}
