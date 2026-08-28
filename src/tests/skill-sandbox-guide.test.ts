import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { SANDBOX_HELP } from '../commands/sandbox.ts';

const skill = readFileSync(new URL('../../skills/xapi/SKILL.md', import.meta.url), 'utf8');
const guide = readFileSync(new URL('../../skills/xapi/guides/sandbox.md', import.meta.url), 'utf8');

describe('bundled xAPI Sandbox skill guide', () => {
  it('keeps the always-loaded skill concise and routes Sandbox tasks to the guide', () => {
    expect(skill.split('\n').length).toBeLessThan(500);
    expect(skill).toContain('Read `guides/sandbox.md` before creating a billable instance');
    expect(skill).toContain('`guides/sandbox.md`** — managed Sandbox compute');
  });

  it('documents every user-facing Sandbox command family', () => {
    for (const command of [
      'offerings', 'quote', 'list', 'history', 'get', 'create', 'wait', 'exec',
      'file', 'port', 'extension', 'audit', 'suspend', 'resume', 'terminate', 'run',
    ]) {
      expect(SANDBOX_HELP).toContain(command);
      expect(guide).toMatch(new RegExp(`sandbox (?:\\w+ )?${command}\\b`));
    }
  });

  it('teaches the safety and verification contract needed by AI agents', () => {
    for (const required of [
      'price ceiling',
      'finally',
      'SIGINT',
      'SIGTERM',
      'SIGKILL',
      'totalCost',
      'billingPeriods',
      'sandbox list',
      'no active instance',
      'never place it in prompts',
    ]) expect(guide).toContain(required);
    expect(guide).toContain('cf-edge.sandbox.test.xapi.to');
    expect(guide).toContain('daytona-sandbox.sandbox.xapi.to');
    expect(guide).toContain('--background');
    expect(guide).toContain('backgroundExec');
    expect(guide).not.toContain('sk-');
  });

  it('keeps Agent orchestration outside the xAPI Sandbox product boundary', () => {
    for (const responsibility of [
      'discovery, quote, lifecycle, exec, files, ports',
      'history, audit, and billing',
    ]) expect(guide).toContain(responsibility);
    for (const excluded of [
      'prompts, model loops, memory',
      'multi-agent orchestration',
      'job DAGs',
      'human approval workflows',
    ]) expect(guide).toContain(excluded);
    expect(guide).toContain('client-side recipes');
    expect(guide).toContain('not additional Gateway workflow APIs');
  });
});
