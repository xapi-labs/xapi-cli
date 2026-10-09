import { expect, test } from 'bun:test';
import { checkWorkerHealth } from '../workers-push.ts';

const worker = { id: 'w', environments: [{ id: 'preview-id', name: 'PREVIEW', publicUrl: 'https://worker.example.test/w/w/preview' }] };
const pending = () => new Response(JSON.stringify({ error: { code: 'workers_postpaid_state_unavailable' } }),
  { status: 503, headers: { 'content-type': 'application/json' } });

test('observes platform permit propagation beyond the old ten reads without repeating a deployment', async () => {
  let reads = 0; const waits: number[] = [];
  const fetcher = async () => ++reads <= 12 ? pending() : new Response('{"ok":true}');
  expect(await checkWorkerHealth(worker, 'preview', '/health', fetcher as unknown as typeof fetch, async ms => { waits.push(ms); }))
    .toMatchObject({ status: 200, attempts: 13 });
  expect(reads).toBe(13);
  expect(waits).toEqual(Array(12).fill(3000));
});

test('does not extend observation for an ordinary application failure', async () => {
  let reads = 0;
  await expect(checkWorkerHealth(worker, 'preview', '/health', (async () => {
    reads++; return new Response('{"error":"application unavailable"}', { status: 503, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch, async () => {})).rejects.toThrow('Deployment is ACTIVE');
  expect(reads).toBe(10);
});

test('bounds persistent platform failure and preserves the ACTIVE deployment verdict', async () => {
  let reads = 0;
  try {
    await checkWorkerHealth(worker, 'preview', '/health', (async () => { reads++; return pending(); }) as unknown as typeof fetch, async () => {});
    throw new Error('Expected readiness failure');
  } catch (error: any) {
    expect(error.recovery).toMatchObject({ deploymentStatus: 'ACTIVE', publicAccessStatus: 'UNVERIFIED', attempts: 21 });
  }
  expect(reads).toBe(21);
});
