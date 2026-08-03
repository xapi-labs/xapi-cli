import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actionDownload } from '../client.ts';

describe('actionDownload', () => {
  let dir: string;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xapi-cli-binary-'));
  });

  afterEach(async () => {
    fetchSpy?.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes response bytes exactly and requests raw mode', async () => {
    const bytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x00,
    ]);
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'audio/wav',
          'content-disposition': 'attachment; filename="speech.wav"',
        },
      }),
    );
    const target = join(dir, 'speech.wav');

    const result = await actionDownload(
      'openrouter.audio_speech',
      { body: { input: 'Hello' } },
      { actionHost: 'action.xapi.to', apiKey: 'sk-test' },
      target,
      'POST',
    );

    expect((await readFile(target)).equals(bytes)).toBe(true);
    expect(result).toMatchObject({
      output: target,
      bytes: bytes.length,
      status: 200,
      contentType: 'audio/wav',
      contentDisposition: 'attachment; filename="speech.wav"',
    });
    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      action_id: 'openrouter.audio_speech',
      method: 'POST',
      input: { body: { input: 'Hello' } },
      response_mode: 'raw',
    });
  });

  it('refuses to overwrite an existing output file', async () => {
    const target = join(dir, 'existing.mp3');
    await Bun.write(target, 'keep-me');
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from([0xff]), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    );

    await expect(
      actionDownload(
        'openrouter.audio_speech',
        {},
        { actionHost: 'action.xapi.to', apiKey: 'sk-test' },
        target,
      ),
    ).rejects.toThrow('Output file already exists');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await readFile(target, 'utf8')).toBe('keep-me');
  });

  it('applies the remote host allowlist and removes the empty output file', async () => {
    const target = join(dir, 'blocked.mp3');
    fetchSpy = spyOn(globalThis, 'fetch');

    await expect(
      actionDownload(
        'openrouter.audio_speech',
        {},
        { actionHost: 'evil.example', apiKey: 'sk-test' },
        target,
      ),
    ).rejects.toThrow('refusing to contact untrusted host');
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(stat(target)).rejects.toThrow();
  });
});
