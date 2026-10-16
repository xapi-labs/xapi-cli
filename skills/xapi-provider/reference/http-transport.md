# HTTP upstream transport

Read this when an upstream requires HTTP/2 or when importing/editing an existing
transport choice. This is separate from request media type, AI protocol and billing.

## Backend revision contract

Store a numeric selector under OpenAPI `info`:

```json
{
  "openapi": "3.0.3",
  "info": {
    "title": "Example RPC",
    "version": "1.0.0",
    "x-xapi-upstream-http-version": 2
  },
  "servers": [{"url": "https://rpc.example.com"}],
  "paths": {}
}
```

This shows transport metadata; complete the real operations before submission.
Scoped create/version DTOs carry it in `openApiSpec`, either as the raw contract
above or wrapped as `{"spec": <complete-contract>}`. There is no endpoint-level
or top-level DTO `upstreamHttpVersion` field to send instead.

| Value | Backend behavior |
|---|---|
| Omitted or numeric `1` | Existing HTTP/1.1 transport |
| Numeric `2` | HTTPS, verified TLS, ALPN `h2`; no HTTP/1.1 downgrade |
| String `"2"`, null extension value, other numbers | Invalid selector |

Every configured non-empty default/named base must use HTTPS for version 2.
An incomplete draft can retain the selector before a base is configured;
submission requires a complete public upstream. Named-base targets are checked
again at runtime. SSRF, blocked-address/port and DNS-rebinding protection remain
enabled. Provider Host overrides affect HTTP/2 `:authority`, not connection
destination, URL-based TLS identity or SNI.

Synchronous calls and supported async submit/poll/cancel paths use the selector.
Queued tasks freeze it at submission; a revision change does not rewrite an
existing task. HTTP/2 transport does not automatically retry or follow redirects.

## Preserve, replace or clear

- A new major inherits source `openApiSpec` when the field is omitted.
- Metadata-only updates omitting `openApiSpec` retain the stored contract.
- Explicit raw or wrapped `openApiSpec` replaces that entire field, even in
  PATCH. Merge the intended info change into the existing contract first and
  preserve other fields. Endpoint PATCH merge does not deep-merge the spec.
- `{"openApiSpec": null}` clears the contract and restores the HTTP/1.1 default.
  This differs from an invalid null selector inside `info`.
- Form imports with a selector merge it into existing transport info. Imports
  without one leave an existing choice alone; new services default to HTTP/1.1.
  Legacy imports retain transport metadata beside editable endpoint rows rather
  than freezing the original paths map.
- Previously lost selectors require an explicit revision update; their missing
  intent cannot be inferred.

Use a working revision. Put the complete updated `openApiSpec` in the patch:

```bash
npx xapi-to provider revision start <service-id> <major>
npx xapi-to provider version update \
  <service-id> <working-revision-id> --file ./transport.patch.json
npx xapi-to provider diff <service-id> <major>
```

Protocol changes require connectivity review through normal publication.
The editor's `/agent/test` and `test-config` currently do not propagate this
selector; their success does not prove HTTP/2 connectivity. Verify a real TLS
h2-only target through the configured runtime and check normal accounting before
claiming end-to-end support.

## xhub is a separate connection

An xhub platform manifest uses a **string**:

```json
{
  "upstream": "https://provider.example.com",
  "upstreamHttpVersion": "2"
}
```

This is a fragment of `platforms/<key>/manifest.json`, not a backend DTO.
Complete the platform's other required fields. Omitted keeps existing fetch
behavior; `"1.1"` explicitly pins HTTP/1.1; `"2"` requires HTTPS/ALPN h2 and
Bun >= 1.4.3. Check the deployed xhub runtime before enabling it.

```text
Consumer → backend → HTTP/1.1 xhub → HTTPS HTTP/2 provider
```

When xhub accepts HTTP/1.1, leave the backend selector omitted. Enable xhub's
manifest independently for its onward connection. Backend HTTP/2 support alone
does not configure or publish an xhub platform.

These settings do not implement gRPC/Protobuf framing or `grpc-status` handling,
cleartext h2c, WebSockets or consumer ingress HTTP/2. Verify the actual upstream
protocol before treating an HTTP/2 selector as sufficient.
