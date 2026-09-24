# WebSocket endpoints through the CLI

WebSocket contracts use `protocol`, `wsConfig`, and `wsBilling` inside an
endpoint object. Create or update them through provider CLI files.

```json
{
  "name": "Realtime speech",
  "authType": "BEARER",
  "privateHeaders": { "Authorization": "replace-with-upstream-token" },
  "endpoints": [
    {
      "name": "Realtime session",
      "method": "GET",
      "path": "/v1/realtime",
      "protocol": "WEBSOCKET",
      "wsConfig": {
        "upstreamUrl": "wss://realtime.example.com/v1/session",
        "adapter": "openai-realtime",
        "idleTimeoutSec": 120,
        "maxDurationSec": 900,
        "maxConnPerKey": 2
      },
      "wsBilling": {
        "kind": "realtime-token",
        "inputTokenUsd": 0.000005,
        "outputTokenUsd": 0.00002,
        "holdUsd": 0.05
      }
    }
  ]
}
```

```bash
npx xapi-to provider create --file ./websocket-service.json
```

`wsConfig.upstreamUrl` must be a public `ws://` or `wss://` URL. `adapter` is a
lowercase platform-supported adapter ID. Optional connection controls include
`clientPath`, `subprotocols`, `heartbeatSec`, `idleTimeoutSec`,
`maxFrameBytes`, `maxDurationSec`, and `maxConnPerKey`.

Billing options are:

- `duration` with `perMinuteUsd`;
- `realtime-token` with mixed input/output prices or modality-specific prices;
- `per-char` with `perCharUsd`.

Set `holdUsd` explicitly for realtime-token workloads. For duration billing,
the platform can derive a hold from maximum duration and the per-minute price.
Zero-priced WebSockets still keep connection and rate limits.

For an existing endpoint, inspect the service to get its endpoint ID and include
that ID in the patch:

```json
{
  "endpoints": [
    {
      "id": "existing-endpoint-id",
      "wsConfig": { "maxConnPerKey": 4 }
    }
  ]
}
```

```bash
npx xapi-to provider version update \
  <service-id> <version-id> --file ./websocket.patch.json
```

Pure WebSocket services may omit `baseUrl`, but every WebSocket endpoint needs
its own `wsConfig.upstreamUrl`. Inspect the diff and review result before
claiming the route is live.
