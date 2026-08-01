import { describe, it, expect, beforeEach, afterEach, spyOn, jest } from 'bun:test';
import * as client from '../client.ts';
import * as format from '../format.ts';
import * as config from '../config.ts';
import { taskPoll, taskWait } from '../commands/task.ts';

describe('task commands', () => {
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let cfgSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
    cfgSpy = spyOn(config, 'getConfig').mockReturnValue({ actionHost: 'action.xapi.to', apiKey: 'sk-test' });
    exitSpy = spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); }) as any;
  });

  afterEach(() => {
    if (jest.isFakeTimers()) {
      jest.useRealTimers();
    }
    outputSpy.mockRestore();
    errSpy.mockRestore();
    cfgSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('taskPoll calls task.poll and outputs payload', async () => {
    const callSpy = spyOn(client, 'actionCall').mockResolvedValue({
      success: true,
      data: { task_id: 'tid', status: 'pending' },
    });

    await taskPoll(['tid'], {});

    expect(callSpy).toHaveBeenCalledWith('task.poll', { task_id: 'tid' }, expect.any(Object), undefined, 2);
    expect(outputSpy).toHaveBeenCalledWith({ task_id: 'tid', status: 'pending' }, undefined);
    callSpy.mockRestore();
  });

  it('taskWait polls until succeeded', async () => {
    jest.useFakeTimers();
    const callSpy = spyOn(client, 'actionCall')
      .mockResolvedValueOnce({ data: { task_id: 'tid', status: 'pending' } })
      .mockResolvedValueOnce({ data: { task_id: 'tid', status: 'succeeded', result: { ok: true } } });

    const waitPromise = taskWait(['tid'], { interval: '1ms' });
    await Promise.resolve();
    jest.advanceTimersByTime(1);
    await waitPromise;

    expect(callSpy).toHaveBeenCalledTimes(2);
    expect(outputSpy).toHaveBeenCalledWith(
      { task_id: 'tid', status: 'succeeded', result: { ok: true } },
      undefined,
    );
    callSpy.mockRestore();
  });

  it('taskWait exits with code 1 on failed status', async () => {
    const callSpy = spyOn(client, 'actionCall').mockResolvedValue({
      data: { task_id: 'tid', status: 'failed', error: { code: 'upstream_500' } },
    });

    await expect(taskWait(['tid'], { interval: '1ms' })).rejects.toThrow('process.exit');
    expect(outputSpy).toHaveBeenCalledWith(
      { task_id: 'tid', status: 'failed', error: { code: 'upstream_500' } },
      undefined,
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
    callSpy.mockRestore();
  });

  it('taskWait treats --timeout as a real upper bound (no extra poll after deadline)', async () => {
    // interval far larger than timeout: the old code slept a full interval before
    // checking, overshooting by ~10m and polling once more. The deadline must fire
    // after a single poll instead.
    const callSpy = spyOn(client, 'actionCall').mockResolvedValue({ data: { task_id: 'tid', status: 'pending' } });
    await expect(taskWait(['tid'], { interval: '10m', timeout: '30ms' })).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('task wait timeout', expect.stringContaining('timeout_ms=30'));
    expect(callSpy).toHaveBeenCalledTimes(1);
    // The single poll must be bounded by the remaining deadline and not retried,
    // so an in-flight request can't overrun --timeout.
    const [, , , method, retries, pollTimeout] = callSpy.mock.calls[0];
    expect(method).toBeUndefined();
    expect(retries).toBe(0);
    expect(pollTimeout).toBeLessThanOrEqual(30);
    callSpy.mockRestore();
  });

  it('taskWait does not retry the poll under a deadline even when interval < timeout (no backoff overrun)', async () => {
    // The overrun repro: interval 10ms, timeout 30ms, backend errors immediately.
    // With retries enabled the backoff (~500ms x2) blew past the 30ms deadline.
    const callSpy = spyOn(client, 'actionCall').mockRejectedValue(new Error('HTTP 503: busy'));
    await expect(taskWait(['tid'], { interval: '10ms', timeout: '30ms' })).rejects.toThrow('err called');
    expect(callSpy).toHaveBeenCalledTimes(1);
    const [, , , , retries] = callSpy.mock.calls[0];
    expect(retries).toBe(0);
    // The 503 arrived within the deadline → reported as a failure, not a timeout.
    expect(errSpy).toHaveBeenCalledWith('task wait failed', 'HTTP 503: busy');
    callSpy.mockRestore();
  });

  it('taskWait errors when max attempts exceeded', async () => {
    const callSpy = spyOn(client, 'actionCall').mockResolvedValue({
      data: { task_id: 'tid', status: 'pending' },
    });

    await expect(taskWait(['tid'], { interval: '1ms', 'max-attempts': '1' })).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith(
      'task wait exceeded max attempts',
      expect.stringContaining('max_attempts=1'),
    );
    callSpy.mockRestore();
  });

  it('taskWait validates max-attempts', async () => {
    await expect(taskWait(['tid'], { 'max-attempts': '0' })).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('--max-attempts must be a positive integer');
  });

  it('taskWait rejects zero interval', async () => {
    await expect(taskWait(['tid'], { interval: '0ms' })).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('--interval must be greater than 0');
  });

  it('taskPoll validates task id argument', async () => {
    await expect(taskPoll([], {})).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('usage: xapi-to task poll <task_id>');
  });
});
