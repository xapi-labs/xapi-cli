# AI Gateway Guide

Use xAPI's public AI Gateway when a tool or application expects an Anthropic- or OpenAI-compatible HTTP API. For one-off agent calls from the terminal, prefer the `ai.*` CLI capabilities documented in `guides/ai.md`. For full-duplex OpenAI Realtime, streaming ASR/TTS, simultaneous interpretation, or other WebSocket sessions, read `guides/ws_gateway.md`.

## Contents

- [Choose CLI capabilities or the Gateway](#choose-cli-capabilities-or-the-gateway)
- [Base URLs and authentication](#base-urls-and-authentication)
- [Claude Code and Anthropic setup](#claude-code-and-anthropic-setup)
- [OpenAI-compatible setup](#openai-compatible-setup)
- [Select a model in the URL](#select-a-model-in-the-url)
- [Supported endpoints](#supported-endpoints)
- [Routing strategies](#routing-strategies)
- [Provider affinity](#provider-affinity)
- [Streaming and protocol translation](#streaming-and-protocol-translation)
- [Routing and billing headers](#routing-and-billing-headers)
- [Image, video, and rerank endpoints](#image-video-and-rerank-endpoints)
- [Known limitations](#known-limitations)
- [Error handling and security](#error-handling-and-security)

## Choose CLI capabilities or the Gateway

Use CLI capabilities when an agent needs to make a small number of direct calls and consume JSON:

```bash
npx xapi-to call ai.text.chat.auto \
  --input '{"model":"deepseek-v4-pro","messages":[{"role":"user","content":"Hello"}]}'
```

Use the AI Gateway when:

- configuring Claude Code, an Anthropic SDK, an OpenAI SDK, or another compatible client;
- an existing application already calls `/v1/messages`, `/v1/chat/completions`, `/v1/responses`, or `/v1/embeddings`;
- the caller needs streaming SSE responses;
- the caller should use model normalization, protocol translation, provider health checks, and fallback without selecting an upstream manually.

The Gateway is a separate HTTP interface. Do not wrap Gateway request bodies in the xAPI action format (`action_id` / `input`). Send the native Anthropic or OpenAI request body directly.

## Base URLs and authentication

Public host: `https://ai.xapi.to`

Strategy-prefixed base URLs:

| Protocol | Base URL |
|---|---|
| Anthropic | `https://ai.xapi.to/<strategy>` |
| OpenAI | `https://ai.xapi.to/<strategy>/v1` |

Omit `<strategy>` to use the default routes directly under `/v1`.

The Gateway accepts the xAPI key through any of these headers:

```text
XAPI-Key: <XAPI_KEY>
Authorization: Bearer <XAPI_KEY>
x-api-key: <XAPI_KEY>
```

Use the header expected by the client library: Anthropic clients normally use `x-api-key`; OpenAI clients normally use `Authorization: Bearer`.

If no key is configured, register or set one with the CLI before proceeding:

```bash
npx xapi-to register
npx xapi-to config set apiKey=<your-key>
```

## Claude Code and Anthropic setup

Configure Claude Code or another Anthropic-compatible client with an xAPI key and a strategy base URL:

```bash
export ANTHROPIC_BASE_URL="https://ai.xapi.to/quality"
export ANTHROPIC_API_KEY="<XAPI_KEY>"
```

Direct Anthropic Messages request:

```bash
curl https://ai.xapi.to/default/v1/messages \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -H 'x-api-key: <XAPI_KEY>' \
  -d '{
    "model":"deepseek-v4-pro",
    "max_tokens":1024,
    "messages":[{"role":"user","content":"Explain xAPI in one sentence."}]
  }'
```

Anthropic fields such as top-level `system`, content blocks, `thinking`, `tools`, `tool_choice`, `temperature`, `top_p`, `top_k`, `stop_sequences`, and `metadata` are accepted and routed with the request. Support at the selected upstream still depends on the model.

## OpenAI-compatible setup

For clients that honor the standard OpenAI environment variables:

```bash
export OPENAI_BASE_URL="https://ai.xapi.to/default/v1"
export OPENAI_API_KEY="<XAPI_KEY>"
```

Direct Chat Completions request:

```bash
curl https://ai.xapi.to/cost/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <XAPI_KEY>' \
  -d '{
    "model":"deepseek-v4-flash",
    "messages":[{"role":"user","content":"Hello"}]
  }'
```

List currently routable canonical models:

```bash
curl https://ai.xapi.to/v1/models
```

Use the returned model ID in subsequent requests. A model can only be routed when an active provider exposes a compatible endpoint and input modality.

## Select a model in the URL

For strategy-aware endpoints, the segment before `/v1` can be either a routing strategy or a model ID. When it is not one of the reserved strategies `default`, `cost`, `speed`, or `quality`, the Gateway treats it as the model, overwrites any `model` value in the request body, and uses the default strategy.

```bash
curl https://ai.xapi.to/gpt-4o/v1/chat/completions \
  -H 'authorization: Bearer <XAPI_KEY>' \
  -H 'content-type: application/json' \
  -d '{"model":"ignored","messages":[{"role":"user","content":"Hello"}]}'
```

This also works for Anthropic Messages, OpenAI Responses, and embeddings. Use it only for model IDs that fit in one URL path segment. For IDs containing `/`, keep the model in the JSON body and use a strategy-prefixed or unprefixed `/v1` route.

## Supported endpoints

| Interface | Method and path | Strategy prefix |
|---|---|---|
| Anthropic Messages | `POST /v1/messages` | Optional |
| OpenAI Chat Completions | `POST /v1/chat/completions` | Optional |
| OpenAI Responses | `POST /v1/responses` | Optional |
| Embeddings | `POST /v1/embeddings` | Optional |
| Model discovery | `GET /v1/models` | Optional |
| Image generation | `POST /v1/images/generations` | No |
| Video generation | `POST /v1/videos` | No |
| Rerank | `POST /v1/rerank` | No |

For strategy-aware endpoints, insert a strategy before `/v1`, for example `/cost/v1/responses`. Without a prefix, the Gateway uses `default`.

## Routing strategies

Accepted strategies:

| Strategy | Current behavior |
|---|---|
| `default` | Prefer protocol-compatible zero-translation candidates, then configured provider priority and weighted distribution. |
| `cost` | Prefer the lowest effective cost, adjusted by recent provider success rate; near-equal candidates fall back to default ordering. |
| `speed` | Accepted, but currently uses the same candidate ordering as `default`. |
| `quality` | Accepted, but currently uses the same candidate ordering as `default`. |

All strategies apply the active-provider gate, model and modality compatibility checks, provider health checks, circuit breaking, and eligible-provider fallback. Do not promise distinct latency or quality optimization for `speed` or `quality` until their dedicated rankers are implemented.

## Provider affinity

After a successful request, the Gateway remembers the serving provider for one hour and promotes it for later requests with the same strategy, model, and affinity identity. The identity is selected in this order:

- Anthropic Messages: `metadata.user_id`, then the xAPI key;
- OpenAI Chat Completions: `prompt_cache_key`, then `user`, then the xAPI key;
- other interfaces, including Responses and embeddings: the xAPI key.

Affinity is isolated between routing strategies and only changes candidate order. It does not bypass health, circuit-breaker, model, modality, or active-provider checks, so clients must not rely on a provider remaining fixed for the full hour.

## Streaming and protocol translation

Set `"stream": true` in Chat Completions, Responses, or Messages requests to receive an SSE stream in the requested protocol.

The Gateway can route across providers with different upstream protocols. When translation is available, it converts the request and response while preserving the inbound Anthropic or OpenAI interface. Model-specific features such as tool calling, thinking, images, or structured output still depend on the selected model and available adapter.

Client-side validation errors normally stop immediately. Provider reliability failures such as authentication/configuration failures, rate limits, timeouts, and server errors may trigger fallback to another eligible provider.

## Routing and billing headers

Successful routed responses can include:

| Header | Meaning |
|---|---|
| `X-Routing-Provider` | Provider that served the final response. |
| `X-Routing-Attempts` | Number of candidates attempted. |
| `X-Routing-Fallback` | `true` when a later candidate succeeded. |
| `X-Routing-Translated` | Present when protocol translation was used. |
| `X-XAPI-Cost` | Aggregated USD cost for the request attempts. |
| `X-XAPI-Cost-Unit` | Cost currency, currently `USD`. |
| `X-XAPI-Billing` | Billing status. |
| `X-XAPI-Billing-Type` | Billing mode, such as `PER_TOKEN` or `ASYNC`. |

Do not use provider names as a stable application contract. Provider selection can change with availability, configuration, pricing, and routing policy.

## Image, video, and rerank endpoints

These endpoints are direct Gateway interfaces and do not use a strategy prefix.

### Images

```bash
curl https://ai.xapi.to/v1/images/generations \
  -H 'authorization: Bearer <XAPI_KEY>' \
  -H 'content-type: application/json' \
  -H 'X-Provider: gpt88' \
  -d '{"model":"gpt-image-2","prompt":"A moonlit mountain lake"}'
```

Image provider selection is hard-pinned with `X-Provider` and has no fallback. The default is `gpt88`; `skyimage` is also available, but the model must be compatible with the selected provider.

### Videos

```bash
curl https://ai.xapi.to/v1/videos \
  -H 'authorization: Bearer <XAPI_KEY>' \
  -H 'content-type: application/json' \
  -H 'X-Provider: openrouter' \
  -d '{"model":"bytedance/seedance-2.0-fast","prompt":"A cat playing piano in a jazz bar"}'
```

The current video provider is `openrouter`, which is also the default and is hard-pinned with no fallback.

Image and video generation are asynchronous. A successful submit returns a `task_id`, `status`, and `poll_url`. Follow the authenticated `poll_url`, or poll the same task through the CLI:

```bash
npx xapi-to task wait <task_id> --interval 2s --timeout 10m
```

### Rerank

```bash
curl https://ai.xapi.to/v1/rerank \
  -H 'authorization: Bearer <XAPI_KEY>' \
  -H 'content-type: application/json' \
  -d '{"model":"<rerank-model>","query":"What is xAPI?","documents":["...","..."]}'
```

Rerank currently routes directly through OpenRouter rather than the strategy-based candidate pool.

## Known limitations

- `POST /v1/messages/count_tokens` is not implemented and currently returns `404`.
- `speed` and `quality` are accepted strategy names but currently use default ordering.
- Image and video endpoints submit asynchronous tasks; they do not return final media in the initial response.
- Image/video provider selection is hard-pinned and does not use chat-style fallback.
- Text-to-speech and speech-to-text are not exposed as HTTP AI Gateway routes. Use `ai.audio.generate` and `ai.audio.transcribe` through the xAPI CLI for synchronous calls, or `guides/ws_gateway.md` for provider-native streaming sessions.
- Model and feature availability is dynamic. Use `GET /v1/models` and handle unsupported-model or modality errors.
- Path-selected models must fit in one URL path segment; otherwise send the model in the body.

## Error handling and security

- **401 / authentication error** → verify that the xAPI key is sent in one supported authentication header.
- **Model not found** → use `GET /v1/models` and select a currently routable model ID.
- **No candidates / 503** → no active provider currently serves that model and protocol combination; retry later or choose another model.
- **Unsupported modality** → choose a model that accepts the request's text, image, or other input type.
- **All providers failed** → retry with backoff; changing strategy may reorder candidates but cannot make an unavailable model routable.
- **Async task failed or expired** → inspect the poll result and resubmit when appropriate.

Never send the xAPI key to a domain outside `*.xapi.to`. Do not print, persist, or share the key, payment URLs, or authenticated polling URLs.
