import { describe, expect, test } from 'bun:test';
import { HttpError, RequestTimeoutError } from '../client.ts';
import { withWorkerTargetWait, unsentWorkerTargetConflict } from '../workers-operation-wait.ts';

const body = { code: 'worker_control_operation_pending', operationId: 'prior',
  state: 'WRITING', pendingReason: 'TARGET_BUSY', requestAccepted: false, requestDispatched: false };
const busy = (extra = {}) => new HttpError(409, 'target busy', undefined, { ...body, ...extra });
const status = (extra = {}) => ({ operationId: 'prior', state: 'WRITING',
  occupiesTarget: true, resultUnconfirmed: false, retryReady: false, ...extra });
const ready = () => status({ state: 'FINALIZED', occupiesTarget: false, retryReady: true });
function clock() {
  let now = 0;
  const delays: number[] = [];
  return { now: () => now, delays, sleep: async (ms: number) => { delays.push(ms); now += ms; } };
}

describe('Worker target wait', () => {
  test('successful writes need no status reads or delay', async () => {
    let reads = 0;
    expect(await withWorkerTargetWait(async () => 'ok', async () => { reads++; return ready(); })).toBe('ok');
    expect(reads).toBe(0);
  });
  test('waits read-only then submits unchanged intent once when the target is released', async () => {
    const time = clock(), events: any[] = [];
    let sends = 0, reads = 0;
    expect(await withWorkerTargetWait(async () => {
      if (++sends === 1) throw busy();
      return 'v3';
    }, async () => ++reads === 1 ? status() : ready(), { onWait: e => events.push(e) }, time)).toBe('v3');
    expect(sends).toBe(2); expect(reads).toBe(2); expect(time.delays).toEqual([1000, 2000]);
    expect(events.map(e => e.phase)).toEqual(['waiting', 'ready']);
  });
  for (const error of [
    new HttpError(409, 'legacy pending', undefined, { code: body.code, operationId: 'prior' }),
    busy({ requestDispatched: true }), busy({ requestAccepted: true }), busy({ pendingReason: 'RECOVERY' }),
    new HttpError(503, 'unavailable', undefined, body),
    new RequestTimeoutError(60_000), new TypeError('fetch failed'),
  ]) test('does not retry ambiguous or ordinary failure: ' + error.message, async () => {
    let sends = 0, reads = 0;
    await expect(withWorkerTargetWait(async () => { sends++; throw error; },
      async () => { reads++; return ready(); }, {}, clock())).rejects.toBe(error);
    expect(sends).toBe(1); expect(reads).toBe(0);
  });
  test('unknown blocker result stops without re-submission', async () => {
    let sends = 0;
    await expect(withWorkerTargetWait(async () => { sends++; throw busy(); },
      async () => status({ state: 'UNKNOWN', resultUnconfirmed: true }), {}, clock()))
      .rejects.toThrow('unconfirmed provider result');
    expect(sends).toBe(1);
  });
  test('expiry with in-flight results is not permission to retry', async () => {
    let sends = 0;
    await expect(withWorkerTargetWait(async () => { sends++; throw busy(); },
      async () => status({ occupiesTarget: false, resultUnconfirmed: true }), {}, clock()))
      .rejects.toThrow('unconfirmed provider result');
    expect(sends).toBe(1);
  });
  test('bounded patience exits with no queued request and no second write', async () => {
    const time = clock();
    let sends = 0, reads = 0;
    await expect(withWorkerTargetWait(async () => { sends++; throw busy(); },
      async () => { reads++; return status(); }, { timeoutMs: 10_000 }, time))
      .rejects.toThrow('not accepted or queued');
    expect(sends).toBe(1); expect(time.delays.reduce((a,b) => a+b,0)).toBe(10_000);
    expect(reads).toBe(3);
  });
  test('query failure or wrong identity never triggers a write', async () => {
    for (const observe of [
      async () => { throw new HttpError(403, 'read denied'); },
      async () => ({ ...ready(), operationId: 'other' }),
      async () => ({ operationId: 'prior', retryReady: true }),
    ]) {
      let sends = 0;
      await expect(withWorkerTargetWait(async () => { sends++; throw busy(); }, observe, {}, clock())).rejects.toThrow();
      expect(sends).toBe(1);
    }
  });
  test('another client winning the race re-enters the same bounded wait', async () => {
    let sends = 0, reads = 0;
    const time = clock();
    expect(await withWorkerTargetWait(async () => {
      if (++sends < 3) throw busy({ operationId: sends === 1 ? 'prior' : 'next' });
      return 'ok';
    }, async id => { reads++; return { ...ready(), operationId: id }; }, {}, time)).toBe('ok');
    expect(sends).toBe(3); expect(reads).toBe(2); expect(time.delays).toEqual([1000, 1000]);
  });
  test('client can opt out of waiting', async () => {
    const error = busy();
    await expect(withWorkerTargetWait(async () => { throw error; },
      async () => { throw new Error('unexpected read'); }, { timeoutMs: 0 })).rejects.toBe(error);
  });
  test('cancellation during real waiting sends no additional request', async () => {
    const controller = new AbortController();
    let sends = 0, reads = 0;
    const promise = withWorkerTargetWait(async () => { sends++; throw busy(); },
      async () => { reads++; return ready(); },
      { signal: controller.signal, onWait: () => controller.abort(new Error('cancelled')) });
    await expect(promise).rejects.toThrow('cancelled');
    expect(sends).toBe(1); expect(reads).toBe(0);
  });
  test('cancelled callers do not send the initial write', async () => {
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    let sends = 0;
    await expect(withWorkerTargetWait(async () => { sends++; return true; },
      async () => ready(), { signal: controller.signal })).rejects.toThrow('cancelled');
    expect(sends).toBe(0);
  });
  test('a failure after release is not automatically retried', async () => {
    const failure = new RequestTimeoutError(60_000); let sends = 0;
    await expect(withWorkerTargetWait(async () => { if (++sends === 1) throw busy(); throw failure; },
      async () => ready(), {}, clock())).rejects.toBe(failure);
    expect(sends).toBe(2);
  });
  test('structured conflict evidence survives long rendered messages', () => {
    expect(unsentWorkerTargetConflict(new HttpError(409, 'x'.repeat(300), undefined, body))?.operationId).toBe('prior');
  });
});
