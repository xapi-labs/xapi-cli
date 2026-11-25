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
merges both for compatibility. A provider label such as `stable`, `fast` or
`free` carries no platform classification. Use `platform_tags` and the
underlying pricing/stats when evaluating those claims.
If the separate fields are absent on an older backend, use pricing and stats
rather than treating merged tags as evidence.

Platform tags include `free`, `per-token`, `streaming`, `async`, and from the
30-day stats `stable` (upstream success ≥ 99%), `fast` (P50 under 500 ms),
`popular` or `low-sample` (under 100 calls, too few to judge).
`meta.category_label` gives the category's English and Chinese names.

Search matches provider labels and category names too. Terms such as `fast`
or `free` can match text as well as computed tags. Check `meta.platform_tags`
and pricing before treating a search result as fast or free. `search 社交`
matches a category alias. `--category` accepts a
category's id, alias or name in either language, in any case
(`--category social`, `--category 天气`).

## What a call cost

A JSON call's envelope carries `billing`:

- `cost_usd`: the sum across upstream requests when one cost state is known;
  `null` when states are mixed or the cost is unknown.
- `cost_status`: `charged` (final), `reserved` (held until async or streamed
  work settles), `estimated`, `simulated`, `mixed` or `unknown`.
- Mixed responses include `cost_breakdown_usd` with each known state and amount.
  States can overlap for one upstream request: do not add reservations, estimates
  or simulations to settled charges. Inspect the individual receipts instead.
- `upstream_calls` and `request_ids`: pass a request ID to
  `npx xapi-to usage <request-id>` (or `usage wait`) for its receipt.

A call rejected before reaching any upstream has no `billing`. Raw and streamed
calls expose known states through `X-XAPI-Cost`, `X-XAPI-Cost-Reserved`,
`X-XAPI-Cost-Estimated` and `X-XAPI-Cost-Simulated`, plus receipt IDs through
`X-XAPI-Request-Ids` and usage metadata in the final `xapi.usage` SSE event.

## Relevance and observed quality

Discover candidates with `search`, then inspect their schema with `get` or
`get-batch`. Keep an explicit user choice and an exact matching Action ID ahead
of generic alternatives. Compare supported inputs, response contracts, current
pricing and the user's required behavior before executing.

Search supports `--sort default|relevance|price`. Ranking version 2 adds quality
ordering to `default` only among equally relevant API results. Keyword coverage,
match quality, exact-ID guards and capability recommendation priority remain
in force. API quality cannot promote an unrelated result over a stronger match.

A quality comparison needs at least 100 provider samples and known upstream
success rate. It first compares success rate in one-percentage-point buckets,
then fresh, positive P50 latency in 100 ms buckets. Call volume determines sample
sufficiency; larger volume earns no extra ranking boost. Missing/low-sample
results retain their existing slots. Missing latency does not erase a known
success rate. Quality evidence is service-level and is not presented as measured
statistics for each endpoint. Unknown statistics must not be interpreted as zero
or as proof of reliability.

`relevance` remains source-neutral text ranking. `price` keeps match guards and
orders comparable fixed per-call USD prices; dynamic, token, resource and unknown
prices are not zero-price alternatives. All modes rank before pagination.
The CLI accepts a numeric `ranking_version` rather than assuming version 1.

## Review evidence is separate from source

Supporting responses expose `meta.review` in Action discovery/details and
execution metadata. Its fields are:

| Field | Values |
| --- | --- |
| `status` | `unknown`, `pending`, `approved`, `approved_pending_review`, `rejected` |
| `method` | `unknown`, `automated`, `human`, `whitelist`, `skipped` |
| `automated_verdict` | `PASS`, `PASS_WITH_REVIEW`, `FAIL`, `UNCERTAIN`, or `null` |
| `revision_id` | Optional revision ID tying the evidence to a contract |
| `record_updated_at` | Review record's last update timestamp or `null`; not a test-call or human-decision timestamp |

The automated verdict is evidence from the automated checks; a later validator,
human decision or override can produce a different final status. For example,
`PASS` does not turn `approved_pending_review` into `approved`. `whitelist` and
`skipped` do not prove tests ran. An approved revision can still be unsuitable
for the task or have poor observed upstream reliability.

Execution review metadata describes the selected revision; it is not an upstream
execution receipt or proof that this particular call was tested.

Do not infer review approval from `source: capability`, `source: api`, a service
name, a legacy `stable` status or missing fields. Treat `unknown`/missing review
as missing evidence, and inspect the returned revision and review facts when
review status matters to the user's choice.

## Rate-limit feedback and retry decisions

Action execution envelopes may include `rate_limit` with `limit`, `remaining`,
`reset_at` and optional `retry_after_seconds`. Service quota errors carry
`error.retry_after_seconds`; a quota rejection for free API sandbox calls uses
flat `retry_after_seconds` plus `rate_limit_buckets` (`creator_minute`,
`creator_daily`, `api_key_daily`). Inspect the actual error body, including any
outer Action envelope, instead of assuming one field location for all routes.

Supporting HTTP Gateway routes expose a matching `Retry-After` header. Other
transports do not promise that header; use returned JSON where available.
Inspect that feedback instead of immediately repeating a request. A
`user_service` policy is shared across the user's API keys and the service's
endpoints; rotating keys or selecting a different endpoint does not create a
fresh quota.

A retry hint supplies timing, not permission to replay a call. Arbitrary Action
execution is sent once, even when the selected Action method is GET. A timeout,
lost connection, non-JSON response or 5xx can follow a completed upstream write
or charge. Inspect the existing task or request receipt where available before
deciding whether another execution is appropriate. CLI metadata reads retain
their bounded retry behavior.

For a large execution result, `call --output-json result.json` retains the full
response, including review, quota, billing and request-ID fields that were
actually returned, and prints a short file receipt. JSON failures are retained
but exit nonzero; read the saved file locally rather than executing again to
recover omitted data. A failed save does not prove the Action failed.

## Large JSON results

For large JSON results, add `--output-json result.json` to `call`. It creates a
new private file before one execution, saves the complete response envelope
(including data, billing and request IDs), and prints only `{success, output,
bytes}`. It never overwrites or retries execution. Read the file locally;
do not call again just to recover data omitted from the receipt. JSON HTTP or
business errors are saved but exit nonzero; incomplete/non-JSON saves are
removed only while the path still identifies this command's file. Replacements
are preserved; changed paths fail. Keep the output directory stable. A save
failure does not prove the action failed. This flag conflicts with `--output`,
`--stream` and `--code`; default JSON stdout stays unchanged.
