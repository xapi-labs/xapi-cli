# WebSocket Gateway Guide

Use xAPI's WebSocket Gateway for full-duplex, low-latency sessions such as OpenAI Realtime, streaming speech recognition, bidirectional text-to-speech, simultaneous interpretation, and podcast generation.

The WebSocket Gateway shares the public `ai.xapi.to` host with the HTTP AI Gateway, but it is a separate protocol surface. An HTTP request continues to use the AI Gateway; a valid WebSocket Upgrade request is routed to the WebSocket Gateway.

## Contents

- [Choose the right interface](#choose-the-right-interface)
- [Public URLs and routing](#public-urls-and-routing)
- [Authentication](#authentication)
- [OpenAI Realtime example](#openai-realtime-example)
- [Browser connections](#browser-connections)
- [Native protocol endpoints](#native-protocol-endpoints)
- [Volcengine ASR options](#volcengine-asr-options)
- [Connection behavior and billing](#connection-behavior-and-billing)
- [Errors and reconnects](#errors-and-reconnects)
- [Security](#security)

## Choose the right interface

Use:

- `npx xapi-to call ai.*` for one-off CLI calls with JSON input and output;
- the HTTP AI Gateway in `guides/ai_gateway.md` for Anthropic/OpenAI-compatible request-response APIs and SSE streaming;
- the WebSocket Gateway for a persistent, bidirectional session with text, audio, or provider-native binary frames.

Do not send a WebSocket request through `npx xapi-to call`. The CLI action envelope (`action_id` / `input`) and HTTP Gateway request bodies do not apply after a WebSocket connection is established.

## Public URLs and routing

Preferred unified form:

```text
wss://ai.xapi.to/<endpoint-path>
```

Current curated production paths include:

| Path | Protocol | Typical use |
|---|---|---|
| `/v1/realtime` | OpenAI Realtime GA JSON events | Realtime text and voice |
| `/v1/asr` | Volcengine ASR binary frames | Streaming speech recognition |
| `/v1/tts` | Doubao bidirectional TTS binary frames | Streaming text-to-speech |
| `/v1/ast` | Doubao AST v4 protobuf frames | Simultaneous interpretation |
| `/v1/podcast` | Doubao podcast binary frames | Long-form podcast generation |

The catalog is dynamic. Confirm the path and wire protocol shown by the current xAPI service before building against it.

The unified host resolves a connection by exact path. A unique active endpoint is selected directly. If several endpoints share `/v1/realtime`, the unified route prefers the native `openai-realtime` endpoint. It does not currently use `?model=` to select another realtime provider.

For a specific third-party service, use its service host when provided:

```text
wss://<service-slug>.p.xapi.to/<endpoint-path>
```

This avoids shared-path ambiguity and is required when the desired service uses a provider-native protocol that is not selected by the unified path. Console Try-It and review workflows can also address an endpoint exactly with `?endpoint=<endpoint-id>`.

## Authentication

Use the same xAPI key as the CLI and HTTP Gateway. Server-side clients should send one of these handshake headers:

```text
XAPI-Key: <XAPI_KEY>
Authorization: Bearer <XAPI_KEY>
x-api-key: <XAPI_KEY>
```

Example with `wscat`:

```bash
wscat -c "wss://ai.xapi.to/v1/realtime" \
  -H "XAPI-Key: $XAPI_KEY"
```

The Gateway also accepts `?token=<XAPI_KEY>` or `?xapi-key=<XAPI_KEY>` for clients that cannot set headers. Avoid query authentication for long-lived keys: URLs are commonly retained in browser history, access logs, error reports, and monitoring systems.

Authentication is checked before the WebSocket upgrade. Invalid handshakes therefore return an HTTP status instead of opening and immediately closing a socket.

## OpenAI Realtime example

The unified `/v1/realtime` route speaks the OpenAI Realtime GA JSON event protocol. It is native passthrough: send the same events you would send to the upstream Realtime API, but authenticate with the xAPI key.

```javascript
import WebSocket from "ws";

const ws = new WebSocket("wss://ai.xapi.to/v1/realtime", {
  headers: { "XAPI-Key": process.env.XAPI_KEY },
});

ws.on("message", (raw, isBinary) => {
  if (isBinary) return;
  const event = JSON.parse(raw.toString());

  if (event.type === "session.created") {
    ws.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say hello in one sentence." }],
      },
    }));
    ws.send(JSON.stringify({ type: "response.create" }));
  }

  if (event.type === "response.done") {
    console.log(event.response);
    ws.close(1000, "done");
  }

  if (event.type === "error") console.error(event.error);
});
```

Do not send the retired `OpenAI-Beta: realtime=v1` header. Session settings, audio buffers, tool calls, and response events follow the current OpenAI Realtime GA shape.

## Browser connections

The browser `WebSocket` API cannot set arbitrary handshake headers. The Gateway accepts an xAPI key or temporary token through a subprotocol entry:

```javascript
const temporaryToken = await getTemporaryTokenFromYourBackend();
const ws = new WebSocket(
  "wss://ai.xapi.to/v1/realtime",
  [`xapi-key.${temporaryToken}`],
);
```

Never embed a long-lived xAPI key in frontend JavaScript. Use the authenticated xAPI Console Try-It flow or your backend to obtain a short-lived token, then pass only that token to the browser. The Console's `POST /api/keys/ws-token` flow mints a temporary token for a WebSocket endpoint; it requires a logged-in entity account and an endpoint ID, and is not authenticated with a normal xAPI key.

If a browser integration must use `?token=`, use only a short-lived token and avoid logging the complete URL.

## Native protocol endpoints

The Gateway forwards frames without translating the application protocol. The selected adapter extracts usage for billing and observability, but the client still has to speak the endpoint's native wire format.

| Adapter | Client frames | Important client requirement |
|---|---|---|
| `openai-realtime` | UTF-8 JSON text | Use OpenAI Realtime GA events. |
| `volcengine-asr` | Binary | Send the Volcengine ASR header/config/audio frame sequence; PCM configuration must match the audio bytes. |
| `doubao-realtime` | Binary | Use the Doubao end-to-end realtime dialogue protocol through its service host or exact endpoint. |
| `doubao-tts` | Binary | Use the bidirectional TTS event sequence; audio responses are provider-native frames. |
| `doubao-ast` | Binary protobuf | Each message follows Doubao AST v4 protobuf framing. |
| `doubao-podcast` | Binary | Use the Doubao podcast event protocol and complete input metadata. |

Do not send JSON copied from the OpenAI Realtime API to a Doubao binary endpoint. The shared `ai.xapi.to` hostname does not imply a shared event schema, and the Gateway does not currently translate OpenAI Realtime events into Doubao events.

For binary services, prefer the service's xAPI Try-It client or the provider protocol documentation. `wscat` can prove that a handshake succeeds, but it is not sufficient for a functional ASR, TTS, AST, or podcast test.

## Volcengine ASR options

The `/v1/asr` adapter exposes these per-session fields in the native config frame's `request` object:

| Field | Default | Meaning |
|---|---:|---|
| `enable_punc` | `true` | Insert punctuation. |
| `enable_itn` | `true` | Normalize spoken numbers, dates, and amounts. |
| `enable_ddc` | `false` | Remove filler words and repeated speech. |
| `show_utterances` | `false` | Return utterance boundaries and timestamps. |
| `result_type` | `full` | Use `full` for cumulative text or `single` for incremental fragments. |

Audio must be raw PCM, 16-bit, mono, at 16 kHz (default) or 8 kHz. The rate declared in the config frame must exactly match the bytes sent. The ASR `model_name` is fixed by the selected endpoint and is not a caller-selectable option.

## Connection behavior and billing

- Frames are forwarded as text or binary without changing their order. The maximum accepted WebSocket message payload is currently 4 MiB.
- The default idle timeout is 120 seconds, but an endpoint can override it. Send valid application traffic and let the WebSocket library answer ping frames automatically.
- Maximum session duration is endpoint-specific. Reconnect when the application needs a longer conversation.
- The default per-key limits are 10 concurrent connections and 60 connection attempts per minute; an endpoint can configure lower or higher values.
- Billing is endpoint-specific: duration, realtime token usage, or input characters. The Gateway can reserve balance at handshake and settles usage when the connection closes.
- Unlike HTTP AI Gateway routing, a WebSocket session is pinned to one resolved endpoint and upstream. There is no transparent mid-session provider fallback.

## Errors and reconnects

Handshake failures:

| HTTP status | Meaning |
|---|---|
| `400` | The selected endpoint is not a valid WebSocket endpoint or its upstream is unavailable by policy. |
| `401` | API key is missing, invalid, or expired. |
| `402` | Balance is insufficient for the initial reservation. |
| `404` | No active endpoint matches the host, path, or explicit endpoint ID. |
| `429` | Per-key concurrency or connection-rate limit was exceeded. |

After upgrade, important close codes include:

| Close code | Meaning |
|---|---|
| `1000` | Normal close, idle timeout, or configured maximum duration. |
| `1001` | Gateway is updating or draining; reconnect after a delay. |
| `1011` | Upstream connection, timeout, backpressure, or internal gateway failure. |
| `4401` | The key expired or was revoked while the session was open. |
| `4402` | Available balance was exhausted during the session. |

Reconnect only for recoverable conditions such as `1001`, transient `1011`, or a failed handshake caused by rate limiting. Use exponential backoff with jitter, cap the delay, and stop retrying on authentication, balance, or endpoint errors until the underlying problem is corrected. Recreate session state after reconnect; the Gateway does not resume prior provider sessions.

Use a real WebSocket client to test connectivity. A hand-written `curl` Upgrade request can be changed by an intermediary and produce a misleading HTTP response.

## Security

- Send xAPI credentials only to `*.xapi.to` hosts.
- Prefer handshake headers for server-side clients and short-lived tokens for browsers.
- Never put a long-lived key in source code, frontend bundles, query strings, screenshots, or logs.
- Treat endpoint-specific audio, transcripts, prompts, and generated media as sensitive application data.
