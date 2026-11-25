import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Agent } from 'undici/index.js';
import { request, uploadRequest } from '../client.ts';

const native = globalThis.fetch;
if (process.argv.includes('--node18-shape')) {
  // Exact Node 18 bootstrap wrapper; absent lazyUndici makes a missed match fail.
  globalThis.fetch = new Function('return async function fetch(input, init = undefined) { return lazyUndici().fetch(input, init); }')();
}
let dispatches = 0;
const original = Agent.prototype.dispatch;
Agent.prototype.dispatch = function (options, handler) { if (this.constructor.name === 'RequestDeadlineAgent') dispatches++; return original.call(this, options, handler); };
const server = createServer(async (req, res) => {
  for await (const _chunk of req) { /* consume the real request */ }
  res.end('{"ok":true}');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
try {
  assert.deepEqual(await request(base, {}, 1000), { ok: true });
  assert.deepEqual(await uploadRequest(base, { method: 'POST', body: 'once' }), { ok: true });
  assert.equal(dispatches, 2, 'native loader must select the matched deadline-capable transport');
  let intercepted = 0;
  const wrapper = (async (input, init) => { intercepted++; return native(input, init); }) as typeof fetch;
  // Even an own toString that resembles native fetch must not bypass an override.
  Object.defineProperty(wrapper, 'toString', { value: () => 'async function fetch(input, init = undefined) { return lazyUndici().fetch(input, init); }' });
  globalThis.fetch = wrapper;
  assert.deepEqual(await request(base, {}, 1000), { ok: true });
  assert.equal(intercepted, 1);
  assert.equal(dispatches, 2);
  console.log(JSON.stringify({ node: process.version, shape: process.argv.includes('--node18-shape') ? 'node18' : 'actual-native', dispatches, intercepted, result: 'passed' }));
} finally {
  globalThis.fetch = native;
  Agent.prototype.dispatch = original;
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
