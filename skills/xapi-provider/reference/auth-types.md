# Upstream authentication

Authentication belongs in the JSON passed to `provider create` or `provider
version update`. Never put a real credential in public schema content, endpoint
docs, the changelog, or a command argument.

| Upstream expects | `authType` | `privateHeaders` |
|---|---|---|
| no authentication | `NONE` | omit |
| custom header | `HEADER` | `{ "X-API-Key": "secret" }` |
| bearer token | `BEARER` | `{ "Authorization": "secret" }` |
| query credential | `QUERY` | `{ "appid": "secret" }` |

For bearer auth, supply the raw token or an `Authorization` value; the platform
normalizes the `Bearer` prefix. For HEADER and QUERY auth, every map entry is
injected upstream, so the keys must be the exact header or parameter names.

Create example:

```json
{
  "name": "Private Search",
  "baseUrl": "https://search.example.com",
  "authType": "HEADER",
  "privateHeaders": {
    "X-API-Key": "replace-with-upstream-secret",
    "X-Tenant-Id": "tenant-42"
  },
  "endpoints": [
    {
      "name": "Search",
      "method": "GET",
      "path": "/search",
      "billingType": "PER_CALL",
      "costPerCall": 0.01
    }
  ]
}
```

```bash
npx xapi-to provider create --file ./service.json
```

To rotate credentials, start a working revision if the current one is
published, then write only the authentication fields to a private patch file:

```json
{
  "authType": "BEARER",
  "privateHeaders": { "Authorization": "replace-with-new-token" }
}
```

```bash
npx xapi-to provider revision start <service-id> <major>
npx xapi-to provider version update \
  <service-id> <working-version-id> --file ./auth.patch.json
```

Reads intentionally scrub credential values. Confirm the auth type and run a
canary call; do not expect a read command to return the secret.

## Forward xAPI caller identifiers

A provider can enable xAPI user identity forwarding on a working revision.
The default is off. This setting is for synchronous HTTP proxy endpoints sharing
one HTTPS origin. The switch controls whether xAPI forwards the identifiers.
Upstream authentication is configured separately.

Start a working revision for the target major. To configure an upstream
credential as well, put it in a local patch file outside version control.
This example uses a custom header. For Bearer auth, set `"authType": "BEARER"`
and use `"Authorization"` in `privateHeaders`.
With `HEADER` auth, ordinary headers such as `Content-Type` can accompany
the dedicated credential.

```json
{
  "authType": "HEADER",
  "privateHeaders": {
    "X-Provider-Gateway-Key": "replace-with-a-dedicated-upstream-secret"
  }
}
```

Apply the credential and forwarding setting to the working revision.

```bash
npx xapi-to provider version update <service-id> <working-version-id> \
  --file ./auth.patch.json --forward-caller-identity on
```

To change only the switch, use the flag on its own.
For reusable automation, set `"forwardCallerIdentity": true` in the JSON patch.
If you pass the field and flag together, their values must agree.

When only the forwarding switch changes, publishing activates it immediately
without a review step. When forwarding is on and the revision also changes the
upstream, contract or authentication, publishing activates it immediately and
the revision is spot-checked afterward, because the review key cannot call
identity-aware endpoints. Inspect the diff, publish, and confirm
`servingForwardCallerIdentity` for the target major.

```bash
npx xapi-to provider diff <service-id> <major>
npx xapi-to provider publish <service-id> <working-version-id>
npx xapi-to provider versions <service-id>
```

You can verify ownership in a dedicated sandbox service with two regular xAPI
Keys from the same account and one from another account.

On the provider server, verify the request came from xAPI before using these
headers for authorization. Use an upstream credential issued only to xAPI and
validate it on every request. A key that other clients also hold cannot prove
the request came through xAPI, because they could call the upstream directly
with forged headers.

| Request header | Provider use |
|---|---|
| `X-XAPI-Account-Subject` | Bind newly created resources to this account and check ownership on every resource operation. |
| `X-XAPI-Key-Subject` | Record which xAPI key made the request. |

Treat the values as opaque. A different key for the same account produces a
different Key Subject and the same Account Subject within a service. Require
both headers exactly once on identity-aware routes. Keep subjects and the
credential server-side and out of public responses. The customer continues to
call with their regular xAPI Key.

To turn forwarding off, set `--forward-caller-identity off` on a working
revision and publish it. A JSON patch can also set
`"forwardCallerIdentity": false`. The change takes effect as soon as it is
published, so make identity-aware routes tolerate missing headers first. The
gateway keeps stripping both reserved
headers on every HTTP revision of a previously enrolled service, including
after a rollback.
