import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const guide = readFileSync(new URL('../../skills/xapi/guides/ws_gateway.md', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../../skills/xapi/SKILL.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const example = readFileSync(new URL('../../examples/openai-gpt-live-text.mjs', import.meta.url), 'utf8');

describe('bundled GPT Live guidance', () => {
  it('keeps GPT Live distinct from OpenAI Realtime and Action calls', () => {
    for (const required of [
      'wss://openai-live.p.xapi.to/v1/live/sessions',
      '`session.start`',
      '`session.started`',
      '`gpt-live-1`',
      '`client`',
      '`responses`',
      '`session.delegation.created`',
      '`session.commentary.append`',
      '`session.commentary.appended`',
      'Do not replace it with `/v1/realtime`',
      'not an Action `call`',
    ]) expect(guide).toContain(required);
    expect(skill).toContain('GPT Live uses `/v1/live/sessions`');
  });

  it('documents endpoint-bound browser credentials without query secrets', () => {
    for (const required of [
      'latestStartAt', 'maxDurationSec', 'endpoint-bound',
      'xapi-ws-v1', 'xapi-key.${credential.token}',
    ]) expect(guide).toContain(required);
    expect(guide).toContain('Never embed a long-lived xAPI key');
  });

  it('ships a managed Responses example with the complete close lifecycle', () => {
    for (const required of [
      "process.env.XAPI_KEY", "import('ws')",
      "type: 'session.start'", "type: 'response.item.create'",
      "type: 'response.create'", "type: 'session.close'",
      "event.type === 'session.closed'", "delegation: { type: 'responses' }",
      'sessionClosedConfirmed',
    ]) expect(example).toContain(required);
    expect(example).not.toContain('?token=');
    expect(example).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(readme).toContain('examples/openai-gpt-live-text.mjs');
  });

  it('keeps Markdown fences balanced', () => {
    expect((guide.match(/^```/gm) ?? []).length % 2).toBe(0);
  });
});
