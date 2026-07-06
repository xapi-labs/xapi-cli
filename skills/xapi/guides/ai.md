# AI Guide

Complete guide for AI capabilities via xAPI — text chat, summarize/rewrite, embeddings, image generation, and **asynchronous** video generation with polling.

All AI endpoints are **built-in capabilities** (`--source capability`). Pass parameters with `--input` as a JSON object.

## Text (synchronous)

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

### Summarize & rewrite

```bash
npx xapi-to call ai.text.summarize --input '{"text":"<long text here>"}'

npx xapi-to call ai.text.rewrite --input '{"text":"<text>","mode":"formalize"}'
```

`mode` values: `improve`, `simplify`, `formalize`, `casual`, `creative`, `professional`, `academic`.

### Embeddings

```bash
npx xapi-to call ai.embedding.generate --input '{"input":"hello world"}'
```

Returns a vector for the input text; use for semantic search / similarity.

## Image generation (synchronous)

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
- Returns the generated image(s) synchronously (URL or data in the response).

## Video generation (ASYNCHRONOUS — poll for the result)

Video generation does **not** return the video immediately. It returns a task handle you must poll.

### Step 1: Submit the generation request

```bash
npx xapi-to call ai.video.generate \
  --input '{"prompt":"A cat playing piano in a jazz bar, cinematic"}'
```

Optional inputs:
- `model` — e.g. `dreamina-seedance-2-0-260128` (provider-specific).
- `provider` — upstream provider (default `byteplus`).
- `image` — a single reference image URL (first frame).
- `images` — multiple reference image URLs.

The response is a **202-style async task**:

```json
{ "task_id": "…", "status": "pending", "poll_url": "…", "expires_at": "…" }
```

### Step 2: Poll until terminal

```bash
npx xapi-to call task.poll --input '{"task_id":"<task_id from step 1>"}'
```

Status values: `pending` | `processing` | `succeeded` | `failed` | `expired`.

- Poll every few seconds until the status is **terminal** (`succeeded` / `failed` / `expired`).
- On `succeeded`, the result payload (video URL/data) is included.
- On `failed` / `expired`, an error is included.

**Agent polling loop (pseudocode):**

```
submit → get task_id
loop:
  result = task.poll(task_id)
  if result.status in {succeeded, failed, expired}: break
  wait a few seconds
handle result
```

Do not busy-loop with zero delay — space polls a few seconds apart. If the task `expires`, resubmit.

## Error handling

- **Missing `prompt`** → `prompt` is required for both `ai.image.generate` and `ai.video.generate`.
- **Unknown model** → check the allowed `model` values above; omit `model` to use the default.
- **Video result never ready** → keep polling until a terminal status; on `expired`, resubmit the request.
- **Insufficient balance** → run `npx xapi-to topup --method stripe --amount 10` (image/video generation consumes credits).
