# Choosing a service and reading its cost

How to pick between services that do the same job, and how to tell what a call
cost. Both rely on fields that `search`, `list`, `get` and `call` return.

## Choosing between similar services

Several services can do the same job (the marketplace has eight X/Twitter
data services, for example). Choose with the data each result carries, not by
taking the first hit:

1. Prefer a built-in capability (`source: capability`, such as `twitter.*`,
   `crypto.*` or `web.search`) when it covers the task. Its input and output
   are normalized, and `twitter.*` fails over to its second route when
   `provider` is omitted.
2. Otherwise compare the candidates, in this order:
   - `stats.upstream_success_rate`: the share of the last 30 days' calls that
     did not fail for upstream reasons (provider reliability).
     `stats.success_rate` also counts callers' own mistakes.
   - Price: `meta.pricing.listed_price` per call, or `meta.pricing.models`
     (USD per million tokens) for token billing. For a capability,
     `meta.pricing.variants` prices each `provider` route and `listed_price`
     is the default route's price.
   - Latency: `stats.p50_ms` and `stats.p95_ms`.
3. `stats` is service-level history over a 30-day window, not live health.
   Very few `calls` means too little traffic to judge, not a bad service;
   a null rate means no data, never 0%.
4. When the user names a service or provider, use it. Data breaks ties; it
   does not override an explicit choice.

`search --format table` shows these columns side by side: service, price,
billing type, P50, 30-day upstream success and 30-day calls.

## What a call cost

A JSON call's envelope carries `billing`:

- `cost_usd`: the total for this call, across every upstream request it made
  (a capability that failed over to its second route made two).
- `cost_status`: `charged` (final), `reserved` (held until async or streamed
  work settles), `estimated` or `simulated`.
- `upstream_calls` and `request_ids`: pass a request ID to
  `npx xapi-to usage <request-id>` (or `usage wait`) for its receipt.

A call rejected before reaching any upstream has no `billing`. Raw and
streamed calls report the same in the `X-XAPI-Cost` and
`X-XAPI-Request-Ids` headers and the final `xapi.usage` SSE event.
