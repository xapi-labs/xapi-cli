import { HttpError } from './client.ts';

export interface WorkerOperationWaitEvent {
  operationId: string;
  state: string;
  phase: 'waiting' | 'ready';
}
export interface WorkerOperationWaitOptions {
  /** Client patience, not a server operation deadline or user quota. Zero disables waiting. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onWait?: (event: WorkerOperationWaitEvent) => void;
}
interface WaitRuntime {
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}
const runtime: WaitRuntime = {
  now: Date.now,
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason || new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  }),
};

/** Only the server's initial, unaccepted claim is safe to submit again. */
export function unsentWorkerTargetConflict(error: unknown): { operationId: string; state: string } | undefined {
  if (!(error instanceof HttpError) || error.status !== 409) return;
  const body = error.responseBody as Record<string, unknown> | undefined;
  if (!body || body.code !== 'worker_control_operation_pending' ||
      body.pendingReason !== 'TARGET_BUSY' || body.requestAccepted !== false ||
      body.requestDispatched !== false || typeof body.operationId !== 'string' || !body.operationId)
    return;
  return { operationId: body.operationId, state: String(body.state || 'UNKNOWN') };
}

/** No recovery writes, generic retries, queue adoption, or deadline-based unlocks. */
export async function withWorkerTargetWait<T>(
  send: () => Promise<T>,
  observe: (operationId: string, timeoutMs: number) => Promise<unknown>,
  options: WorkerOperationWaitOptions = {},
  clock: WaitRuntime = runtime,
): Promise<T> {
  const budget = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('Invalid Worker operation wait timeout');
  let started: number | undefined;
  let lastEvent = '';
  const emit = (operationId: string, state: string, phase: 'waiting' | 'ready') => {
    const key = operationId + ':' + state + ':' + phase;
    if (key !== lastEvent) options.onWait?.({ operationId, state, phase });
    lastEvent = key;
  };
  const checkAbort = () => {
    if (options.signal?.aborted)
      throw options.signal.reason || new DOMException('Aborted', 'AbortError');
  };
  const remaining = () => Math.max(0, budget - (clock.now() - started!));
  const timedOut = (id: string): never => {
    throw new Error(`Worker target is still busy (operation ${id}); client wait ended. This request was not accepted or queued. Inspect the operation before trying again.`);
  };
  while (true) {
    checkAbort();
    try { return await send(); } catch (error) {
      const conflict = unsentWorkerTargetConflict(error);
      if (!conflict || budget === 0) throw error;
      started ??= clock.now();
      if (!remaining()) timedOut(conflict.operationId);
      emit(conflict.operationId, conflict.state, 'waiting');
      let interval = 1_000;
      while (true) {
        checkAbort();
        if (!remaining()) timedOut(conflict.operationId);
        await clock.sleep(Math.min(interval, remaining()), options.signal);
        if (!remaining()) timedOut(conflict.operationId);
        const result = await observe(conflict.operationId, Math.min(5_000, remaining())) as Record<string, unknown>;
        if (!result || result.operationId !== conflict.operationId ||
            typeof result.retryReady !== 'boolean' || typeof result.resultUnconfirmed !== 'boolean' ||
            typeof result.occupiesTarget !== 'boolean' || typeof result.state !== 'string')
          throw new Error('Worker operation status could not be verified; no write was resubmitted');
        if (result.resultUnconfirmed || result.state === 'UNKNOWN')
          throw new Error(`Worker operation ${conflict.operationId} has an unconfirmed provider result; no write was resubmitted. Inspect or reconcile that operation first.`);
        if (result.retryReady && !result.occupiesTarget) {
          if (!remaining()) timedOut(conflict.operationId);
          emit(conflict.operationId, result.state, 'ready');
          break;
        }
        emit(conflict.operationId, result.state, 'waiting');
        interval = Math.min(5_000, interval * 2);
      }
    }
  }
}
