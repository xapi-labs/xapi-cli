# Endpoint billing

Set billing on each object in `endpoints`. The CLI sends these fields as part of
`provider create --file` or `provider version update --file`.

## Fixed price: `PER_CALL`

```json
{
  "name": "Lookup",
  "method": "GET",
  "path": "/lookup",
  "billingType": "PER_CALL",
  "costPerCall": 0.001
}
```

Use this when every successful invocation has the same price. A price of `0` is
valid; read [free access](free-api-access.md) before publishing a free endpoint.

## Token usage: `PER_TOKEN`

```json
{
  "name": "Chat completion",
  "method": "POST",
  "path": "/v1/chat/completions",
  "billingType": "PER_TOKEN",
  "tokenPricing": {
    "model-a": {
      "inputPricePerToken": 0.000001,
      "outputPricePerToken": 0.000003
    },
    "default": {
      "inputPricePerToken": 0.000001,
      "outputPricePerToken": 0.000003
    }
  },
  "estimatedMaxTokens": 4096,
  "supportsStreaming": true,
  "streamFormat": "sse"
}
```

Always obtain pricing from the user or an authoritative upstream source. Keep a
`default` entry for unknown model names. Standard AI paths are detected by the
platform; use `tokenJsonPaths` only for a non-standard request or response:

```json
{
  "tokenJsonPaths": {
    "requestModel": "model",
    "model": "model",
    "inputTokens": "usage.prompt_tokens",
    "outputTokens": "usage.completion_tokens"
  }
}
```

`estimatedMaxTokens` controls the pre-charge hold. Choose a realistic maximum;
an excessive value can reject affordable calls, while a value below actual use
cannot cover the final charge.

## Returned items: `PER_RESOURCE`

```json
{
  "name": "Search",
  "method": "GET",
  "path": "/search",
  "billingType": "PER_RESOURCE",
  "costPerResource": 0.005,
  "resourceCountJsonPath": "data.items",
  "estimatedMaxResources": 100
}
```

The count path may resolve to an array, whose length is charged, or a numeric
count. For streamed NDJSON/SSE, the final structured chunk must expose the
count. The estimated maximum is the pre-charge cap.

After changing prices, inspect the diff before publication:

```bash
npx xapi-to provider version update \
  <service-id> <version-id> --file ./pricing.patch.json
npx xapi-to provider diff <service-id> <major>
```
