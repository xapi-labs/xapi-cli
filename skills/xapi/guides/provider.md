# Provider service management

Read this guide for provider-side service authoring and operations. These
commands use `XAPI-KEY` directly and never exchange it for a broad JWT session.
The key must belong to the service owner and carry the scope named by the
operation.

## Inspect capabilities and scopes

```bash
npx xapi-to provider --help
npx xapi-to skill --help
npx xapi-to skill spec
```

Use narrowly scoped keys. Common scopes are:

- `service:create`, `service:read`, `service:update`
- `version:create`, `service:publish`, `service:rollback`
- `observability:read`
- `skill:read`, `skill:submit`
- `earnings:read`; `earnings:transfer` only when reinvestment is intended
- `service:delete` only for deliberate removal workflows

Scope permission and ownership are independent. A key with a scope still cannot
manage another provider's service or Skill. These commands validate the owner
path; they do not prove a separate administrator can view or review a working
revision.

## Create and describe a service

Create uses the backend service DTO as JSON so credentials and endpoint
contracts do not have to appear in shell history:

```bash
npx xapi-to provider create --file ./service.json
npx xapi-to provider list
npx xapi-to provider get <service-id>
```

### Upload a local LOGO when creating

```bash
npx xapi-to provider create --file ./service.json --logo-file ./logo.png
```

`--logo-file` accepts JPG, PNG, GIF and WebP up to 10 MB. The CLI checks the
local file, uploads it using the same API Key with `service:create`, then sends
the returned remote URL as `logoUrl` in the create request. Storage credentials
remain on the server. Existing JSON `logoUrl` and creation without a LOGO work
as before. Remove a JSON `logoUrl` before passing `--logo-file`; supplying both
is an error. This flag is supported only by `provider create`.

File, authentication, permission, network and storage errors stop creation and
return a nonzero exit code. Uploads are not automatically retried. Upload and
service creation are separate writes: if creation fails after upload, the image
may remain unused. Inspect `provider list` after an ambiguous create response
before retrying; do not automatically replay the create write.

The installed CLI help must list `--logo-file`, and the selected server must
support provider LOGO uploads. A 404 requires a server update; 401 requires
checking the configured API Key; 403 requires `service:create` and allowed
source IPs. The server rechecks image content and enforces a 20/minute/IP limit.
A repository change does not imply that the CLI package or backend has already
been released.

After successful creation, run `provider get <service-id>` and verify its
`logoUrl` matches the returned image URL; verify the image in the web console
when validating a deployed environment.

Keep the three service content layers distinct:

- `description` is the short marketplace-card summary.
- `aboutMarkdown` is the long About tab.
- `website` is a public HTTP(S) link.

Prefer files for long text:

```bash
npx xapi-to provider update <service-id> \
  --description "Short marketplace summary" \
  --about-file ./ABOUT.md \
  --website https://example.com
```

Use `--clear-about` or `--clear-website` to clear a value. Provider metadata
updates cannot modify the version contract or upstream credentials; use the
version command for those fields.

## Configure a service request limit

Rate limits are optional service settings. Configure both values together when
creating a service or updating an existing one:

```bash
npx xapi-to provider create --file ./service.json \
  --rate-limit-requests 100 \
  --rate-limit-period-seconds 60

npx xapi-to provider update <service-id> \
  --rate-limit-requests 100 \
  --rate-limit-period-seconds 60
```

`requests` accepts 1 through 1,000,000 and `periodSeconds` accepts 1 through
86,400. The backend applies one quota to each User x Service pair, so all API keys
owned by the same user share that service quota. This setting is supported only
for `PROXY` services; the backend rejects a non-null limit for `DIRECT` services.

Disable the limit explicitly with:

```bash
npx xapi-to provider update <service-id> --clear-rate-limit
```

This sends `rateLimitConfig: null`. Omitting the rate-limit flags during an
update leaves the existing setting unchanged. A raw `rateLimitConfig` can also
be included in `service.json`; explicit CLI rate-limit flags override that field.

## Edit and publish a revision

```bash
# Inspect current majors and revisions
npx xapi-to provider versions <service-id>

# Either create a new major or pull a working revision from an existing major
npx xapi-to provider major create <service-id>
npx xapi-to provider revision start <service-id> <major>

# Merge a partial version-contract update; add --replace for full replacement
npx xapi-to provider version update \
  <service-id> <version-id> --file ./contract.json

# Inspect before publishing
npx xapi-to provider diff <service-id> <major>

# Submit through the normal review gate with public release notes
npx xapi-to provider publish \
  <service-id> <revision-id> --changelog-file ./CHANGELOG.md

# Inspect the review result
npx xapi-to provider review <service-id> <revision-id>
```

The changelog is provider-authored, public release information associated with
that revision. It is not a system deployment log. Build, review, and runtime
events are generated by the platform and should only be read, never uploaded as
if they were evidence.

`publish` can change live service behavior after review. The CLI does not
automatically retry this write after an ambiguous transport failure. Read the
version overview and review state before deciding whether to submit again.

A passing review can automatically publish and switch the serving revision.
In `provider versions`, use `majors[].working.id` for draft edits and verify
`servingRevisionId` after publication. Cloning creates new endpoint UUIDs while
preserving `endpointKey`; get the working contract and use its endpoint IDs for
patches. See the [provider lifecycle reference](../../xapi-provider/reference/lifecycle-management.md)
for PATCH/PUT matching and removal rules.

Use the overview's major/revision label to select that contract, for example
`npx xapi-to provider get <service-id> --version v1.4`; confirm its revision ID
matches `working.id`. A working revision already `IN_REVIEW` is not editable.

For Decisions model configuration and DYNAMIC billing, read
[AI provider contracts](../../xapi-provider/reference/ai-spec-and-models.md).
For an HTTP/2 upstream, read [HTTP transport](../../xapi-provider/reference/http-transport.md)
before updating `openApiSpec`; neither workflow requires a new CLI transport
flag.

## Create, upload, and link the usage Skill

Generate a service-specific starting point from the currently serving endpoints:

```bash
npx xapi-to provider skill scaffold \
  <service-id> --output ./my-service/SKILL.md
```

The scaffold command refuses to overwrite an existing file unless `--force` is
explicitly supplied. Check generated examples against the serving contract:
strip internal named-base selectors such as `{{alpha}}` from public paths,
use the real HTTP method, body and media type, and use raw Gateway requests for
BCS input. Complete the instructions and metadata, then submit either
a local directory or a public GitHub tree:

```bash
npx xapi-to skill submit --dir ./my-service

npx xapi-to skill submit \
  --github https://github.com/org/repo/tree/main/skills/my-service \
  --version 1.0.0
```

Local submission skips symlinks, `.git`, and `node_modules`; requires a root
`SKILL.md`; permits at most 100 files; limits each file to 512 KiB and the encoded
package to 2 MiB. The server still performs manifest validation and secret
scanning. A successful upload creates or updates the owned Skill version and
submits it for review; it is not immediately public.

Use the returned submission ID:

```bash
npx xapi-to skill status <submission-id>
npx xapi-to skill wait <submission-id> --timeout 10m
```

After the Skill is published, bind it as the service's primary tutorial and
record the serving-contract fingerprint:

```bash
npx xapi-to provider skill link <service-id> <skill-id>
npx xapi-to provider skill fingerprint \
  <service-id> --skill-version-id <skill-version-id>
npx xapi-to provider skill context <service-id>
```

Only a Skill owned by the same provider can be linked, and one Skill can be the
primary Skill of only one service. The backend permits linking a pending Skill,
but the public marketplace exposes only a published version; wait for publication
unless intentionally preparing the association early. Use `provider skill unlink`
to remove the primary association. The context response reports drift when host,
major version, or serving endpoints no longer match the stored fingerprint; update
and resubmit the Skill rather than merely overwriting the fingerprint.

The current fingerprint covers host, major and endpoint keys. `drift: false`
does not certify unchanged schemas, MIME types or transport; review those when
the contract changes even if endpoint keys remain identical.

## Observe and recover

```bash
npx xapi-to provider metrics --days 30
npx xapi-to provider metrics <service-id> --days 7
npx xapi-to provider events --limit 50
npx xapi-to provider events --after '<opaque-next-cursor>' --limit 50
```

Pass event cursors back unchanged. Metrics and events are owner-scoped; usage
events are also restricted to the current key where applicable.

Verify the finalized cost of a canary or provider call with an xAPI receipt ID
when the selected interface exposes it, such as the direct service Gateway's
`X-XAPI-Request-Id` header or a documented `xapi.usage` SSE event. Ordinary CLI
JSON calls currently return the body without exposing response headers, and
the AI Gateway does not yet provide a reliable receipt-ID response contract.
Do not substitute an upstream response `id`. With a known xAPI request ID, wait
when asynchronous billing has not finalized yet:

```bash
npx xapi-to usage <request-id>
npx xapi-to usage wait <request-id> --timeout 1m
```

Receipt reads are idempotent. The wait command applies one total deadline,
retries not-found and transient transport failures within that deadline, and
fails immediately for permanent authorization or validation errors.

Rollback and default-major changes affect live routing:

```bash
npx xapi-to provider rollback \
  <service-id> <major> --revision <published-revision-id> \
  --reason "Restore the last known-good contract"
npx xapi-to provider default-major <service-id> <major>
npx xapi-to provider deprecate <service-id> <major>
npx xapi-to provider restore <service-id> <major>
```

Inspect the target revision before rollback. Do not automatically retry an
ambiguous rollback response. Deletion requires both `service:delete` and an
explicit service name or ID confirmation:

```bash
npx xapi-to provider delete <service-id> --confirm <service-name-or-id>
```

## Earnings reinvestment

```bash
npx xapi-to earnings
npx xapi-to earnings list --status SETTLED
npx xapi-to earnings transfer 1 --idempotency-key <stable-operation-key>
```

Transfer is one-way: it converts settled provider earnings into spendable xAPI
balance. Confirm the amount and available settled balance first. A transfer may
be retried only with the same idempotency key and the same amount.
