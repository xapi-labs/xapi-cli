# Choosing an Action and interpreting execution feedback

These contracts describe the current source changes, not a deployed backend,
MCP service or npm release. Inspect the live search response's `ranking_version`
and the actual returned fields. Older deployments may omit review or rate-limit
metadata; missing evidence means unknown.

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
| `reviewed_at` | Review timestamp or `null` |

The automated verdict is evidence from the automated checks; a later validator,
human decision or override can produce a different final status. For example,
`PASS` does not turn `approved_pending_review` into `approved`. `whitelist` and
`skipped` do not prove tests ran. An approved revision can still be unsuitable
for the task or have poor observed upstream reliability.

Do not infer review approval from `source: capability`, `source: api`, a service
name, a legacy `stable` status or missing fields. Treat `unknown`/missing review
as missing evidence, and inspect the returned revision and review facts when
review status matters to the user's choice.

## Rate-limit feedback and retry decisions

Execution envelopes may include `rate_limit` with `limit`, `remaining`,
`reset_at` and optional `retry_after_seconds`. A supporting HTTP response can
also expose the wait hint through `Retry-After`. Inspect that feedback instead
of immediately repeating a request. A `user_service` policy is shared across
the user's API keys and the service's endpoints; rotating keys or selecting a
different endpoint does not create a fresh quota.

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
