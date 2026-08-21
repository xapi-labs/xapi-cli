import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from '../client.ts';
import * as config from '../config.ts';
import * as format from '../format.ts';
import { skill } from '../commands/skill.ts';

describe('skill command', () => {
  let requestSpy: ReturnType<typeof spyOn>;
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let configSpy: ReturnType<typeof spyOn>;
  const temporary: string[] = [];

  beforeEach(() => {
    requestSpy = spyOn(client, 'apiKeyApiRequest').mockResolvedValue({ submission: { id: 'submission-1' } });
    outputSpy = spyOn(format, 'output').mockImplementation(() => {});
    errSpy = spyOn(format, 'err').mockImplementation((() => { throw new Error('err called'); }) as any);
    configSpy = spyOn(config, 'getConfig').mockReturnValue({ actionHost: 'action.xapi.to', apiKey: 'sk-provider' });
  });

  afterEach(async () => {
    requestSpy.mockRestore();
    outputSpy.mockRestore();
    errSpy.mockRestore();
    configSpy.mockRestore();
    await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('uploads a local Skill package, preserves relative paths, and skips symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xapi-skill-test-'));
    temporary.push(dir);
    await mkdir(join(dir, 'references'));
    await writeFile(join(dir, 'SKILL.md'), '# Skill');
    await writeFile(join(dir, 'references', 'usage.md'), 'Usage');
    await symlink(join(dir, 'references', 'usage.md'), join(dir, 'linked.md'));

    await skill(['submit'], { dir });

    const [, , path, options] = requestSpy.mock.calls[0] as any;
    expect(path).toBe('/api/skills/agent/submissions');
    expect(options.method).toBe('POST');
    expect(options.retries).toBeUndefined();
    expect(options.body.files.map((file: any) => file.path)).toEqual([
      'references/usage.md',
      'SKILL.md',
    ]);
    expect(Buffer.from(options.body.files[1].contentBase64, 'base64').toString()).toBe('# Skill');
  });

  it('submits a public GitHub skill with metadata overrides', async () => {
    await skill(['submit'], {
      github: 'https://github.com/xapi-labs/skills/tree/main/example',
      version: '1.2.3',
      category: 'ai,provider',
      tag: 'tutorial,xapi',
    });

    expect(requestSpy).toHaveBeenCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/skills/agent/submissions/github',
      {
        method: 'POST',
        body: {
          url: 'https://github.com/xapi-labs/skills/tree/main/example',
          version: '1.2.3',
          categories: ['ai', 'provider'],
          tags: ['tutorial', 'xapi'],
        },
      },
    );
  });

  it('retries the idempotent status read', async () => {
    await skill(['status', 'submission/unsafe'], {});

    expect(requestSpy).toHaveBeenCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/skills/agent/submissions/submission%2Funsafe',
      { timeoutMs: 30_000, retries: 2 },
    );
  });

  it('rejects a local package without root SKILL.md before network I/O', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xapi-skill-test-'));
    temporary.push(dir);
    await writeFile(join(dir, 'README.md'), '# Missing manifest');

    await expect(skill(['submit'], { dir })).rejects.toThrow('err called');
    expect(requestSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('skill request failed', expect.stringContaining('SKILL.md'));
  });

  it('rejects a file above the backend per-file limit before upload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xapi-skill-test-'));
    temporary.push(dir);
    await writeFile(join(dir, 'SKILL.md'), '# Skill');
    await writeFile(join(dir, 'oversized.txt'), Buffer.alloc(512 * 1024 + 1));

    await expect(skill(['submit'], { dir })).rejects.toThrow('err called');
    expect(requestSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith('skill request failed', expect.stringContaining('524288'));
  });

  it('requires exactly one submit source', async () => {
    await expect(skill(['submit'], {})).rejects.toThrow('err called');
    expect(requestSpy).not.toHaveBeenCalled();
  });
});
