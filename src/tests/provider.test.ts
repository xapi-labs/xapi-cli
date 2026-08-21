import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from '../client.ts';
import * as config from '../config.ts';
import * as format from '../format.ts';
import { provider } from '../commands/provider.ts';

describe('provider command', () => {
  let requestSpy: ReturnType<typeof spyOn>;
  let outputSpy: ReturnType<typeof spyOn>;
  let errSpy: ReturnType<typeof spyOn>;
  let configSpy: ReturnType<typeof spyOn>;
  const temporary: string[] = [];

  beforeEach(() => {
    requestSpy = spyOn(client, 'apiKeyApiRequest').mockResolvedValue({ ok: true });
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

  it('uploads About Markdown as service metadata without retrying the write', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xapi-provider-test-'));
    temporary.push(dir);
    const about = join(dir, 'ABOUT.md');
    await writeFile(about, '# About\n\nLong description.');

    await provider(['update', 'service/unsafe'], {
      'about-file': about,
      website: 'https://example.com',
    });

    expect(requestSpy).toHaveBeenCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/api-services/agent/services/service%2Funsafe',
      {
        method: 'PATCH',
        body: {
          aboutMarkdown: '# About\n\nLong description.',
          website: 'https://example.com',
        },
      },
    );
  });

  it('publishes a revision with changelog content and no automatic retry', async () => {
    await provider(['publish', 'service-1', 'revision-1'], {
      changelog: 'Added provider metrics',
    });

    expect(requestSpy).toHaveBeenCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/api-services/agent/services/service-1/revisions/revision-1/submit',
      { method: 'POST', body: { changelog: 'Added provider metrics' } },
    );
  });

  it('links a primary skill using service:update', async () => {
    await provider(['skill', 'link', 'service-1', 'skill-1'], {});

    expect(requestSpy).toHaveBeenCalledWith(
      'api.xapi.to',
      'sk-provider',
      '/api/api-services/agent/services/service-1',
      { method: 'PATCH', body: { linkedSkillId: 'skill-1' } },
    );
  });

  it('queries provider events with the opaque cursor unchanged', async () => {
    await provider(['events'], { after: 'opaque+/cursor=', limit: '25' });

    const path = String(requestSpy.mock.calls[0]?.[2]);
    const url = new URL(`https://api.xapi.to${path}`);
    expect(url.pathname).toBe('/api/agent/events');
    expect(url.searchParams.get('after')).toBe('opaque+/cursor=');
    expect(url.searchParams.get('limit')).toBe('25');
    expect(requestSpy.mock.calls[0]?.[3]).toEqual({ retries: 2 });
  });

  it('writes a scaffold without silently overwriting an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xapi-scaffold-test-'));
    temporary.push(dir);
    const destination = join(dir, 'generated-skill', 'SKILL.md');
    requestSpy.mockResolvedValue({ scaffoldMarkdown: '# Generated', currentFingerprint: { major: 1 } });

    await provider(['skill', 'scaffold', 'service-1'], { output: destination });
    expect(await readFile(destination, 'utf8')).toBe('# Generated');

    await expect(provider(['skill', 'scaffold', 'service-1'], { output: destination })).rejects.toThrow('err called');
    expect(errSpy).toHaveBeenCalledWith('provider request failed', expect.stringContaining('EEXIST'));
  });

  it('requires explicit confirmation for delete', async () => {
    await expect(provider(['delete', 'service-1'], {})).rejects.toThrow('err called');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('rejects bare value-taking flags before network or file I/O', async () => {
    for (const [args, flags] of [
      [['get', 'service-1'], { version: 'true' }],
      [['rollback', 'service-1', '1'], { revision: 'true' }],
      [['events'], { after: 'true' }],
      [['skill', 'scaffold', 'service-1'], { output: 'true' }],
      [['skill', 'fingerprint', 'service-1'], { 'skill-version-id': 'true' }],
      [['delete', 'service-1'], { confirm: 'true' }],
    ] as Array<[string[], Record<string, string>]>) {
      requestSpy.mockClear();
      await expect(provider(args, flags)).rejects.toThrow('err called');
      expect(requestSpy).not.toHaveBeenCalled();
    }
  });

  it('rejects contradictory metadata flags before network I/O', async () => {
    await expect(provider(['update', 'service-1'], {
      about: '# New',
      'clear-about': 'true',
    })).rejects.toThrow('err called');
    expect(requestSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      '--clear-about cannot be combined with --about or --about-file',
    );
  });
});
