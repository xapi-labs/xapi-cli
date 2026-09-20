import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const skillRoot = join(root, 'skills', 'xapi-provider');
const skill = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8');

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe('bundled xapi-provider skill', () => {
  it('covers every provider CLI operation family', () => {
    for (const command of [
      'provider create',
      'provider list',
      'provider get',
      'provider update',
      'provider versions',
      'provider version update',
      'provider major create',
      'provider revision start',
      'provider publish',
      'provider rollback',
      'provider default-major',
      'provider deprecate',
      'provider restore',
      'provider review',
      'provider diff',
      'provider metrics',
      'provider events',
      'provider skill context',
      'provider skill scaffold',
      'provider skill link',
      'provider skill unlink',
      'provider skill fingerprint',
      'provider delete',
    ]) {
      expect(skill).toContain(command);
    }
  });

  it('uses the CLI for xAPI provider management', () => {
    const instructionalFiles = filesUnder(skillRoot).filter((path) =>
      ['.md', '.sh'].includes(extname(path)),
    );
    for (const path of instructionalFiles) {
      const content = readFileSync(path, 'utf8');
      expect(content).not.toMatch(/\bcurl\b/);
      expect(content).not.toContain('register-api-service');
      expect(content).not.toMatch(/(?:POST|GET|PUT|PATCH|DELETE) \/api\//);
    }
  });

  it('ships CLI create payloads as valid JSON objects', () => {
    const payloads = [
      ...filesUnder(join(skillRoot, 'templates')),
      ...filesUnder(join(skillRoot, 'examples')),
    ].filter((path) => extname(path) === '.json');

    for (const path of payloads) {
      const payload = JSON.parse(readFileSync(path, 'utf8'));
      expect(payload).toBeInstanceOf(Object);
      expect(typeof payload.name).toBe('string');
      expect(['NONE', 'HEADER', 'BEARER', 'QUERY']).toContain(payload.authType);
      expect(Array.isArray(payload.endpoints)).toBe(true);
    }
  });
});
