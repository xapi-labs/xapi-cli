# CLI provider validation checklist

Apply this checklist to the JSON file before `provider create`, to a full file
before `provider version update --replace`, and again before publication.

## Service

- `name` is non-empty and `authType` is one of `NONE`, `HEADER`, `BEARER`, or
  `QUERY`.
- `host`, if supplied, normalizes to a lowercase DNS label and is not a reserved
  platform name.
- `category` uses a platform category such as `Public-Utils`, `AI-Models`,
  `Social`, `Data-Analysis`, or `Crypto`.
- `accessMode` is `PROXY` or `DIRECT`. Use `PROXY` for gateway billing,
  observability, or service rate limiting.
- `baseUrl` and named `baseUrls` are public HTTP(S) URLs. A pure WebSocket
  service may omit `baseUrl`.
- Real upstream secrets appear only in `privateHeaders`.

## Endpoints

- Every new endpoint has `name`, `method`, and `path`.
- Existing endpoint patches use the ID from the working revision. The backend
  can also match a stable method/path through its derived endpoint key; missing
  `id` does not always mean new. Preserve the stored `endpointKey` across
  revisions and use the working ID when changing a path; inspect the diff for
  unintended additions or removals.
- Path parameters use `:name` and have matching `pathParams` descriptions.
- Billing fields match the chosen `billingType`; pre-charge estimates are
  realistic.
- Streaming endpoints set both `supportsStreaming` and `streamFormat`.
- AI billing and protocol are chosen independently: PER_TOKEN uses model keys
  in `tokenPricing`; DYNAMIC/PER_CALL/PER_RESOURCE AI uses `servedModels`.
  Confirm saved Canonical mappings and detection rather than claiming trust
  with provider-supplied `aiSpecDetectedBy`.
- Decisions retains `state` and named typed `questions`, sets
  `supportsStreaming: false`, and preserves DYNAMIC rules and model variants.
  `:free` must not route to a paid base; `:batch` is not synchronous Decisions.
- HTTP/2 uses numeric `info.x-xapi-upstream-http-version: 2` in `openApiSpec`,
  HTTPS default/named bases and a compatible deployed runtime. Review whole-spec
  replacement/clear semantics and the independent xhub manifest string option
  in [HTTP transport](http-transport.md).
- WebSocket endpoints set `protocol: "WEBSOCKET"`, a supported adapter, a
  public `wsConfig.upstreamUrl`, and a valid `wsBilling` object.
- OAuth user-context endpoints retain their approved `userOAuthProviderId`.

## Before create or update

Parse the file locally and inspect the exact command:

```bash
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' ./service.json
npx xapi-to provider --help
```

Then run the relevant write once. If a non-idempotent write has an ambiguous
transport result, use `provider get`, `versions`, `diff`, or `review` to resolve
state before retrying.

## Before publish

```bash
npx xapi-to provider get <service-id>
npx xapi-to provider versions <service-id>
npx xapi-to provider diff <service-id> <major>
```

Confirm there is at least one endpoint, required upstream URLs are present,
prices and auth types are correct, no secrets appear in public metadata, and
the changelog describes the public contract change. After publish, inspect both
`review` and `versions` before reporting success.
