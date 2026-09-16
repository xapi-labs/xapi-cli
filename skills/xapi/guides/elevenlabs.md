# ElevenLabs Guide

Direct ElevenLabs audio actions via xAPI — music generation, sound effects, text-to-speech, voice discovery, and voice design. Use this guide when the task is **producing audio** (promo/background music, SFX, narration, voice-over) rather than transcribing it.

ElevenLabs is a **third-party service** (`--source api`, service `elevenlabs`), so every call takes the nested `method` / `pathParams` / `params` / `body` input shape, not the flat built-in-capability shape used in `guides/ai.md`. For OpenRouter-backed TTS/STT through the built-in `ai.audio.*` capabilities, read `guides/ai.md` instead.

## Contents

- [Action catalog](#action-catalog)
- [Saving audio](#saving-audio)
- [Music generation](#music-generation)
- [Sound effects](#sound-effects)
- [Text-to-speech](#text-to-speech)
- [Voices and models](#voices-and-models)
- [Voice design](#voice-design)
- [Endpoints not callable from the CLI](#endpoints-not-callable-from-the-cli)
- [Gotchas](#gotchas)

## Action catalog

Run `npx xapi-to list --service-id b248b27a-1a51-4863-806a-0020ad7cde5a --format table` or `npx xapi-to search elevenlabs --format table` for the live list and prices. Always `get` an action before calling it.

| Action ID | Purpose | Input | Returns | Price |
|-----------|---------|-------|---------|-------|
| `elevenlabs.v1_music` | Generate music from a text prompt | `body.prompt`, `body.music_length_ms` | audio/mpeg | dynamic (≈ $0.09 per 30 s observed) |
| `elevenlabs.v1_sound-generation` | Generate a sound effect | `body.text`, `body.duration_seconds`, `body.prompt_influence` | audio/mpeg | $0.04 / call |
| `elevenlabs.v1_text-to-speech_voice__id` | Text-to-speech | `pathParams.voice_id`, `body.text`, `body.model_id`, `params.output_format` | audio/mpeg | dynamic (per character) |
| `elevenlabs.v1_text-to-speech_voice__id_stream` | Same, chunked upstream | same as above | audio/mpeg | dynamic |
| `elevenlabs.v1_voices` | List voices in the account | `params.search`, `params.category`, `params.page_size` | JSON | $0.0001 |
| `elevenlabs.v1_shared-voices` | Browse the community voice library | `params.search`, `params.language`, `params.page_size` | JSON | $0.0001 |
| `elevenlabs.v1_voices_settings_default` | Default `voice_settings` values | — | JSON | $0.0001 |
| `elevenlabs.v1_models` | List models and their capabilities | — | JSON | $0.0001 |
| `elevenlabs.v1_text-to-voice_design` | Design a new voice from a description | `body.voice_description`, `body.text` or `body.auto_generate_text` | JSON with previews | $0.12 / call |
| `elevenlabs.v1_speech-to-text` | Transcription | multipart upload | — | not callable, see below |
| `elevenlabs.v1_forced-alignment` | Word-level alignment for subtitles | multipart upload | — | not callable, see below |
| `elevenlabs.v1_audio-isolation` | Strip background noise from a recording | multipart upload | — | not callable, see below |
| `elevenlabs.v1_speech-to-speech_voice__id` | Voice conversion | multipart upload | — | not callable, see below |

## Saving audio

Every audio-producing action returns raw `audio/mpeg` bytes. Pass `--output <new-file>` so the CLI writes them straight to disk:

```bash
npx xapi-to call elevenlabs.v1_music \
  --input '{"method":"POST","body":{"prompt":"...","music_length_ms":30000}}' \
  --output music.mp3
# → {"success":true,"output":"music.mp3","bytes":479862,"status":200,"content_type":"audio/mpeg"}
```

- `--output` refuses to overwrite an existing file; pick a fresh name or delete the old one first.
- Without `--output`, the same call returns a JSON envelope `{"success":true,"data":{"type":"binary","encoding":"base64","content":"..."}}`; decode `data.content` yourself. Prefer `--output`.
- `--output` cannot be combined with `--code` or `--stream`.
- Audio comes back as MP3, 128 kbps, 44.1 kHz stereo unless `params.output_format` says otherwise (TTS only).

## Music generation

```bash
npx xapi-to get elevenlabs.v1_music

npx xapi-to call elevenlabs.v1_music \
  --input '{"method":"POST","body":{
    "prompt":"Energetic electronic tech promo track for a developer API launch video. Driving four-on-the-floor kick at 124 BPM, syncopated synth bass, crisp hi-hats, rising arps that build tension, a clear drop at 8 seconds, confident and futuristic, instrumental, no vocals.",
    "music_length_ms":30000}}' \
  --output promo_music.mp3
```

- `body.prompt` (required) — describe genre, tempo (BPM), instrumentation, mood, structure (where the build and drop land), and say `instrumental, no vocals` when a voice-over will sit on top.
- `body.music_length_ms` (optional) — target length in milliseconds. Match it to the video length; the returned file lands within a few tens of milliseconds of the request.
- `body.model_id` (optional) — leave unset unless `get` documents a specific music model.
- Billing is **dynamic** and scales with length. A 30 s track cost about $0.09 in testing; check `npx xapi-to balance` before and after when a budget matters. A call takes roughly 10–15 s.
- Output is loud (around -12 LUFS integrated). When mixing under narration, lower the music track to roughly 0.5–0.6 gain rather than trusting the raw level.
- Do not send a throwaway prompt to "test the endpoint" — every call renders and bills a full-length track.

## Sound effects

```bash
npx xapi-to call elevenlabs.v1_sound-generation \
  --input '{"method":"POST","body":{"text":"short digital whoosh transition","duration_seconds":1.5,"prompt_influence":0.6}}' \
  --output whoosh.mp3
```

- `body.text` (required) — the effect description.
- `body.duration_seconds` (optional) — 0.5 to 30; omit to let the model pick.
- `body.prompt_influence` (optional) — 0 to 1, higher sticks closer to the description.
- Flat $0.04 per call, so it is the cheap way to build a library of UI clicks, whooshes, and stingers for video cue points.

## Text-to-speech

```bash
# 1. Pick a voice (see Voices and models)
# 2. Synthesize
npx xapi-to call elevenlabs.v1_text-to-speech_voice__id \
  --input '{"method":"POST",
    "pathParams":{"voice_id":"21m00Tcm4TlvDq8ikWAM"},
    "params":{"output_format":"mp3_44100_128"},
    "body":{"text":"xAPI connects every API through one key.","model_id":"eleven_multilingual_v2"}}' \
  --output narration.mp3
```

- `pathParams.voice_id` (required) — from `elevenlabs.v1_voices` or `elevenlabs.v1_shared-voices`.
- `body.text` (required). `body.model_id` — `eleven_multilingual_v2` is the safe default for non-English text; `eleven_flash_v2_5` is faster and cheaper; `eleven_v3` is the most expressive but needs more prompt care. Confirm with `elevenlabs.v1_models`.
- `body.language_code` (optional) — ISO 639-1 hint, e.g. `zh`, `en`.
- `body.voice_settings` (optional) — object with `stability`, `similarity_boost`, `style`, `speed`; fetch platform defaults from `elevenlabs.v1_voices_settings_default`.
- `params.output_format` (optional) — e.g. `mp3_44100_128`, `mp3_22050_32`, `pcm_16000`.
- Billing is dynamic per character.
- The `_stream` variant hits the upstream streaming path but the CLI still buffers the whole response (`supportsStreaming` is `false`, `--stream` is not applicable). Use it only when a downstream integration needs that path; for the CLI the non-stream action is equivalent.

## Voices and models

```bash
# List account voices (query params must be strings)
npx xapi-to call elevenlabs.v1_voices \
  --input '{"method":"GET","params":{"page_size":"10","category":"premade"}}' \
  --format json | jq '.data.voices[] | {voice_id, name, labels}'

# Search the shared library
npx xapi-to call elevenlabs.v1_shared-voices \
  --input '{"method":"GET","params":{"search":"narrator","language":"en","page_size":"10"}}'

# Model capabilities and per-request character limits
npx xapi-to call elevenlabs.v1_models --input '{"method":"GET"}' \
  --format json | jq '.data[] | {model_id, can_do_text_to_speech, maximum_text_length_per_request}'

# Default voice settings
npx xapi-to call elevenlabs.v1_voices_settings_default --input '{"method":"GET"}'
```

JSON responses are wrapped as `{"success":true,"data":...}`; the ElevenLabs payload is under `data`.

## Voice design

```bash
npx xapi-to call elevenlabs.v1_text-to-voice_design \
  --input '{"method":"POST","body":{
    "voice_description":"Confident young female tech presenter, clear and upbeat, medium pace",
    "auto_generate_text":true}}'
```

- `body.voice_description` (required).
- Exactly one of `body.text` (100–1000 characters of preview script) or `body.auto_generate_text: true`.
- Returns candidate previews (base64 audio plus a `generated_voice_id`). Saving a preview as a permanent voice requires a create-voice endpoint that is not currently exposed through xAPI, so treat the result as audition-only unless `search elevenlabs` shows a new action.
- $0.12 per call.

## Endpoints not callable from the CLI

`elevenlabs.v1_speech-to-text`, `elevenlabs.v1_forced-alignment`, `elevenlabs.v1_audio-isolation`, and `elevenlabs.v1_speech-to-speech_voice__id` expect a **multipart file upload** upstream. Their registered schemas declare no `body`, and the CLI always sends `application/json`, so any attempt fails with an upstream 422 such as `{"loc":["body","model_id"],"msg":"Field required"}`. Do not retry with different JSON shapes.

Use these alternatives instead:

- Transcription → built-in `ai.audio.transcribe` (base64 audio in JSON), see `guides/ai.md`.
- Streaming ASR or realtime voice → `guides/ws_gateway.md`.

## Gotchas

- **Query params are strings.** `params.page_size: 3` fails with `must be string`; send `"3"`.
- **`method` is required** in every `--input` even though each action has exactly one method.
- **Music and TTS are dynamically billed** and the catalog shows no price; never treat them as free. Sound effects and lookups have fixed per-call prices.
- **Every music call renders a full track.** There is no dry-run; validate the schema with `get`, not by calling.
- **Reuse generated assets.** Save files with descriptive names (`promo_music_v1.mp3`) and keep them in the project rather than regenerating.
