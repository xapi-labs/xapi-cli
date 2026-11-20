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

A provider can enable `forwardCallerIdentity` on a working revision. The
default is off. This setting is for synchronous HTTP proxy endpoints sharing
one HTTPS origin. Configure a dedicated version-level `HEADER` or `BEARER`
credential that the provider validates on every request.

Save the toggle and credential together when first configuring a service.
Keep the file outside version control and populate the credential locally.

```json
{
  "forwardCallerIdentity": true,
  "authType": "HEADER",
  "privateHeaders": {
    "X-Provider-Gateway-Key": "replace-with-a-dedicated-upstream-secret"
  }
}
```

Apply it with `provider version update <service-id> <working-version-id>
--file ./auth.patch.json`. Verify the sandbox through xAPI with a regular API
key, then submit the revision. The setting goes live when the revision serves.
Check the live setting per major version.

After validating the dedicated credential, the provider reads:

| Request header | Provider use |
|---|---|
| `X-XAPI-Account-Subject` | Bind newly created resources to this account and check ownership on every resource operation. |
| `X-XAPI-Key-Subject` | Record which xAPI key made the request. |

Treat the values as opaque. A different key for the same account produces a
different Key Subject and the same Account Subject within a service. Require
both headers exactly once on identity-aware routes. Keep subjects and the
credential server-side and out of public responses. The customer continues to
call with their regular xAPI Key.

To turn forwarding off, patch the working revision with
`{"forwardCallerIdentity":false}` and publish it. The gateway keeps stripping
these two reserved headers on every HTTP revision of a previously enrolled
service, including after a rollback.
