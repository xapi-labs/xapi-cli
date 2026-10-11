# xAPI Workers domains

Use this workflow to bind, switch, or troubleshoot a hostname serving an xAPI Worker environment, with or without an xdomain domain record. The current implementation requires the domain's Cloudflare zone and Workers for Platforms to belong to the same platform Cloudflare account.

Platform-generated addresses do not require this workflow. For your own hostname,
choose xdomain automatic DNS below, or manual DNS when no xdomain domain record
exists. Both use the same xAPI ownership and binding APIs; manual DNS does not
bypass the same-account zone requirement. Where a domain was purchased is not
the determining factor; its authoritative Cloudflare zone is.

## Choose the supported route

| Domain situation | What to do |
|---|---|
| Platform-generated address | Use the URL returned by xAPI; no DNS changes. |
| xdomain record, eligible platform zone | Use combined attach; xdomain handles the temporary verification TXT. |
| No xdomain record, but eligible platform zone | Give the user the exact TXT name/value and use manual attach below. |
| Zone in another CF account or another DNS provider | The current native Custom Domain flow cannot attach it. Explain the limitation and keep the platform URL available. A TXT or CNAME alone does not enable support. |

Do not request registrar credentials, transfer a domain, change nameservers, or
build a DNS-provider integration just to complete a Worker binding. For eligible
manual DNS, give the user the required record and verification steps. For an
ineligible zone, report the need for a separately supported Custom Hostnames for
SaaS integration; do not present it as an available CLI option.

## Inspect existing DNS before attach

Select the API environment and target Worker environment first. Read
`workers get` and `workers domains list`; an existing `ACTIVE` binding for the
same hostname and target needs verification, not another detach/attach cycle.
For xdomain, fetch the live schema and inspect records:

```bash
xapi workers domains list <worker-id>
xapi get dns.list
xapi call dns.list --input '{"domain_id":"<xdomain-domain-id>"}'
```

Check the exact serving hostname, its applicable wildcard/delegation, and the
temporary challenge name. For manual DNS, have the user inspect those records
in their DNS console; public DNS lookup alone cannot establish record ownership
or reliably reveal the stored type behind a proxy/flattened record.

This is an agent-guided preflight: combined attach does not currently provide a
complete ordinary-DNS conflict check. A provider rejection can still arrive
after these reads; preserve its error code/message instead of guessing.

| Finding | Handling |
|---|---|
| Existing CNAME at the serving hostname | CF Custom Domains reject this conflict. Explain which existing service would be affected. Use another hostname, or replace only that record when the user's request authorizes replacing that service. Do not silently delete it. |
| Existing A/AAAA or another service's routing | Inspect its purpose and provider response; do not promise it will be preserved or automatically replaced. A Worker binding request alone does not authorize taking over an unrelated live service. |
| MX, SPF/DKIM/DMARC TXT, other verification TXT, unrelated subdomains | Preserve them; do not classify the whole zone as conflicting or clear a record set to make a website work. |
| Hostname already mapped to another Worker/environment (`worker_domain_hostname_in_use`) or CF service (`100117` / `worker_domain_conflict`) | Identify the current target if accessible. Switch explicitly only if the user owns/controls it and requested that switch; otherwise choose another hostname or ask its owner to release it. DNS edits alone do not remove the Worker binding. |
| Stale/concurrently changed DNS record | Re-read before changing it; use the stable `record_id` and `record_modified_on` when supported by the live schema. Do not bypass a stale-write rejection. |

For an authorized DNS replacement, retain the old record's type/name/value/TTL
and proxy setting for recovery, fetch `dns.upsert` / `dns.delete` schemas, and
apply only the exact change. Existing authorization is sufficient; do not add
an administrator approval step. If the effect on an existing service is outside
the user's request, explain that concrete effect before asking for a decision.
Do not change NS, DNSSEC, mail records, or unrelated hosts as a conflict remedy.

Cloudflare documents the existing-CNAME restriction and managed DNS/TLS behavior
in [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

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
not manage the verification TXT for you; the accepted native Custom Domain still
lets Cloudflare manage serving DNS/TLS. `PROVISIONING` is accepted but TLS/routing remains
pending; query `domains list` until `ACTIVE`, then verify the application route.
An unconfirmed binding is not a reason to rebuild or redeploy the application.

## What the combined command does

`xapi workers domains attach` is the public operation. It:

1. Fetches the `domain.get` schema, then confirms the `xdomain` domain belongs to the current xAPI Key.
2. Requests a short-lived Workers DNS ownership challenge bound to the current account, Worker, environment, and exact hostname.
3. Fetches the `dns.upsert` schema and writes a temporary TXT record through xdomain.
4. Lets the Workers control plane verify that TXT record, resolve the Cloudflare zone, publish the exact hostname-to-environment route in platform edge state, and create a native Cloudflare Workers Custom Domain for the shared Dispatcher.
5. Fetches the `dns.delete` schema and attempts to remove only its exact temporary TXT record, on either attach success or failure. Cleanup is separate from binding success.

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

The command waits up to two minutes for DNS ownership by default; use `--timeout 5m` for slower propagation (supported range: `1s` to `10m`). This bounds retries for `worker_domain_dns_challenge_pending`, not the entire TLS issuance process. It does not automatically replay arbitrary failed/timed-out binding mutations. Manual `--challenge-file` mode does not accept `--timeout` and sends one request.

A cleanup warning in a successful result means the binding was accepted but the
temporary TXT could not be removed automatically. After an attach error, cleanup
also may have failed; inspect `dns.list` when needed and remove only the exact
challenge created by this attempt. Never delete all TXT records sharing a name.
For a fresh combined attach, let the command create a fresh challenge; do not
assume a previous attempt's TXT is still present.

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

## Switch domains or environments

**A different hostname for the same application:** attach the new hostname first,
wait for `ACTIVE`, and verify its business routes. Keep the old binding until
the new address works, then detach it if removal was requested. Binding the new
hostname does not automatically redirect the old one.

**The same hostname moved to another environment or Worker:** there is no atomic
move command. Verify the destination deployment via its current URL, detach the
old custom binding, wait for confirmed detach and the returned `reusableAt`,
then attach to the destination using a new challenge. This can cause an access
gap; do not claim a zero-downtime switch. While pending, use each environment's
existing platform URL. Do not delete either Worker or its data to move a domain.

If attach or detach times out, query the binding before proceeding. Use the
returned domain ID for an explicit retry where appropriate. If the old binding
still exists, do not overwrite DNS to try to force the new target. A failed
switch does not prove the previous mapping is gone. Restoring the old target
also needs the normal ownership/binding flow and any applicable cooldown.

Application settings are a separate step: inspect the project's actual public
URL vars, OAuth callback allowlist, cookie domain, CORS and redirect settings.
Update only settings that depend on the changed origin; do not invent universal
variable names or rotate Secret values just because a domain changed. OAuth
settings at GitHub or another provider may require the user's own console action.
For example, changing the Kanby host requires checking its configured callback
origin, not merely obtaining an HTTPS certificate.

## Verify and report completion

Check the intended hostname/environment mapping, HTTPS, root page, a deep route,
static assets and an application API. If the app uses login or attachments,
verify the callback and an authorized attachment URL as well. Do not send the
xAPI Key to these application URLs. If TLS/routing is `ACTIVE` but login fails,
inspect application settings/logs rather than repeatedly rebinding the domain.

Report the final URL, target environment, binding/TLS state, business checks,
old binding disposition and any pending user DNS/OAuth step. Separate local/mock
tests from live DNS acceptance. Stop a wait at the user's deadline and report
pending state plus the next query/retry; do not wait indefinitely or call pending
a successful cutover.

## Buying a domain

Domain registration is non-refundable. Before `domain.register`, always fetch the schemas for `domain.check`, `domain.price`, and `domain.register`; show the exact domain, first-period billable price, renewal information when available, maximum accepted charge, registration period, and the registrant contact data that will be sent to the registrar. Obtain explicit confirmation immediately before the purchase. Never invent missing contact fields.

Registration and Worker binding are separate operations. A completed purchase does not deploy or expose a Worker, and a deployed Worker does not authorize a domain purchase.

## Safety boundaries

- Never send the xAPI Key to the custom hostname or a tenant Worker.
- Never accept a client-supplied Cloudflare zone ID as proof of ownership.
- Never reuse one DNS challenge for another account, Worker, environment, or hostname.
- Do not replace the combined command with direct Wrangler, Cloudflare dashboard, or private provider calls during xAPI acceptance.
- Do not claim support for a domain whose authoritative zone is outside the configured Workers for Platforms account; that needs a future Custom Hostnames for SaaS flow.
