/** OpenAI Sandbox Agents SDK client backed by the xAPI Sandbox Gateway. */

import { randomUUID } from 'node:crypto';
import {
  Manifest,
  normalizeSandboxClientCreateArgs,
  type ExecCommandArgs,
  type SandboxClient as AgentsSandboxClient,
  type SandboxClientCreateArgs,
  type SandboxExecResult,
  type SandboxSession,
  type SandboxSessionState,
} from '@openai/agents/sandbox';
import { HttpError } from './client.ts';
import {
  sandboxAudit,
  sandboxCreate,
  sandboxExec,
  sandboxGet,
  sandboxQuote,
  sandboxStateAction,
  sandboxWait,
  type SandboxClientOptions,
} from './sandbox-client.ts';

export type XapiAgentsSandboxOptions = {
  apiKey: string;
  sandboxHost?: string;
  provider?: string;
  maxHourlyUsd?: number;
  model?: string;
  workspaceRoot?: string;
};

export type XapiAgentsSandboxState = SandboxSessionState & {
  instanceId: string;
  provider: string;
};

export type XapiAgentsSandboxEvidence = {
  instanceId?: string;
  provider?: string;
  execCount: number;
  shellMarkerSeen: boolean;
  finalState?: string;
  totalCost?: string | number;
  auditCounts?: Record<string, number>;
  auditStatuses?: Record<string, string[]>;
  auditVerified?: boolean;
};

type RunOptions = { provider?: string; maxHourlyUsd?: number };

function countItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const item = value as { items?: unknown[]; data?: unknown[] } | null;
  return item?.items?.length ?? item?.data?.length ?? 0;
}

function items(value: unknown): Array<Record<string, any>> {
  if (Array.isArray(value)) return value as Array<Record<string, any>>;
  const page = value as { items?: Array<Record<string, any>>; data?: Array<Record<string, any>> } | null;
  return page?.items ?? page?.data ?? [];
}

function positivePrice(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function shellQuote(value: string): string {
  if (!value || value.length > 4_096 || value.includes('\0')) {
    throw new Error('workspaceRoot must be a non-empty path no longer than 4096 characters');
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultWorkspaceRoot(provider: string): string {
  if (provider === 'daytona') return '/home/daytona/openai-xapi';
  return '/tmp/openai-xapi';
}

class XapiAgentsSandboxSession implements SandboxSession<XapiAgentsSandboxState> {
  readonly state: XapiAgentsSandboxState;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(
    state: XapiAgentsSandboxState,
    private readonly options: SandboxClientOptions,
    private readonly owner: XapiAgentsSandboxClient,
  ) {
    this.state = state;
  }

  async running() {
    const detail = await sandboxGet(this.options, this.state.instanceId);
    return detail.observedState === 'RUNNING';
  }

  async exec(args: ExecCommandArgs): Promise<SandboxExecResult> {
    const before = Date.now();
    const result = await sandboxExec(this.options, this.state.instanceId, {
      command: args.cmd,
      ...(args.workdir ? { cwd: args.workdir } : {}),
      timeoutSeconds: 120,
    });
    const stdout = String(result.stdout || '');
    const stderr = String(result.stderr || '');
    this.owner.evidence.execCount += 1;
    if (/(?:OPENAI_XAPI_SANDBOX_OK|SDK_OK)=42/.test(`${stdout}\n${stderr}`)) {
      this.owner.evidence.shellMarkerSeen = true;
    }
    return {
      output: [stdout, stderr].filter(Boolean).join('\n'),
      stdout,
      stderr,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      wallTimeSeconds: (Date.now() - before) / 1_000,
    };
  }

  async execCommand(args: ExecCommandArgs) {
    return (await this.exec(args)).output;
  }

  async stop() { await this.close(); }
  async shutdown() { await this.close(); }
  async delete() { await this.close(); }

  async close() {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.owner.terminate(this.state);
    try {
      await this.closePromise;
      this.closed = true;
    } finally {
      this.closePromise = undefined;
    }
  }
}

/**
 * Minimal provider adapter for Shell-based SandboxAgent examples.
 *
 * It intentionally rejects materialized Manifest entries and environment
 * values. A production adapter should add file/mount/snapshot translations
 * instead of pretending those optional surfaces work.
 */
export class XapiAgentsSandboxClient implements AgentsSandboxClient<RunOptions, XapiAgentsSandboxState> {
  readonly backendId = 'xapi-sandbox';
  readonly supportsDefaultOptions = true;
  readonly evidence: XapiAgentsSandboxEvidence = { execCount: 0, shellMarkerSeen: false };
  readonly workspaceRoot: string;
  lastSession?: XapiAgentsSandboxSession;

  private readonly apiKey: string;
  private readonly sandboxHost: string;
  private readonly provider: string;
  private readonly maxHourlyUsd: number;
  private readonly model: string;
  private readonly terminationKeys = new Map<string, string>();

  constructor(options: XapiAgentsSandboxOptions) {
    if (!options.apiKey) throw new Error('XapiAgentsSandboxClient requires apiKey');
    this.apiKey = options.apiKey;
    this.sandboxHost = options.sandboxHost || 'sandbox.xapi.to';
    this.provider = options.provider || 'daytona';
    this.maxHourlyUsd = positivePrice(options.maxHourlyUsd ?? 0.20, 'maxHourlyUsd');
    this.model = options.model || 'deepseek-v4-pro';
    this.workspaceRoot = options.workspaceRoot || defaultWorkspaceRoot(this.provider);
    shellQuote(this.workspaceRoot);
  }

  async create(
    args: SandboxClientCreateArgs<RunOptions> | Manifest = {},
    legacyOptions?: RunOptions,
  ): Promise<XapiAgentsSandboxSession> {
    const normalized = normalizeSandboxClientCreateArgs(args, legacyOptions);
    const provider = normalized.options?.provider || this.provider;
    const maxHourlyUsd = positivePrice(
      normalized.options?.maxHourlyUsd ?? this.maxHourlyUsd,
      'maxHourlyUsd',
    );
    const manifest = normalized.manifest;
    if (Object.keys(manifest.validatedEntries()).length !== 0) {
      throw new Error('XapiAgentsSandboxClient example currently supports an empty Manifest only');
    }
    if (Object.keys(manifest.environment).length !== 0) {
      throw new Error('XapiAgentsSandboxClient keeps credentials/environment out of the Manifest');
    }

    const options: SandboxClientOptions = {
      sandboxHost: this.sandboxHost,
      apiKey: this.apiKey,
      provider,
    };
    const quote = await sandboxQuote(options, {
      requirements: { capabilities: ['exec', 'files'] },
      maxEstimatedHourlyUsd: maxHourlyUsd.toFixed(8),
    });
    if (!quote?.quoteId) throw new Error('xAPI Sandbox quote did not return quoteId');
    const created = await sandboxCreate(options, {
      selection: { quoteId: quote.quoteId },
      metadata: { client: 'openai-agents-sdk', modelGateway: 'ai.xapi.to', model: this.model },
      idempotencyKey: `openai-agents-sdk:${randomUUID()}`,
    });
    if (!created.id) throw new Error('xAPI Sandbox create did not return instance id');

    const state: XapiAgentsSandboxState = {
      manifest,
      workspaceReady: false,
      instanceId: created.id,
      provider,
    };
    const session = new XapiAgentsSandboxSession(state, options, this);
    this.lastSession = session;
    this.evidence.instanceId = created.id;
    this.evidence.provider = provider;
    try {
      await sandboxWait(options, created.id, ['RUNNING'], 360_000, 2_000);
      const prepared = await session.exec({ cmd: `mkdir -p -- ${shellQuote(manifest.root)}` });
      if (prepared.exitCode !== 0) throw new Error(`could not prepare ${manifest.root}`);
      state.workspaceReady = true;
      return session;
    } catch (error) {
      await this.terminate(state).catch(() => undefined);
      throw error;
    }
  }

  async delete(state: XapiAgentsSandboxState) {
    await this.terminate(state);
  }

  async terminate(state: XapiAgentsSandboxState) {
    const options: SandboxClientOptions = {
      sandboxHost: this.sandboxHost,
      apiKey: this.apiKey,
      provider: state.provider,
    };
    const aggregateOptions = { ...options, provider: undefined };
    const readDetail = async () => {
      try {
        return await sandboxGet(options, state.instanceId);
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404 || !options.provider) throw error;
        return sandboxGet(aggregateOptions, state.instanceId);
      }
    };
    const deadline = Date.now() + 360_000;
    const intervalMs = 2_000;
    const terminationKey = this.terminationKeys.get(state.instanceId)
      || `openai-agents-sdk:terminate:${randomUUID()}`;
    this.terminationKeys.set(state.instanceId, terminationKey);
    let detail = await readDetail();
    while (!['TERMINATED', 'FAILED'].includes(String(detail.observedState)) && Date.now() < deadline) {
      try {
        await sandboxStateAction(options, state.instanceId, 'terminate', {
          idempotencyKey: terminationKey,
        });
        break;
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 409) throw error;
        await sleep(intervalMs);
        detail = await readDetail();
      }
    }
    if (!['TERMINATED', 'FAILED'].includes(String(detail.observedState))) {
      try {
        detail = await sandboxWait(
          options,
          state.instanceId,
          ['TERMINATED', 'FAILED'],
          Math.max(1, deadline - Date.now()),
          intervalMs,
        );
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404 || !options.provider) throw error;
        detail = await sandboxWait(
          aggregateOptions,
          state.instanceId,
          ['TERMINATED', 'FAILED'],
          Math.max(1, deadline - Date.now()),
          intervalMs,
        );
      }
    }

    const auditDeadline = Date.now() + 60_000;
    let audit: Record<string, unknown> = {};
    let auditError = 'audit has not settled';
    while (Date.now() < auditDeadline) {
      detail = await sandboxGet(aggregateOptions, state.instanceId);
      audit = {};
      for (const kind of ['operations', 'events', 'usageSegments', 'billingPeriods']) {
        audit[kind] = await sandboxAudit(aggregateOptions, state.instanceId, kind);
      }
      const operations = items(audit.operations);
      const events = items(audit.events);
      const usageSegments = items(audit.usageSegments);
      const billingPeriods = items(audit.billingPeriods);
      const operationStatuses = operations.map((item) => String(item.status || 'UNKNOWN'));
      const operationSettled = operations.length > 0
        && operationStatuses.every((status) => ['SUCCEEDED', 'FAILED'].includes(status));
      const eventSettled = events.some((item) => ['TERMINATED', 'FAILED'].includes(String(item.currentState)));
      const usageSettled = usageSegments.length > 0
        && usageSegments.every((item) => item.status === 'SETTLED' && item.endsAt);
      const billingSettled = billingPeriods.length > 0
        && billingPeriods.every((item) => item.status === 'SETTLED' && item.endedAt);
      const billed = billingPeriods.reduce((sum, item) => sum + Number(item.amount || 0), 0);
      const totalCost = Number(detail.totalCost);
      const costMatches = Number.isFinite(totalCost) && Number.isFinite(billed)
        && Math.abs(totalCost - billed) <= 1e-9;
      if (operationSettled && eventSettled && usageSettled && billingSettled && costMatches) {
        auditError = '';
        break;
      }
      auditError = [
        !operationSettled && 'operations are not terminal',
        !eventSettled && 'terminal event is missing',
        !usageSettled && 'usage is not settled',
        !billingSettled && 'billing is not settled',
        !costMatches && `billing sum ${billed} does not match totalCost ${detail.totalCost}`,
      ].filter(Boolean).join('; ');
      await sleep(1_000);
    }
    if (auditError) throw new Error(`xAPI Sandbox audit verification failed: ${auditError}`);

    const auditCounts: Record<string, number> = {};
    const auditStatuses: Record<string, string[]> = {};
    for (const kind of ['operations', 'events', 'usageSegments', 'billingPeriods']) {
      auditCounts[kind] = countItems(audit[kind]);
      auditStatuses[kind] = items(audit[kind]).map((item) => String(
        item.status || item.currentState || 'UNKNOWN',
      ));
    }
    this.evidence.finalState = detail.observedState;
    this.evidence.totalCost = detail.totalCost;
    this.evidence.auditCounts = auditCounts;
    this.evidence.auditStatuses = auditStatuses;
    this.evidence.auditVerified = true;
  }
}
