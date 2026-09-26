# xAPI Workers domains

Use this workflow when a domain managed through xAPI Domains must serve one xAPI Worker environment. The supported first version requires the domain's Cloudflare zone and Workers for Platforms to belong to the same platform Cloudflare account.

Platform-generated addresses do not require this workflow. For your own hostname,
choose xdomain automatic DNS below, or manual DNS when no xdomain domain record
exists. Both use the same xAPI ownership and binding APIs; manual DNS does not
bypass the same-account zone requirement. Where a domain was purchased is not
the determining factor; its authoritative Cloudflare zone is.

## Manual DNS without an xdomain record

The target must have an active deployment. Request a scoped challenge:

```sh
xapi workers domains challenge <worker-id> --env preview \
  --hostname chat.example.com --format json > challenge.json
```

Publish the exact TXT `dns.name` / `dns.value` from this file through your DNS
provider. If the provider asks for a relative record name, remove only your zone's
suffix. Keep the short-lived challenge out of source control. Then submit once:

```sh
xapi workers domains attach <worker-id> --env preview --challenge-file challenge.json
xapi workers domains list <worker-id>
```

This attach sends one request, with no automatic mutation retry. If DNS is still
pending, wait for propagation and explicitly repeat attach using the same file
before `expiresAt`. If the challenge expired, request a new one and replace the
TXT value. If the request timed out, list first: an accepted domain has an ID;
use `domains retry <worker-id> <domain-id>` for that domain when needed rather than
claiming the timeout means no binding was created. xAPI remains authoritative for
ownership, resource state and whether the request may proceed.

Once accepted, remove only the exact temporary challenge TXT. Manual mode does
not change DNS on your behalf. `PROVISIONING` is accepted but TLS/routing remains
pending; query `domains list` until `ACTIVE`, then verify the application route.
An unconfirmed binding is not a reason to rebuild or redeploy the application.

## What the combined command does

`xapi workers domains attach` is the public operation. It:

1. Fetches the `domain.get` schema, then confirms the `xdomain` domain belongs to the current xAPI Key.
2. Requests a short-lived Workers DNS ownership challenge bound to the current account, Worker, environment, and exact hostname.
3. Fetches the `dns.upsert` schema and writes a temporary TXT record through xdomain.
4. Lets the Workers control plane verify that TXT record, resolve the Cloudflare zone, publish the exact hostname-to-environment route in platform edge state, and create a native Cloudflare Workers Custom Domain for the shared Dispatcher.
5. Fetches the `dns.delete` schema and removes the temporary TXT record after the binding is accepted.

Cloudflare owns the final DNS record, certificate, TLS renewal, and request routing. Do not add a competing A, AAAA, or CNAME record. The runtime request path resolves the exact hostname from platform edge state; it does not call xdomain, the xAPI control plane, or a customer database.

## Automatic DNS with xdomain

Inspect the Worker and domain before changing anything:

```bash
xapi workers get <worker-id>
xapi get domain.get
xapi call domain.get --input '{"domain_id":"<xdomain-domain-id>"}'
```

The target environment must already have an active deployment. Bind the apex:

```bash
xapi workers domains attach <worker-id> \
  --env preview \
  --xdomain-domain-id <xdomain-domain-id> \
  --subdomain @
```

Or bind one hostname such as `kanby.example.com`:

```bash
xapi workers domains attach <worker-id> \
  --env preview \
  --xdomain-domain-id <xdomain-domain-id> \
  --subdomain kanby
```

Use `--env production` only after the production environment has been deployed and explicitly selected. One exact hostname maps to one environment. Preview and production need different hostnames.

The command waits up to two minutes for DNS ownership by default; use `--timeout 5m` for slower propagation. A cleanup warning means the Worker binding was accepted but the temporary TXT could not be removed automatically. Inspect it with `xapi get dns.list` followed by `xapi call dns.list` before deleting the exact record.

## Verify and operate

```bash
xapi workers domains list <worker-id>
xapi workers domains retry <worker-id> <worker-domain-id>
```

`PROVISIONING` means Cloudflare has not yet completed TLS or the reserved Dispatcher readiness probe. `ACTIVE` means TLS and exact environment routing both passed. It does not prove the application's own business routes; test those separately.

Detach only a customer custom domain:

```bash
xapi workers domains detach <worker-id> <worker-domain-id> --yes
```

An explicit retry first checks for an exact completed binding. If confirmed, it returns completion; otherwise it submits the current authorized intent. A failed observation does not permanently block retry. Failed/timed-out user attempts are not automatically reissued in the background. A timeout means the result is unconfirmed, not proof Cloudflare did nothing. Late results remain in history and cannot replace a newer local bind/detach state. A custom-domain failure does not disable the normal platform hostname.

If Cloudflare reports a hostname already bound to another service (for example `100117`), resolve that specific ownership conflict or choose another hostname before explicitly retrying. xAPI does not detach the other service or require an administrator to switch an environment mode.

Platform-generated hostnames follow the environment lifecycle and cannot be detached independently.
After detach, the exact hostname has a short reuse cooldown while stale edge
route state expires. Wait until the API's `reusableAt` time before binding that
hostname again; do not bypass this by editing DNS manually.

## Buying a domain

Domain registration is non-refundable. Before `domain.register`, always fetch the schemas for `domain.check`, `domain.price`, and `domain.register`; show the exact domain, first-period billable price, renewal information when available, maximum accepted charge, registration period, and the registrant contact data that will be sent to the registrar. Obtain explicit confirmation immediately before the purchase. Never invent missing contact fields.

Registration and Worker binding are separate operations. A completed purchase does not deploy or expose a Worker, and a deployed Worker does not authorize a domain purchase.

## Safety boundaries

- Never send the xAPI Key to the custom hostname or a tenant Worker.
- Never accept a client-supplied Cloudflare zone ID as proof of ownership.
- Never reuse one DNS challenge for another account, Worker, environment, or hostname.
- Do not replace the combined command with direct Wrangler, Cloudflare dashboard, or private provider calls during xAPI acceptance.
- Do not claim support for a domain whose authoritative zone is outside the configured Workers for Platforms account; that needs a future Custom Hostnames for SaaS flow.
