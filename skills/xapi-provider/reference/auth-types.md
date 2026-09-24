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
