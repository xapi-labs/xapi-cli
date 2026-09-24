# Zero-price endpoints

An endpoint with `PER_CALL` and `costPerCall: 0` is free, but callers still need
a registered xAPI key. Authentication preserves usage attribution, provider
metrics, rate limiting, and abuse controls.

```json
{
  "endpoints": [
    {
      "id": "existing-endpoint-id",
      "billingType": "PER_CALL",
      "costPerCall": 0
    }
  ]
}
```

```bash
npx xapi-to provider version update \
  <service-id> <version-id> --file ./free-endpoint.patch.json
```

Before publishing, verify the service remains `PROXY` if it needs xAPI usage
tracking or service rate limits. After publication, use a registered canary key
with zero spendable balance, then inspect provider metrics and the finalized
receipt:

```bash
npx xapi-to usage wait <request-id> --timeout 1m
npx xapi-to provider metrics <service-id> --days 1
npx xapi-to provider events --limit 20
```

Do not describe a zero-price endpoint as anonymous. Keep normal endpoint,
per-user, and WebSocket connection limits even when no balance hold is needed.
