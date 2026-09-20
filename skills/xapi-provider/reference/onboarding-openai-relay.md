# OpenAI-compatible relay onboarding

Use this workflow when the upstream is a New API, One API, or another
OpenAI-compatible relay with a model catalog.

First obtain the relay's public base URL, authentication value, model list, and
authoritative pricing from the user or the relay's documented discovery
interface. Do not copy stale pricing from examples and do not probe an
undocumented administrative endpoint.

Build one CLI create file containing:

- `authType: "BEARER"` and the secret in `privateHeaders`;
- the public relay URL in `baseUrl`;
- standard paths such as `/v1/chat/completions`, `/v1/responses`, and
  `/v1/embeddings` only when the relay supports them;
- one `PER_TOKEN` endpoint contract per supported interface;
- the upstream model names in `servedModels` and their prices in
  `tokenPricing`, including `default`;
- streaming fields only for interfaces that return final usage correctly.

Start from [`../templates/ai-model.json`](../templates/ai-model.json), then run:

```bash
npx xapi-to provider create --file ./relay-service.json
npx xapi-to provider get <service-id>
npx xapi-to provider versions <service-id>
npx xapi-to provider diff <service-id> 1
```

If the relay quotes ratios or internal quota units, preserve the source values
and conversion assumptions while calculating USD/token. Ask the user to confirm
the resulting prices before publishing. A later model-catalog refresh is a
version update, followed by diff, publish, and review commands.
