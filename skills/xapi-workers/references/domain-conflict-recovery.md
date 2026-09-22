# Administrator domain-conflict recovery

Use this procedure only when a Worker environment was quarantined after a
custom-domain attach returned Cloudflare HTTP `409` with provider error
`100117` (`DOMAIN_ALREADY_BOUND`). This is an administrator recovery contract,
not a normal customer deployment command.

## Endpoint

```text
POST /api/admin/workers/domain-conflict-recovery
Authorization: Bearer <existing-admin-session-or-token>
Content-Type: application/json
```

The endpoint uses the backend's existing administrator authentication and
authorization. Do not create a temporary token, put a Cloudflare token in the
request, or send an xAPI key to the Worker hostname. The caller must already be
an xAPI platform administrator.

Request the exact identifiers and revision from the backend audit record:

```json
{
  "workerId": "<worker-id>",
  "environmentId": "<environment-id>",
  "domainId": "<domain-id>",
  "hostname": "app.example.com",
  "expectedRevision": 236,
  "expectedProviderStatus": 409,
  "expectedProviderCode": 100117
}
```

## Preconditions and result

xAPI checks that the environment is the requested Worker, the legacy writer is
the one-step custom-domain `PUT` that recorded `409 / 100117`, and the
`domainProvision` scope in that writer matches the submitted domain, hostname,
zone, and dispatch service. It also verifies that Cloudflare shows another
service owning the hostname and that the xAPI dispatch service does not own it.

The platform route KV must be absent, or must point to the failed script and be
safe to remove. If ownership evidence is missing, ambiguous, or belongs to
another xAPI script, recovery fails closed.

Successful recovery clears only the failed legacy writer, returns the
environment to `LEGACY`, records the local domain as `ERROR` with
`worker_domain_conflict`, and writes an audit record. It does not detach or
delete the binding owned by another Cloudflare service. The user must resolve
the hostname conflict separately before trying another bind.

After recovery, verify the returned state, the audit event
`control.legacy_domain_conflict_recovered`, and the unchanged external binding.
