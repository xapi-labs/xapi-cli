# AI services and model pricing

Create AI services with the same provider CLI workflow as other services. The
endpoint path helps xAPI identify standard interfaces such as OpenAI chat,
Responses, embeddings, images, Claude messages, and Gemini. Keep standard paths
when the upstream is compatible; non-standard paths usually require explicit
`tokenJsonPaths`.

Before writing the contract, establish:

1. the upstream public base URL and authentication type;
2. the supported model names;
3. input and output USD price per token for each model;
4. the largest allowed request/output so `estimatedMaxTokens` is realistic;
5. whether streaming responses contain final usage.

Use [`templates/ai-model.json`](../templates/ai-model.json) as a starting point:

```bash
npx xapi-to provider create --file ./ai-service.json
npx xapi-to provider versions <service-id>
```

For multi-model services, include a `default` price and optional
`servedModels`. Do not invent pricing. If the upstream has tiered, cached,
reasoning, audio, image, or tool-call pricing, represent it in `tokenPricing`
instead of flattening it without the user's agreement.

For SSE, request upstream usage in the terminal event when its protocol
supports that option. For NDJSON, place usage in the last JSON line. If final
usage cannot be extracted, the platform may charge the configured maximum.

Use a version patch for model or pricing updates:

```bash
npx xapi-to provider revision start <service-id> <major>
npx xapi-to provider version update \
  <service-id> <working-version-id> --file ./models.patch.json
npx xapi-to provider diff <service-id> <major>
npx xapi-to provider publish \
  <service-id> <revision-id> --changelog "Update model catalog and pricing"
```

After a canary call, use its request ID to wait for finalized accounting:

```bash
npx xapi-to usage wait <request-id> --timeout 1m
```
