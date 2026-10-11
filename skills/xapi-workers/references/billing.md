# Consumption and reconciliation

## Read current evidence

Set the correct control-plane host first. Every query below targets one environment:

```sh
xapi workers billing prices <worker-id> --env preview --json
xapi workers billing overview <worker-id> --env preview --json
xapi workers billing usage <worker-id> --env preview
xapi workers billing ledger <worker-id> --env preview --all --json > ledger.json
xapi workers metering <worker-id> --env preview --json
xapi workers billing lifecycle <worker-id> --env preview --json
xapi workers retention show <worker-id> --env preview --format json
```

`billing-status` is platform configuration status, not an individual consumption bill. `workers usage` is a different diagnostic; it is not a replacement for complete ledger evidence. `billing prices` is the live xAPI price book: record its version and units, do not hard-code past acceptance prices.

Container Applications add four provider-metered metrics: CPU seconds, memory byte-seconds, disk byte-seconds, and egress bytes. Worker request/CPU and Durable Object charges remain separate and can appear for the same business request. Match Container ledger rows by the saved Cloudflare application ID; never attribute account-wide Container totals by image name or class name. The five-minute collector is delayed postpaid observation and does not reserve or authorize each request. A `container_location_pricing_gap` means the platform cannot yet classify an upstream location for egress pricing. CPU/memory/disk observations remain traceable; the affected entire five-minute egress bucket stays unresolved rather than being treated as free or replacing a previously complete charge with a known-location subtotal. Keep the provider coverage gap visible and do not call that window finalized. This gap does not authorize deleting a resource or changing its native configuration.

The deployment risk amount is an estimate of five-minute capacity exposure, not an accrued invoice or a minimum rental. Actual resource charges use observed buckets and their price-book snapshots; running coverage and protected retention funds are separately tracked. Missing price or egress evidence must remain visible, not be treated as zero or a user feature restriction.

`metering` is a bounded diagnostic and may return truncated facts. There is no `metering --all` command. Use supported billing usage ranges/filters and the complete ledger for reconciliation; if raw facts remain truncated, request platform-operator evidence through an available authorized interface and mark coverage incomplete. Do not invent a pagination endpoint.

## One consistent snapshot

`ledger --all` pins the first returned `snapshotTime`, preserves filters and follows all pages (up to 100 pages, normally 100 entries/page). It fails on mixed scope/snapshot, duplicate IDs, repeated/missing cursors, or the page limit rather than returning an apparently complete partial bill. `pagination.complete` means pagination completed, **not** that provider metering is complete. `--all` cannot be combined with `--cursor`.

Ledger responses may have different `snapshotId` values per page/query; fix `snapshotTime` and scope, not equality of ledger IDs. `pagination.pageSnapshotIds` retains ledger page IDs for tracing. Read `ledger.json.snapshotTime`, then query:

```sh
xapi workers billing overview <worker-id> --env preview --snapshot-time <snapshotTime> --json
xapi workers billing usage <worker-id> --env preview --snapshot-time <snapshotTime> --from <ISO-time> --to <ISO-time> --json
```

`billing usage` follows all aggregate pages automatically in both normal human
output and JSON, without `--all` or an opt-in mode. It pins the first usage
`snapshotId`, `snapshotTime`, range and filters, rejects changed scope, repeated
cursors or duplicate bucket/resource/metric groups, and fails on cancellation or
read errors instead of presenting a partial read as complete. Usage snapshot IDs
are stable within that continuation; the ledger rule above is separate.

Read `buckets[].summaries` and the backend's `totals`. Totals describe the whole
scope and repeat on every page: use them once, never add page totals or sum raw
`facts` as a substitute. Quantities and event counts are exact strings, shown
without floating-point conversion. Keep metrics/units separate. `EVENT_SUM`
represents independent selected events; `CUMULATIVE_LATEST` is the latest selected
revision, not a second event to add. `UNRESOLVED` and null quantities remain unknown.
An observed CPU quantity `0` remains an observed zero, not proof of zero cost.

Coverage and UTC cutoff are independent of quantity and pagination. For example,
117 observed Tail events can have `INDETERMINATE` coverage and
`completeThrough: null`; finalized events do not prove a complete window.
The compatibility `facts` arrays are empty on the new usage API. Raw samples stay
in the existing bounded metering diagnostic. On an older backend, the CLI displays
legacy observations and marks aggregate totals/coverage unavailable; it does not
invent totals or a complete cutoff. Money still comes from overview/ledger.

Ledger/overview cover the snapshot's UTC billing day, not all history. Respect returned `rangeMetadata` and freshness. For historical days select the required supported snapshot; do not assume old snapshots remain queryable forever. For a ledger over the CLI page limit, manually page `--limit 100 --cursor <opaque-cursor> --snapshot-time <same-time>`, preserving `--metric`/`--resource-id`; verify unique IDs and `hasMore: false`. Never decode or synthesize cursors.

Compare only the same host, Worker, environment, UTC day and filter scope. A resource-filtered ledger cannot equal a whole-environment overview. Keep decimal strings exact; use decimal arithmetic or integer minor units at the API's declared precision, not binary floating point. Preserve negative adjustments and entry funding classifications. For quantities, follow `adjustsEntryId` revision chains and metric semantics; do not sum successive cumulative observations as independent operations. For money, retain signed deltas. Preserve each entry's historical price version rather than repricing old usage with today's book. Sum comparable customer charges against `customerAccruedUsd`, and ledger net against `ledgerNetUsd`; don't count freeze/release transfers as consumption. If classification is missing, report the funding split unknown.

## Interpret money correctly

- `customerAccruedUsd`: net accrued xAPI customer charges. This is not the final Cloudflare invoice.
- `platformRiskUsd`: platform-funded amount; don't add it to customer spending.
- `settledUsd`: compatibility field; do not infer final provider settlement from the name.
- Frozen retention funds are still the user's money. Freeze/release and request reservations are not new consumption charges.
- `null`, absent observations, PARTIAL/INDETERMINATE, gaps and collector errors mean incomplete evidence. `$0` only means a measured/reported zero within that scope.
- Storage is capacity over time. A write event isn't a complete storage-day bill. Verify collector coverage, applicable date/price, day-finalization status and late-data adjustment/idempotency; merely waiting 24 hours proves nothing if collection or sealing is disabled.
- Unknown R2 actions need explicit classification. Never default all unknown operations to free or Class A. A user-approved provisional xAPI waiver for one named operation does not establish Cloudflare's official price, and does not cover Queue deliveries triggered by notifications or other API actions.
- Provider free allowances, subscriptions and shared infrastructure costs require separate provider evidence. A zero account invoice under a free allowance does not prove an operation is intrinsically free.

## Delayed observations are not a confirmed collection defect

A five-minute collection schedule is not a promise that Cloudflare will expose all usage within five minutes. An empty result, `lastSuccessfulAt`, and a cursor watermark prove different things: a successful query can return no observations, and a watermark alone does not prove that all usage before it is available. `lastObservedAt` describes the latest observed usage bucket; for an idle resource, its age alone is not proof of a stalled collector.

If a known operation is absent, preserve its resource identity and time window, then take a later bounded snapshot. Compare the same resource, dataset, window, and latest revisions. If facts subsequently arrive, check that the ledger charges only the change in cumulative usage and keeps the original price snapshot. Do not count old and revised quantities as separate operations, force a new deployment, change prices, or restart resources just to make a bill appear. Stop polling at the stated observation deadline and report the missing evidence; do not claim free usage or a collection bug without matching query/response evidence.

For a real discrepancy, give the operator the exact resource/window and sanitized cursor/error metadata. Distinguish a provider data delay, a query/identity mismatch, a mapping failure, and a settlement failure before proposing a fix. Never promise a universal provider reporting delay based on one test.

## Real cost experiment

Capture baseline snapshot and full ledger. Perform a bounded, named business operation; record request/job/object IDs and UTC times. Poll collection within a bounded window and capture a second full ledger plus same-snapshot overview. Identify new and adjusted entries, rather than subtracting rounded UI totals. Account for background jobs, retries, asynchronous CPU and delayed storage facts. If crossing UTC midnight, reconcile each day separately.

Report: observed operation counts; customer charge; platform-funded cost; reservation changes; unknown/missing metrics; whether storage day and provider invoice are finalized. Attach sanitized raw responses. Don't claim an exact per-operation price when background traffic or delayed attribution prevents it.

## Protected retention funds and operating reserves

Both Preview and Production prepare a conservative seven-day retention quote, using the existing twofold cushion: `(daily reference cost × 7 + cleanup allowance) × 2`, rounded upward to cents. Frozen funds remain user money, not consumption. Protected retention funds cover overdue preservation and cleanup; ordinary operating charges use their operating reserve and available account balance. They do not consume the protected retention hold.

After entering retention, at least 168 full hours are protected. An estimate shortfall during that guarantee is recorded as platform risk, not grounds for early deletion. After the minimum, resources remain preserved while spendable retention funds remain; system cleanup begins only after exhaustion. Cleanup allowance is separate from spendable preservation funds.

System funding protection suspends business execution. Non-null lifecycle `retentionStartedAt` identifies financial retention and blocks user writes, including deployments, Secrets, domains, resource deletion and configuration changes. Read status/billing, add funds, then explicitly use `xapi workers retention resume <worker-id> --env preview` (or production) when the user wants recovery. The server checks and replenishes required funding atomically; recharge alone does not clear retention or restart the application. `worker_retention_funding_required` means this recovery is required, not that the CF resource disappeared. System metering, suspension and eventual cleanup continue. A separate selectable environment and other Workers are not account-wide locked; shared Worker uploads/builds or whole-Worker deletion cannot bypass a retained environment.

Historical holds and running-deposit receipts keep their original identities, amounts and pricing snapshots. Previously created unified deposits are not rewritten into retention funds. Missing protected funding is accounted for explicitly and prepared on the next owner-requested resource/deployment operation; do not silently freeze every legacy account in a background migration. Ordinary operations need no additional retention-product choice or user feature whitelist. Read the server quote and the resulting fund transfers; operating and retention amounts remain separately traceable even when shown together.

Deleting and immediately creating a replacement does not require waiting for the old operating tail window. Original expenses retain their resource identity and time window, and cannot consume a replacement's protected retention funds. Release is tied to confirmed native deletion and actual finalization, not an API visibility 404 or a manual clock override.

System funding suspension and cached admission: after completed suspension, the platform publishes a denied state. Edge cache propagation can still deliver a request to the platform pause runtime. Such execution is recorded with actual native usage and `PLATFORM_PAUSED` provenance, with zero user charge when immutable lifecycle history places both admission and native execution inside the paused interval. Delayed delivery after recovery uses that historical interval; an ordinary application returning HTTP 503 remains billable. This does not waive storage or retention charges.

A DO class deletion uses its finalized, owner-bound class migration journal to close resource running funds. Missing storage sampling remains a metering gap, never assumed zero. The running tail retains its 48-hour deadline; resource deletion does not refund outstanding running funds early.

An explicit upstream metering rate limit ends that collection pass; unvisited cursors stay unchanged and collection resumes on the normal schedule. Missing facts are not billed as zero or treated as a user permission failure. This introduces no user request/resource quota. Current lifecycle status reports 168-hour protection for both environments; inspect each episode's actual minimum date and remaining funds rather than interpreting seven days as a fixed deletion date.

Confirmed deletion and cached admission: if both admission time and native execution-start time are at or after the immutable DELETED event, preserve actual request/CPU usage but charge the user zero, with PLATFORM_DELETED and the lifecycle event ID in the receipt/ledger. A request admitted before deletion remains billable even if its Tail arrives later; resource/storage charges keep their existing rules. Historical incorrect charges are corrected by append-only refund entries linked to the original charges, never by rewriting receipts or deleting usage.
## R2 deletion and late events

An R2 bucket's confirmed native absence can close its running reserve even when its storage sample remains a GAP. xAPI retains the original 48-hour tail and the capture queue/source to reconcile late events; a GAP is not zero usage. Native bucket deletion, invocation charges, storage-day finalization, retained capture-queue cleanup and the final provider invoice are separate outcomes.
