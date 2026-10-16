# CLI lifecycle and payload contract

The provider CLI manages a service through scoped `XAPI-KEY` routes internally.
Use the commands here instead of constructing management requests yourself.

## Service and revision states

A newly created service starts with a `DRAFT` v1 revision. Saving a valid
contract moves it to `SANDBOX`; publishing moves it to `IN_REVIEW`. A passing
review produces an immutable `PUBLISHED` revision. A failed review returns the
revision to `SANDBOX`; an uncertain review may wait for human review. A service
can also become `SUSPENDED` after publication.

Use these reads to determine current state and IDs:

```bash
npx xapi-to provider list
npx xapi-to provider get <service-id>
npx xapi-to provider versions <service-id>
npx xapi-to provider review <service-id> <revision-id>
npx xapi-to provider diff <service-id> <major>
```

Do not infer version IDs from version labels. Use the IDs returned by `create`,
`versions`, or `revision start`. In `versions`, each `majors[]` entry has a
`servingRevisionId`, an optional `working.id/state`, and published `history`.
Read the working contract rather than editing the currently serving revision.
For a currently serving published revision, verify `state: "PUBLISHED"` and
`isServing: true`, with the service active and major not deprecated. A historical
published revision is not necessarily serving. The legacy revision `status`
field is not the routing truth.

`revision start` may return an existing working revision, including one already
in review. Only `DRAFT` and `SANDBOX` are editable; inspect state before writing.

Use the major and working `revision` number from the overview to read its
contract, for example v1.4 for major 1, revision 4:

```bash
npx xapi-to provider get <service-id> --version v1.4
```

Verify the returned revision ID equals the intended working ID before taking
endpoint IDs from it. Do not blindly resubmit the redacted service response as
a full configuration file.

Provider CLI reads and writes use the service owner's scoped key. An owner
preview does not validate a different administrator's visibility or permissions;
verify each actual role separately when it is part of the requested acceptance.

## Create payload

`provider create --file` accepts a JSON object. `name` and `authType` are
required. A complete HTTP example is:

```json
{
  "name": "Weather API",
  "description": "Forecasts and current conditions",
  "category": "Data-Analysis",
  "host": "weather-provider",
  "baseUrl": "https://weather.example.com/v1",
  "authType": "HEADER",
  "privateHeaders": { "X-API-Key": "replace-with-upstream-secret" },
  "accessMode": "PROXY",
  "isPublic": true,
  "endpoints": [
    {
      "name": "Current weather",
      "method": "GET",
      "path": "/weather/:city",
      "pathParams": {
        "city": {
          "required": true,
          "description": "City name",
          "schema": { "type": "string" }
        }
      },
      "billingType": "PER_CALL",
      "costPerCall": 0.001
    }
  ]
}
```

`baseUrl` and every `wsConfig.upstreamUrl` must be public URLs. Use `baseUrls`
for named upstream environments and prefix an endpoint path with `{{name}}` to
select one. For example, `"path": "{{staging}}/weather"` requires a `staging`
entry in `baseUrls`.

Run:

```bash
npx xapi-to provider create --file ./service.json
```

The output contains the service and initial version/revision IDs. Keep those
IDs for later commands.

## Service metadata versus version contract

`provider update` changes marketplace metadata, the linked Skill, or service
rate limiting. It does not change endpoints, upstream URLs, authentication, or
billing.

```bash
npx xapi-to provider update <service-id> \
  --name "Weather API" \
  --description-file ./DESCRIPTION.txt \
  --about-file ./ABOUT.md \
  --website https://example.com \
  --logo-url https://example.com/logo.png \
  --category Data-Analysis
```

Use `--clear-about` or `--clear-website` to clear those fields. For structured
metadata such as a request limit, use a file:

```json
{ "rateLimitConfig": { "requests": 100, "periodSeconds": 60 } }
```

```bash
npx xapi-to provider update <service-id> --file ./service-metadata.json
```

The limit is shared by all keys owned by one user for this service. It applies
only to `PROXY` services. Set `rateLimitConfig` to `null` to disable it.

## Version updates

Use a partial file for the default PATCH behavior:

```json
{
  "baseUrl": "https://weather.example.com/v2",
  "endpoints": [
    {
      "id": "existing-endpoint-id",
      "costPerCall": 0.002
    }
  ]
}
```

```bash
npx xapi-to provider version update \
  <service-id> <version-id> --file ./contract.patch.json
```

Prefer the endpoint `id` from the target working revision for partial updates.
Copy-on-write creates new endpoint UUIDs but preserves `endpointKey`. Preserve
that key when carrying an endpoint across revisions. The current backend matches
an endpoint by a current `id`, then by `endpointKey`; when no key is supplied,
a complete `method` + `path` may match its derived key. A stale ID can therefore
match a preserved endpointKey. Conflicting supplied IDs and keys are rejected.
Do not assume that omitting `id` always creates an endpoint, or that an endpoint
UUID remains stable across revisions.

An unmatched explicit ID in PATCH is rejected rather than silently creating a
row. To add an endpoint, omit its ID and supply its name, method and path; ensure
it does not match an existing stable or derived key. Editing does not itself
increment the revision label.

PATCH keeps omitted endpoints. PUT with an `endpoints` list removes unmatched
endpoints; include every endpoint to retain, with its identity and complete
configuration. Use `--replace` only with a complete version contract:

```bash
npx xapi-to provider version update \
  <service-id> <version-id> --file ./contract.full.json --replace
```

Published revisions are immutable. Start a working revision for the existing
major, or create a new major:

```bash
npx xapi-to provider revision start <service-id> <major>
npx xapi-to provider major create <service-id>
```

Read the new revision and its endpoint IDs after cloning. The onboarding alias
`provider update <service-id> --revision <id> --file ... --mode merge` has an
additional CLI guard requiring endpoint IDs unless `--allow-new-endpoints` is
explicitly supplied. That flag permits ID-less entries; it does not override
backend identity matching. Use working IDs for routine patches rather than
enabling it merely to bypass the guard.

Transport metadata is part of `openApiSpec`, which is replaced as a whole when
explicitly supplied, even in PATCH. See [HTTP transport](http-transport.md)
before changing or clearing HTTP/2 configuration.

Keep the editable endpoint rows and any operations in a stored
`openApiSpec.paths` consistent. Updating `openApiSpec` does not re-import the
endpoint list. Named-base selection remains part of the stored endpoint path:
use `{{alpha}}/new` to select alpha, or `/new` for the default base. The selector
is omitted only from the public Gateway path.

## Publish and review

Before publishing, the revision needs a valid public upstream and at least one
endpoint. Inspect the diff, submit, then inspect review state:

```bash
npx xapi-to provider diff <service-id> <major>
npx xapi-to provider publish \
  <service-id> <revision-id> --changelog-file ./CHANGELOG.md
npx xapi-to provider review <service-id> <revision-id>
npx xapi-to provider versions <service-id>
```

The changelog is public provider-authored release information. Do not put
credentials, internal logs, or review-worker output in it. If publish returns an
ambiguous transport failure, read state before deciding whether to submit again.

Submission can automatically publish after a passing review and switch live
traffic to the new revision. Obtain authorization for that effect before
submitting. Check `review`, then `versions` and `servingRevisionId` to verify the
actual result; HTTP success or a `PUBLISHED` historical revision alone is not
proof of current serving state.

## Rollback, major routing, and removal

Rollback targets an existing published revision in one major:

```bash
npx xapi-to provider rollback \
  <service-id> <major> --revision <published-revision-id> \
  --reason "Restore known-good behavior"
```

Changing the default major and taking a major out of or back into routing are
separate operations:

```bash
npx xapi-to provider default-major <service-id> <major>
npx xapi-to provider deprecate <service-id> <major>
npx xapi-to provider restore <service-id> <major>
```

Read `versions` after an ambiguous write. Delete only when the user intends to
remove the service and has identified it by name or ID:

```bash
npx xapi-to provider delete <service-id> --confirm <service-name-or-id>
```
