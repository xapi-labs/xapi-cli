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
`versions`, or `revision start`.

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

Include an endpoint `id` when updating an existing endpoint. Omitting it means
new endpoint. Use `--replace` only with a complete version contract; it sends a
PUT and replaces omitted contract data:

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
