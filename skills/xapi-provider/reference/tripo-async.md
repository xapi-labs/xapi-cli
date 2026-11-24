# Tripo asynchronous model tasks

This workflow requires a backend containing the Tripo v3 adapter and migration
`20261015000000_tripo_durable_finalization`. Check the actual deployed backend;
installing this CLI or skill does not deploy the adapter or publish a service.
The backend candidate is tracked by KANBY-108. It connects directly to
`https://openapi.tripo3d.ai`; xhub and the separate China origin are not used.

## Draft configuration

Use the ordinary [provider lifecycle](lifecycle-management.md) and
[authentication](auth-types.md) workflow. Store the upstream Bearer credential
in a private contract file and use `npx xapi-to provider create --file` or a
working revision update. Never echo or commit the credential. Publishing can
switch the serving revision; keep the service private during acceptance.

The adapter supports five POST operations:

- `/v3/generation/text-to-model`
- `/v3/generation/image-to-model`
- `/v3/generation/multiview-to-model`
- `/v3/models/texture`
- `/v3/models/convert`

Each endpoint requires `asyncMode: "REQUIRED"`,
`taskStrategy: "UPSTREAM_POLLING"`, `upstreamProvider: "tripo"`, and
`billingType: "DYNAMIC"`. Use the deployed backend's `TRIPO_MODEL_DYNAMIC_RULES`
as the full dynamic rule object; the symbol name is not a JSON value to send.
Confirm the USD-per-credit factor and the endpoint's hold estimate with the
provider. A hold estimate is not a spending cap. Do not use PER_TOKEN or infer
zero cost when the upstream omits its final credit count.

The ordinary HTTP transport selector is described in
[HTTP transport](http-transport.md). Queued tasks freeze their transport and
credential configuration. Raw gateway requests do not execute the registered
provider JSON Schema; validate model/option combinations before a paid call.

## Ownership and results

Submission returns HTTP 202 with an **xAPI task UUID** and `poll_url`.
Query that URL with the caller's xAPI key. The worker separately polls Tripo;
callers must not substitute the supplier task ID for the xAPI task ID.
Successful inline JSON exposes `result.body.output` and
`result.body.credits_consumed`; large JSON metadata can use the existing file
result format. Read `result.type` before consuming the result.

Input resources can be public HTTPS URLs or successful xAPI task UUIDs.
An xAPI reference must belong to the same user/service and retain the same
upstream credential/origin. Supplier IDs, including UUID v4 and `task_` forms,
do not prove ownership and cannot be passed through as caller references.
File upload/presign endpoints and owned `file_` token persistence are not part
of this adapter. Do not rotate credentials midway through a resource chain.

Unknown submission outcomes and success responses missing valid final usage
remain in reconciliation. Never replay a generation because polling is pending
or an ID was not recognized: it may already be billable. Reconcile the existing
task/account usage through the operator procedure instead.

Model links are temporary. Stored success metadata does not archive model
binaries or automatically refresh expired Tripo URLs. Download acceptance and
long-term asset retention require separate verification.

## Acceptance boundary

Private draft/sandbox calls still spend real supplier credits while xAPI wallet
billing can be disabled. Supplier success and usage reconciliation do not prove
nonzero caller-wallet settlement. Before paid public access, verify the final
deployed candidate's ownership checks, result query/download, reservation
release, one-time settlement and uncertain-outcome handling with an explicit
budget. A management API success or HTTP 202 alone is not supplier acceptance.
