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

Always obtain pricing from the user or an authoritative upstream source. Use an
agreed `default` rate if a pricing fallback is needed; it does not declare every
unknown model routable. Standard AI paths are detected by the
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

## Response-derived rules: `DYNAMIC`

Use DYNAMIC for a response-cost rule or other supported field-based pricing.
AI protocols and token counts do not force PER_TOKEN. A DYNAMIC AI endpoint
declares `servedModels`; its rates and hold estimate live in `dynamicRules`.
The backend derives the protocol/model association from the saved endpoint.

This illustrative Decisions endpoint settles upstream `usage.cost × 1.2`:

```json
{
  "name": "Decisions",
  "method": "POST",
  "path": "/v1/decisions",
  "billingType": "DYNAMIC",
  "servedModels": ["typesafe/jev-1.14"],
  "supportsStreaming": false,
  "dynamicRules": {
    "version": 2,
    "fields": [{
      "name": "cost", "source": "response.body", "path": "usage.cost",
      "type": "number", "estimatedMax": 0.1, "clamp": {"min": 0}
    }],
    "rules": [{
      "then": {"operands": [{"factors": [
        {"kind": "number", "field": "cost"},
        {"kind": "const", "value": 1.2}
      ]}]}
    }],
    "minCost": 0,
    "maxCost": 10
  }
}
```

Choose the actual multiplier, estimate and caps with the user; these numbers
are not a universal fee schedule. The estimate can hold funds before the real
response arrives (here 0.1 × 1.2 = USD 0.12). Final consumption follows the
configured rules and actual billing evidence. Missing/invalid evidence is not
proof of zero cost; inspect finalized accounting instead of calculating a refund
from missing usage. Preserve existing rules on a model-only update.

For OpenRouter's existing endpoint, preserve `{{alpha}}/decisions` and its
named alpha base rather than copying this example's path. Decisions is a
single non-streaming request; do not enable SSE or `:batch` to test this rule.

Reference quotes are display-only. A simple recognized passthrough can derive
USD/1M-token estimates; rules with caps/clamps, including this example, remain
unknown. Unknown/null is distinct from zero. OpenRouter `:free` must retain the
exact free mapping; never borrow the paid base's price or use it as fallback.
See [AI models](ai-spec-and-models.md) for variants and quote boundaries.

## Accounting after execution

Estimates/reservations are not actual consumption. Check the actual USD cost,
finalized receipt where an xAPI request ID is available, and released holds.
An upstream response ID is not an xAPI receipt ID. Gateway costs aggregate
attempts, so final upstream `usage.cost` or a single attempt receipt cannot
reconcile the whole request. See the [Gateway billing headers](../../xapi/guides/ai_gateway.md#routing-and-billing-headers).

After changing prices, inspect the diff before publication:

```bash
npx xapi-to provider version update \
  <service-id> <version-id> --file ./pricing.patch.json
npx xapi-to provider diff <service-id> <major>
```
