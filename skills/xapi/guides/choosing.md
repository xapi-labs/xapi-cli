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
billing type, P50, 30-day upstream success and 30-day calls. Twitter search
filters (including `count`) and provider-specific cursors constrain failover;
see the [Twitter guide](twitter.md#search-tweets).

## Tags and categories

On updated backends, `meta.provider_tags` contains provider-authored labels
and `meta.platform_tags` contains platform-derived tags. The legacy `meta.tags`
merges both for compatibility. Older provider labels such as `stable`, `fast`
or `free` can remain visible without earning that platform classification;
new provider writes reject all eight platform tag names listed below. Use
`platform_tags` and the underlying pricing/stats when evaluating those claims.
If the separate fields are absent on an older backend, use pricing and stats
rather than treating merged tags as evidence.

Platform tags include `free`, `per-token`, `streaming`, `async`, and from the
30-day stats `stable` (upstream success ≥ 99%), `fast` (P50 under 500 ms),
`popular` or `low-sample` (under 100 calls, too few to judge).
`meta.category_label` gives the category's English and Chinese names.

Search matches provider labels and category names too. Standalone reserved
terms `stable`, `fast`, `popular`, `low-sample`, `free`, `per-token`, `streaming`
and `async` require every requested term to appear in `meta.platform_tags`.
For example, `search "twitter stable"` excludes a service whose provider merely
claims `stable`. `search 社交` matches a category alias. `--category` accepts a
category's id, alias or name in either language, in any case
(`--category social`, `--category 天气`).

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
