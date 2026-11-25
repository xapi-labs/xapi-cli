# AI interfaces, models and pricing

Choose protocol and billing mode independently. Standard paths identify the
wire protocol; they do not choose prices or turn DYNAMIC into PER_TOKEN.
For outbound transport, read [HTTP transport](http-transport.md).

| Interface | Standard paths | Token usage preset |
|---|---|---|
| OpenAI chat | `/v1/chat/completions` | `usage.prompt_tokens`, `usage.completion_tokens` |
| Claude | `/v1/messages`, `/messages` | `usage.input_tokens`, `usage.output_tokens` |
| Responses | `/v1/responses`, `/responses` | `usage.input_tokens`, `usage.output_tokens` |
| Embeddings | `/v1/embeddings`, `/embeddings` | `usage.prompt_tokens` |
| Decisions | `/v1/decisions`, `/decisions`, stored `{{alpha}}/decisions` | `usage.input_tokens`, `usage.output_tokens` |

The backend computes detection and raw-to-Canonical mappings. Do not invent a
Canonical ID or submit `aiSpecDetectedBy: "path"` as proof of trust. Inspect
the saved association before publication. Shared Gateway routing needs a
compatible, trusted, public serving endpoint and a resolved Canonical mapping.

## Declare models for the billing mode

- **PER_TOKEN:** model keys in `tokenPricing` declare models and rates;
  `servedModels` does not replace pricing. Obtain approved USD-per-token rates
  from the user or authoritative upstream source. A `default` rate is a pricing
  fallback, not proof that every unknown model is supported; use an agreed rate.
- **DYNAMIC / PER_CALL / PER_RESOURCE AI:** declare upstream names in
  `servedModels`; the backend derives `aiModelMappings`. DYNAMIC charges come
  from `dynamicRules`, not `tokenPricing`. Drafts can be incomplete; submission
  enforces the applicable served-model requirement.

Scoped `provider create` and `provider version update` accept `servedModels`
on endpoint DTOs. The one-shot `provider import` OpenAPI flow has no served-model
extension; configure the draft afterward with a scoped endpoint payload.
See [billing modes](billing-modes.md).

Use [the AI template](../templates/ai-model.json) for PER_TOKEN chat. Replace
illustrative models and prices before creation. Tiered, cached, reasoning or
multimodal rates must follow the supported pricing contract; do not flatten them
without the user's agreement.

Recognized protocols use built-in token presets. Non-standard paths or usage
need explicit `tokenJsonPaths`. For SSE/NDJSON, verify final usage extraction;
missing usage can settle against the configured estimate. Decisions has no SSE.

## Decisions provider configuration

Decisions uses `model`, `state` and named `questions`, returning typed `answers`.
It is separate from chat, with no chat translation or streaming. Consumer
examples and discovery are in the [Gateway guide](../../xapi/guides/ai_gateway.md#decisions).

For OpenRouter, preserve stored `{{alpha}}/decisions` and named alpha base
`https://openrouter.ai/api/alpha`. Public consumers use `/decisions`.
Replacing the stored path loses named-base selection. For cost passthrough,
retain the existing `usage.cost` rule, multiplier, hold estimate and caps;
do not add token prices merely because usage includes token counts.

For a model-only PATCH, take the endpoint ID from the working copy:

```json
{
  "endpoints": [{
    "id": "<working-endpoint-id>",
    "servedModels": ["typesafe/jev-1.14"]
  }]
}
```

```bash
npx xapi-to provider revision start <service-id> <major>
npx xapi-to provider version update \
  <service-id> <working-revision-id> --file ./models.patch.json
npx xapi-to provider diff <service-id> <major>
```

This replaces that endpoint's declared model list. Preserve all models that
should remain supported. PATCH leaves omitted fields intact; do not use
`--replace` for this partial file. Submission is separate and may automatically
publish after review; follow [lifecycle management](lifecycle-management.md).
Check that the existing Decisions configuration has `supportsStreaming: false`;
this model-only patch does not change it or other billing/transport fields.

## Variants, reference prices and receipts

Canonical identity, upstream name and wire protocol are separate: `jev-1-14`
can map to `typesafe/jev-1.14` on a Decisions endpoint. A moving `latest`
identity must not be silently pinned to a fixed version.

Preserve complete variants. OpenRouter `:free` needs a free mapping and must
never fall back to the paid base. `:batch` is unsupported by the synchronous
Decisions Gateway. Discover current models rather than copying a fixed count.

Eligible serving OpenRouter Decisions endpoints may expose response-only
`modelQuotes`: USD-per-million-token estimates derived from Canonical reference
prices and this endpoint's simple cost-passthrough multiplier. These are not
`tokenPricing` and do not settle DYNAMIC calls. Other variants cannot borrow
base rates. Explicit free quotes are zero only when the rule can be safely
quoted; complex rules, including caps/clamps, remain unknown. Missing/null
means unknown; `0` means an explicit zero rate. Keep billing limits intact.

After an authorized canary, verify actual cost, model/Canonical attribution and
final accounting. Where the response exposes an xAPI receipt request ID:

```bash
npx xapi-to usage wait <request-id> --timeout 1m
```

The AI Gateway currently does not expose a reliable receipt request ID. Its
`X-XAPI-Cost` aggregates attempts; the final provider's `usage.cost` or response
`id` is not an aggregate xAPI receipt. Do not claim reconciliation from them.
