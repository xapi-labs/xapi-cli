# Submission readiness and interrupted review

These contracts require backends containing the readiness and review-recovery
changes. A source PR, CLI main commit, or local test does not prove deployment.
An older server may return 404; do not interpret that as a failed readiness check.

## Check before submitting

Use the actual service and working revision IDs from `provider versions`. The
Agent-management route, relative to the configured API base (normally ending
in `/api`), is:

```http
GET /api-services/agent/services/{serviceId}/revisions/{revisionId}/submission-readiness
XAPI-KEY: <provider-key-with-service:read>
```

The key needs `service:read` and its owner must own the service. Scope alone
does not grant access to another provider's revision. The interactive account
route is `GET /api-services/{serviceId}/revisions/{revisionId}/submission-readiness`
under the same API base; it uses account JWT/entity authentication and ownership.
No dedicated CLI readiness subcommand is provided by this documentation change.

The read does not edit the contract, submit a revision, or call the upstream.
Normal Agent audit logging still applies. Its result contains:

| Field | Meaning |
|---|---|
| `ready` | Whether the revision currently passes the submission checks; not proof of working upstream behavior |
| `revisionId`, `version`, `majorVersion`, `state`, `serviceStatus` | The exact revision and service state inspected |
| `issues[]` | Blocking issues with `code`, `message`, `fix`, and optional endpoint labels/details |
| `changes.baseline` | The serving revision used for comparison, or `null` |
| `changes.added/modified/removed` | Changed endpoint labels |
| `changes.willRunReviewTest` | `true`, `false`, or `null` when the review-test decision is unavailable because submission is blocked |
| `changes.reviewTestReason/reviewTestNote` | Why that review-test decision applies |
| `selfTest` | Advisory availability, reason, observation boundary (`since`), endpoint observations and untested count; `blocking` is `false` |

Issue codes include `SERVICE_BLOCKED`, `REVISION_NOT_IN_PREVIEW` (formerly
`REVISION_NOT_IN_SANDBOX`), `NO_ENDPOINTS`,
`PROVIDER_SCHEMA_INVALID`, `ENDPOINT_PATH_INVALID`, `MISSING_BASE_URL`,
`WS_MISSING_UPSTREAM`, `SANDBOX_CONFIG_INCOMPLETE`, and
`PER_TOKEN_USAGE_UNREADABLE`. Correct the reported issues, then read readiness
again. A check is a snapshot; submission performs its own validation again.

`selfTest.available: false` is distinct from zero untested endpoints. Sandbox
provider services, deprecated revisions, and revisions without a routable
self-test path can be unavailable. Inspect `reason` and `since`; do not treat a
recorded call as proof that every current input, schema, price or upstream path
works. This endpoint does not implement a unified revision-selection/self-test
workflow or authorize an automatic paid invocation.

After configuration and any appropriate tests, use the existing explicit
submission flow described in [lifecycle management](lifecycle-management.md).
`ready: true` does not submit automatically or bypass review.

## Recover from platform review interruption

`REVIEW_INTERRUPTED` is a provider inbox notification for platform failure during
automatic review. Its title identifies the service/revision; its body says the
revision returned to Preview without content changes and can be submitted again.
It does not carry the internal exception text, and it is not an author-content
rejection or an approval. Notification data includes `apiVersionId`,
`majorVersion` and the affected `reviewId`.

Recovery is tied to that review attempt and revision. A stale worker must not
roll back a newer attempt, a completed decision or an unrelated revision, and
must not emit a misleading recovery notification for them. The serving revision
continues serving while the working revision returns to `PREVIEW`.

On receiving a notification, read `provider versions` and `provider review` for
the referenced IDs. Confirm the current working revision is still the intended
`PREVIEW` revision, inspect readiness if supported, then explicitly submit it
again when appropriate. A notification can be stale; never blindly resubmit a
revision that is already `IN_REVIEW`, has a newer attempt, or has been published.
Do not automatically replay an ambiguous submit response; read current state
and the review record first.
