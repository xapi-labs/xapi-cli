# Consumption and reconciliation

## Read current evidence

Set the correct control-plane host first. Every query below targets one environment:

```sh
xapi workers billing prices <worker-id> --env preview --json
xapi workers billing overview <worker-id> --env preview --json
xapi workers billing ledger <worker-id> --env preview --all --json > ledger.json
xapi workers metering <worker-id> --env preview --json
xapi workers billing lifecycle <worker-id> --env preview --json
xapi workers retention show <worker-id> --env preview --format json
```

`billing-status` is platform configuration status, not an individual consumption bill. `workers usage` is a different diagnostic; it is not a replacement for complete ledger evidence. `billing prices` is the live xAPI price book: record its version and units, do not hard-code past acceptance prices.

Container Applications add four provider-metered metrics: CPU seconds, memory byte-seconds, disk byte-seconds, and egress bytes. Worker request/CPU and Durable Object charges remain separate and can appear for the same business request. Match Container ledger rows by the saved Cloudflare application ID; never attribute account-wide Container totals by image name or class name. The five-minute collector is delayed postpaid observation and does not reserve or authorize each request.

`metering` is a bounded diagnostic and may return truncated facts. There is no `metering --all` command. Use supported billing usage ranges/filters and the complete ledger for reconciliation; if raw facts remain truncated, request platform-operator evidence through an available authorized interface and mark coverage incomplete. Do not invent a pagination endpoint.

## One consistent snapshot

`ledger --all` pins the first returned `snapshotTime`, preserves filters and follows all pages (up to 100 pages, normally 100 entries/page). It fails on mixed scope/snapshot, duplicate IDs, repeated/missing cursors, or the page limit rather than returning an apparently complete partial bill. `pagination.complete` means pagination completed, **not** that provider metering is complete. `--all` cannot be combined with `--cursor`.

Responses may have different `snapshotId` values per page/query; fix `snapshotTime` and scope, not equality of IDs. `pagination.pageSnapshotIds` retains the page IDs for tracing. Read `ledger.json.snapshotTime`, then query:

```sh
xapi workers billing overview <worker-id> --env preview --snapshot-time <snapshotTime> --json
xapi workers billing usage <worker-id> --env preview --snapshot-time <snapshotTime> --from <ISO-time> --to <ISO-time> --json
```

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

## Real cost experiment

Capture baseline snapshot and full ledger. Perform a bounded, named business operation; record request/job/object IDs and UTC times. Poll collection within a bounded window and capture a second full ledger plus same-snapshot overview. Identify new and adjusted entries, rather than subtracting rounded UI totals. Account for background jobs, retries, asynchronous CPU and delayed storage facts. If crossing UTC midnight, reconcile each day separately.

Report: observed operation counts; customer charge; platform-funded cost; reservation changes; unknown/missing metrics; whether storage day and provider invoice are finalized. Attach sanitized raw responses. Don't claim an exact per-operation price when background traffic or delayed attribution prevents it.
