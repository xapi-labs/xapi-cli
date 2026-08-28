import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const skill = readFileSync(join(root, 'skills/xapi/SKILL.md'), 'utf8');
const guide = readFileSync(join(root, 'skills/xapi/guides/provider.md'), 'utf8');

describe('bundled provider guide', () => {
  it('is discoverable from the root xapi skill', () => {
    expect(skill).toContain('guides/provider.md');
    expect(skill).toContain('Provider management:');
  });

  it('documents the backend scope names and owner isolation', () => {
    for (const scope of [
      'service:create',
      'service:read',
      'service:update',
      'version:create',
      'service:publish',
      'service:rollback',
      'observability:read',
      'skill:read',
      'skill:submit',
      'earnings:transfer',
      'service:delete',
    ]) {
      expect(guide).toContain(`\`${scope}\``);
    }
    expect(guide).toContain("cannot\nmanage another provider's service or Skill");
  });

  it('keeps ambiguous writes non-retryable and describes destructive operations', () => {
    expect(guide).toContain('does not\nautomatically retry this write after an ambiguous transport failure');
    expect(guide).toContain('Do not automatically retry an\nambiguous rollback response');
    expect(guide).toContain('Deletion requires both `service:delete`');
    expect(guide).toContain('Transfer is one-way');
  });

  it('covers the independent create-to-observe-to-reinvest workflow', () => {
    for (const command of [
      'provider create',
      'provider publish',
      'skill submit',
      'skill wait',
      'provider skill link',
      'provider metrics',
      'provider events',
      'usage wait',
      'earnings transfer',
    ]) {
      expect(guide).toContain(command);
    }
  });
});
