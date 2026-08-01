/**
 * Task commands for async task polling.
 * Built on top of the generic action execution endpoint.
 */

import { getConfig, requireApiKey } from '../config.ts';
import * as client from '../client.ts';
import { output, err } from '../format.ts';

const POLL_HELP = `xapi-to task poll - Poll an async task once

USAGE
  xapi-to task poll <task_id> [flags]

FLAGS
  --format json|pretty|table  Output format

EXAMPLES
  xapi-to task poll 550e8400-e29b-41d4-a716-446655440000
`;

const WAIT_HELP = `xapi-to task wait - Wait until async task reaches terminal status

USAGE
  xapi-to task wait <task_id> [flags]

FLAGS
  --interval <duration>       Poll interval (default: 2s). Supports ms/s/m/h
  --timeout <duration>        Max wait duration (optional). Supports ms/s/m/h
  --max-attempts <number>     Max poll attempts (optional)
  --format json|pretty|table  Output format

EXAMPLES
  xapi-to task wait 550e8400-e29b-41d4-a716-446655440000
  xapi-to task wait 550e8400-e29b-41d4-a716-446655440000 --interval 1s --timeout 10m
`;

const TASK_HELP = `xapi-to task - Async task helpers

USAGE
  xapi-to task <command> [args] [flags]

COMMANDS
  poll <task_id>              Poll task status once (wraps action: task.poll)
  wait <task_id>              Poll repeatedly until terminal status

EXAMPLES
  xapi-to task poll 550e8400-e29b-41d4-a716-446655440000
  xapi-to task wait 550e8400-e29b-41d4-a716-446655440000 --interval 2s --timeout 10m
`;

type TaskStatus = 'pending' | 'processing' | 'succeeded' | 'failed' | 'expired';

function showHelpIfRequested(flags: Record<string, string>, helpText: string): void {
  if (flags.help) {
    console.log(helpText);
    process.exit(0);
  }
}

function parseDurationMs(raw: string): number {
  const text = raw.trim().toLowerCase();
  const match = text.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) {
    err(`invalid duration "${raw}". Use formats like 500ms, 2s, 5m, 1h.`);
  }
  const value = Number(match[1]);
  const unit = match[2] || 'ms';
  if (!Number.isFinite(value) || value < 0) {
    err(`invalid duration "${raw}". Duration must be >= 0.`);
  }
  switch (unit) {
    case 'ms': return value;
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    default: return value;
  }
}

function parsePositiveDurationMs(raw: string, flagName: string): number {
  const ms = parseDurationMs(raw);
  if (ms <= 0) {
    err(`${flagName} must be greater than 0`);
  }
  return ms;
}

function parsePositiveInt(raw: string, flagName: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    err(`${flagName} must be a positive integer`);
  }
  return n;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractTaskPayload(res: unknown): Record<string, unknown> {
  if (res && typeof res === 'object') {
    const obj = res as Record<string, unknown>;
    if (typeof obj.status === 'string') return obj;
    if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
      const dataObj = obj.data as Record<string, unknown>;
      if (typeof dataObj.status === 'string') return dataObj;
    }
  }
  return (res ?? {}) as Record<string, unknown>;
}

function getStatus(payload: Record<string, unknown>): TaskStatus | undefined {
  const status = payload.status;
  if (
    status === 'pending'
    || status === 'processing'
    || status === 'succeeded'
    || status === 'failed'
    || status === 'expired'
  ) {
    return status;
  }
  return undefined;
}

export async function taskPoll(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, POLL_HELP);
  const taskId = args[0];
  if (!taskId) err('usage: xapi-to task poll <task_id>');

  const cfg = getConfig();
  requireApiKey(cfg);

  try {
    // task.poll is a read (idempotent) → safe to retry transient failures.
    const res = await client.actionCall('task.poll', { task_id: taskId }, cfg, undefined, 2);
    const payload = extractTaskPayload(res);
    output(payload, flags.format as any);
  } catch (e: any) {
    err('task poll failed', e.message);
  }
}

export async function taskWait(args: string[], flags: Record<string, string>) {
  showHelpIfRequested(flags, WAIT_HELP);
  const taskId = args[0];
  if (!taskId) err('usage: xapi-to task wait <task_id>');

  const intervalMs = parsePositiveDurationMs(flags.interval || '2s', '--interval');
  const timeoutMs = flags.timeout ? parseDurationMs(flags.timeout) : undefined;
  const maxAttempts = flags['max-attempts']
    ? parsePositiveInt(flags['max-attempts'], '--max-attempts')
    : undefined;

  const cfg = getConfig();
  requireApiKey(cfg);

  const startedAt = Date.now();
  const deadline = timeoutMs !== undefined ? startedAt + timeoutMs : undefined;
  let attempts = 0;

  while (true) {
    // Enforce the deadline as a real upper bound: check before every request so
    // --timeout can't be overshot by (nearly) a full poll interval.
    if (deadline !== undefined && Date.now() >= deadline) {
      err(
        'task wait timeout',
        `task_id=${taskId}, elapsed_ms=${Date.now() - startedAt}, timeout_ms=${timeoutMs}`,
      );
    }

    attempts += 1;
    let retryDelayMs: number | undefined;
    try {
      // Keep retries in this outer loop so each real request counts toward
      // --max-attempts and all retry sleeps can be bounded by --timeout.
      const remaining = deadline !== undefined ? Math.max(1, deadline - Date.now()) : undefined;
      const res = await client.actionCall('task.poll', { task_id: taskId }, cfg, undefined, 0, remaining);
      const payload = extractTaskPayload(res);
      const status = getStatus(payload);

      if (!status) {
        err('task wait failed', 'task.poll returned invalid response: missing status');
      }

      if (status === 'succeeded') {
        output(payload, flags.format as any);
        return;
      }

      if (status === 'failed' || status === 'expired') {
        output(payload, flags.format as any);
        process.exit(1);
      }
    } catch (e: any) {
      if (e instanceof Error && e.message === 'process.exit') {
        throw e;
      }
      // If the poll was aborted because we hit the deadline, report it as a timeout.
      if (deadline !== undefined && Date.now() >= deadline) {
        err(
          'task wait timeout',
          `task_id=${taskId}, elapsed_ms=${Date.now() - startedAt}, timeout_ms=${timeoutMs}`,
        );
      }
      if (client.isRetryableRequestError(e)) {
        // Honor Retry-After when supplied; otherwise the normal poll interval is
        // also the transient-error backoff. The sleep below enforces the deadline.
        retryDelayMs = e instanceof client.HttpError ? e.retryAfterMs : undefined;
      } else {
        err('task wait failed', e.message);
      }
    }

    if (maxAttempts && attempts >= maxAttempts) {
      err(
        'task wait exceeded max attempts',
        `task_id=${taskId}, attempts=${attempts}, max_attempts=${maxAttempts}`,
      );
    }

    // Sleep no longer than the time remaining before the deadline.
    const desiredWaitMs = retryDelayMs ?? intervalMs;
    const waitMs = deadline !== undefined
      ? Math.min(desiredWaitMs, Math.max(0, deadline - Date.now()))
      : desiredWaitMs;
    await sleep(waitMs);
  }
}

export function taskHelp(): string {
  return TASK_HELP;
}
