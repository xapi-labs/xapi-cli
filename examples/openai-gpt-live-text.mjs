#!/usr/bin/env node

// Minimal GPT Live control-path example through xAPI. It uses managed Responses
// delegation and text input so the session lifecycle is visible without audio
// capture. Install the transport in your application first: npm install ws

import { randomUUID } from 'node:crypto';

const apiKey = process.env.XAPI_KEY || process.env.XAPI_API_KEY;
if (!apiKey) {
  throw new Error('Set XAPI_KEY or XAPI_API_KEY in the process environment');
}

let WebSocket;
try {
  ({ default: WebSocket } = await import('ws'));
} catch {
  throw new Error('This example requires the ws package: npm install ws');
}

const prompt = process.argv.slice(2).join(' ').trim() || 'Say hello in one short sentence.';
const prefix = randomUUID();
const url = 'wss://openai-live.p.xapi.to/v1/live/sessions';
const socket = new WebSocket(url, {
  headers: { 'XAPI-Key': apiKey },
});

const timeout = setTimeout(() => {
  console.error('GPT Live example timed out');
  socket.terminate();
  process.exitCode = 1;
}, 60_000);

let closeRequested = false;
let sessionClosedConfirmed = false;

function send(event) {
  socket.send(JSON.stringify(event));
}

function finish(error) {
  clearTimeout(timeout);
  if (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  }
  if (socket.readyState === WebSocket.OPEN) socket.close();
}

socket.on('open', () => {
  send({
    type: 'session.start',
    event_id: `${prefix}-start`,
    session: {
      model: 'gpt-live-1',
      instructions: 'Respond concisely.',
      delegation: { type: 'responses' },
      store: false,
    },
  });
});

socket.on('message', (raw, isBinary) => {
  if (isBinary) return finish(new Error('Unexpected binary GPT Live frame'));

  let event;
  try {
    event = JSON.parse(raw.toString());
  } catch {
    return finish(new Error('GPT Live returned invalid JSON'));
  }

  if (event.type === 'session.started') {
    send({
      type: 'response.item.create',
      event_id: `${prefix}-input`,
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    });
    send({ type: 'response.create', event_id: `${prefix}-response` });
    return;
  }

  if (event.type === 'response.event') {
    const nested = event.event || {};
    if (nested.type === 'response.output_text.delta' && typeof nested.delta === 'string') {
      process.stdout.write(nested.delta);
      return;
    }
    if (nested.type === 'response.refusal.delta' && typeof nested.delta === 'string') {
      process.stdout.write(nested.delta);
      return;
    }
    if (nested.type === 'response.completed') {
      process.stdout.write('\n');
      closeRequested = true;
      send({ type: 'session.close', event_id: `${prefix}-close` });
      return;
    }
    if (nested.type === 'response.failed' || nested.type === 'response.incomplete') {
      return finish(new Error(`Delegated response ended with ${nested.type}`));
    }
  }

  if (event.type === 'error') {
    return finish(new Error(event.error?.message || 'GPT Live session error'));
  }

  if (event.type === 'session.closed') {
    if (!closeRequested || event.reason !== 'close_requested') {
      return finish(new Error(`Unexpected session close: ${event.reason || 'unknown'}`));
    }
    sessionClosedConfirmed = true;
    finish();
  }
});

socket.on('error', (error) => finish(new Error(`WebSocket error: ${error.message}`)));
socket.on('close', () => {
  clearTimeout(timeout);
  if (!sessionClosedConfirmed && process.exitCode !== 1) {
    console.error('WebSocket closed before session.closed confirmation');
    process.exitCode = 1;
  }
});
