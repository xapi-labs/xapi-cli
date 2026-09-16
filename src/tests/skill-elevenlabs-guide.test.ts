import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../../skills/xapi/SKILL.md', import.meta.url), 'utf8');
const guide = readFileSync(new URL('../../skills/xapi/guides/elevenlabs.md', import.meta.url), 'utf8');

describe('bundled xAPI ElevenLabs skill guide', () => {
  it('routes audio production tasks from the always-loaded skill to the guide', () => {
    expect(skill.split('\n').length).toBeLessThan(500);
    expect(skill).toContain('Music, sound effects, ElevenLabs text-to-speech, voice discovery, and voice design → `guides/elevenlabs.md`');
    expect(skill).toContain('`guides/elevenlabs.md`** — ElevenLabs audio');
    expect(skill).toContain('**ElevenLabs** (`elevenlabs`');
  });

  it('documents every registered elevenlabs action', () => {
    for (const action of [
      'elevenlabs.v1_music',
      'elevenlabs.v1_sound-generation',
      'elevenlabs.v1_text-to-speech_voice__id',
      'elevenlabs.v1_text-to-speech_voice__id_stream',
      'elevenlabs.v1_voices',
      'elevenlabs.v1_shared-voices',
      'elevenlabs.v1_voices_settings_default',
      'elevenlabs.v1_models',
      'elevenlabs.v1_text-to-voice_design',
      'elevenlabs.v1_speech-to-text',
      'elevenlabs.v1_forced-alignment',
      'elevenlabs.v1_audio-isolation',
      'elevenlabs.v1_speech-to-speech_voice__id',
    ]) expect(guide).toContain(`\`${action}\``);
  });

  it('teaches the input shape, download path, and billing contract', () => {
    for (const required of [
      '"method":"POST"',
      '"pathParams":{"voice_id"',
      'music_length_ms',
      '--output',
      'refuses to overwrite',
      'Query params are strings',
      'dynamic',
      'multipart file upload',
      'ai.audio.transcribe',
    ]) expect(guide).toContain(required);
    expect(guide).not.toContain('sk_');
  });
});
