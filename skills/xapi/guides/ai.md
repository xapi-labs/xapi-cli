# AI Guide

Complete guide for AI capabilities via xAPI — text chat, summarize/rewrite, embeddings, asynchronous image/video generation, text-to-speech, and speech-to-text.

All AI endpoints are **built-in capabilities** (`--source capability`). Pass parameters with `--input` as a JSON object.

This guide covers CLI capabilities. For Claude Code, Anthropic/OpenAI SDKs, streaming HTTP APIs, and Gateway routing, read `guides/ai_gateway.md`. For full-duplex OpenAI Realtime or provider-native streaming ASR/TTS, read `guides/ws_gateway.md`.

## Contents

- [Text](#text-synchronous-or-sse-streaming)
- [Image generation](#image-generation)
- [Video generation](#video-generation)
- [Speech generation](#speech-generation)
- [Speech transcription](#speech-transcription)
- [Error handling](#error-handling)

## Text (synchronous or SSE streaming)

### Chat completions

```bash
# Fast — low latency, good for simple tasks
npx xapi-to call ai.text.chat.fast \
  --input '{"messages":[{"role":"user","content":"Explain quantum computing in one sentence"}]}'

# Reasoning — slower, more thorough for analysis
npx xapi-to call ai.text.chat.reasoning \
  --input '{"messages":[{"role":"user","content":"Analyze the pros and cons of microservices"}]}'

# Auto — you name the model; the gateway auto-routes to the best upstream with fallback
npx xapi-to call ai.text.chat.auto \
  --input '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"Hello"}]}'
```

- `messages` follows the standard `[{role, content}]` chat format. `fast` and `reasoning` accept `system` | `user` | `assistant`; `auto` documents `user` | `assistant`.
- **When to choose which:** `fast` for quick/cheap replies, `reasoning` for multi-step analysis, `auto` when you want to specify a particular model and let the gateway pick the healthiest provider that serves it (defaults to `deepseek-v4-pro` if `model` is omitted).
- `ai.text.chat.auto.priority` accepts `default`, `cost`, `speed`, or `quality`. `cost` affects candidate ranking; `speed` and `quality` are accepted routing labels but currently have no dedicated rankers, so do not promise a distinct latency or quality outcome. See `guides/ai_gateway.md` for routing details.
- Add `--stream` to `ai.text.chat.fast`, `ai.text.chat.reasoning`, `ai.text.chat.auto`, `ai.text.summarize`, or `ai.text.rewrite` to forward the backend HTTP SSE frames unchanged. This is not WebSocket transport. Do not combine it with `--output` or `--code`.

### Summarize & rewrite

```bash
npx xapi-to call ai.text.summarize --input '{"text":"<long text here>"}'

npx xapi-to call ai.text.rewrite --input '{"text":"<text>","mode":"formalize"}'
```

`mode` values: `improve`, `simplify`, `formalize`, `casual`, `creative`, `professional`, `academic`.

- Summarization controls that affect execution: `model`, `max_length` (target words), `style` (`concise`, `detailed`, `bullet_points`, or `executive`), `language` (`auto` keeps the input language), `focus`, and `temperature`.
- Rewrite controls that affect execution: `model`, `mode`, `tone`, `target_audience`, `length_preference` (`shorter`, `similar`, or `longer`), and `temperature`.
- Always run `get` before using newly advertised fields. Do not assume every declared compatibility field changes current backend behavior.

### Embeddings

```bash
npx xapi-to call ai.embedding.generate --input '{"input":"hello world"}'
```

Returns a vector for one input string; use it for semantic search or similarity. Optional fields are `model`, `encoding_format` (`float` or `base64`), model-dependent `dimensions`, `user`, and provider-routing options in the `provider` object. The current declared schema accepts a string, so do not send a batch array until `get` reports array support.

## Image generation

Image generation is asynchronous and returns a task to wait for.

```bash
npx xapi-to call ai.image.generate \
  --input '{"prompt":"A serene mountain landscape at sunset, digital art","model":"gpt-image-2"}'
```

- `prompt` (required) — the text description.
- `provider` (optional) — upstream, hard-pinned (no fallback). Defaults to `gpt88`.
- `model` (optional) — **must be compatible with the provider**:
  - `gpt88` (default provider) serves `gpt-image-2` (default model).
  - `skyimage` serves `gpt-image-1` and `dall-e-*` (`dall-e-3`, `dall-e-2`).
  - ⚠️ Picking e.g. `dall-e-3` without also setting `provider: "skyimage"` will fail — the default `gpt88` provider only serves `gpt-image-2`.
- `n` (optional) — number of images (default `1`); `size` (optional, e.g. `1024x1024`).
- Other optional controls include `aspect_ratio`, `quality`, `background`, `moderation`, `style`, `image` (reference-image array), and `user`. Support depends on the selected model.
- Returns an async task handle, not the image itself. Wait for it with `task wait` as described below.

## Video generation

Video generation does **not** return the video immediately. It returns a task handle you must poll.

### Step 1: Submit the generation request

```bash
npx xapi-to call ai.video.generate \
  --input '{"prompt":"A cat playing piano in a jazz bar, cinematic"}'
```

Optional inputs:
- `model` — any OpenRouter video model accepted upstream, e.g. `bytedance/seedance-2.0-fast`, `bytedance/seedance-2.0`, `google/veo-3.1`, or `openai/sora-2-pro`. Defaults to `bytedance/seedance-2.0-fast`.
- `provider` — only `openrouter` is currently supported; it is the default and is hard-pinned with no fallback.
- `image` — a single reference image URL (first frame).
- `images` — multiple reference image URLs.
- `input_reference` — OpenAI Videos-style reference material.
- `size` — frame size or aspect ratio, e.g. `1280x720`, `16:9`, or `9:16`.
- `duration` / `seconds` — requested duration; accepted values depend on the model.
- `seed` — random seed.
- `metadata` — provider-specific options such as roles, resolution, audio, watermark, or ratio.

The response is a **202-style async task**:

```json
{ "task_id": "…", "status": "pending", "poll_url": "…", "expires_at": "…" }
```

### Step 2: Wait until terminal

```bash
npx xapi-to task wait <task_id-from-step-1> --interval 2s --timeout 10m
```

Status values: `pending` | `processing` | `succeeded` | `failed` | `expired`.

- `task wait` polls every few seconds until the status is **terminal** (`succeeded` / `failed` / `expired`).
- On `succeeded`, the result payload (video URL/data) is included.
- On `failed` / `expired`, the error payload is printed and the command exits nonzero.

Use `npx xapi-to task poll <task_id>` for one status read when another scheduler controls the loop. Add `--max-attempts <n>` when an attempt bound is more useful than a time bound. Duration values accept `ms`, `s`, `m`, and `h`.

**Agent-controlled polling loop (pseudocode):**

```
submit → get task_id
loop:
  result = run("npx xapi-to task poll " + task_id)
  if result.status in {succeeded, failed, expired}: break
  wait a few seconds
handle result
```

Do not busy-loop with zero delay — space polls a few seconds apart. If the task `expires`, resubmit.

## Speech generation

Text-to-speech calls are synchronous.

```bash
npx xapi-to call ai.audio.generate \
  --input '{"text":"Hello world, this is a test.","model":"hexgrad/kokoro-82m","voice":"af_bella","format":"mp3"}'
```

Required inputs:

- `text` — text to convert into speech.
- `model` — OpenRouter TTS model ID.
- `voice` — a voice supported by the selected model.

Optional inputs:

- `format` — `mp3` (default) or `pcm`.
- `speed` — playback-speed multiplier when supported by the model.
- `provider` — OpenRouter provider-routing options as an object, not a provider name string.

The response is a lossless binary envelope:

```json
{
  "success": true,
  "data": {
    "type": "binary",
    "encoding": "base64",
    "content_type": "audio/mpeg",
    "content_length": 12345,
    "content": "<base64-audio>"
  }
}
```

Decode `data.content` from base64 to save or play the audio. `data.content_disposition` may also be present when supplied upstream.

## Speech transcription

Speech-to-text calls are synchronous.

```bash
npx xapi-to call ai.audio.transcribe \
  --input '{"audio":{"data":"<base64-audio>","format":"wav"},"model":"openai/whisper-large-v3","language":"en"}'
```

- `audio` (required) — object containing raw base64 `data` without a data URI prefix and a file `format` such as `wav`, `mp3`, `flac`, `m4a`, `ogg`, `webm`, or `aac`.
- `model` (required) — OpenRouter speech-recognition model ID.
- `language` (optional) — ISO-639-1 code; omit it for automatic detection.
- `temperature` (optional) — transcription sampling temperature.
- `provider` (optional) — OpenRouter provider-routing options as an object.

Returns the transcribed `text` and optional OpenRouter `usage` information.

## Error handling

- **Missing `prompt`** → `prompt` is required for both `ai.image.generate` and `ai.video.generate`.
- **Unknown image model** → use a model compatible with the chosen image provider; omit both fields to use `gpt88` + `gpt-image-2`.
- **Unknown video provider/model** → provider must be `openrouter`; omit `model` to use `bytedance/seedance-2.0-fast`.
- **Image/video result never ready** → keep polling until a terminal status; on `expired`, resubmit the request.
- **Missing speech fields** → TTS requires `text`, `model`, and `voice`; transcription requires `audio.data`, `audio.format`, and `model`.
- **Invalid audio input** → pass raw base64 bytes without a `data:audio/...;base64,` prefix and set the matching file format.
- **Insufficient balance** → run `npx xapi-to topup --method stripe --amount 10` (AI media and speech calls consume credits).
