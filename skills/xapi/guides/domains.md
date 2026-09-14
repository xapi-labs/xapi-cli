# Domains and DNS Guide

Use the built-in `domain.*` and `dns.*` capabilities to search, price, register,
list, and inspect domains, then manage their DNS records. These are capability
actions, not third-party API actions, so discover them with
`--source capability` and pass a flat JSON object to `--input`.

Domain registration is a real, non-refundable purchase. DNS changes alter live
traffic. Read the current schema, show the user the exact target and price or
record change, and obtain explicit approval before either mutation.

## Current actions

| Action | Purpose | Mutation |
|---|---|---|
| `domain.search` | Registrar suggestions and one-year estimated prices | No |
| `domain.check` | Check exact-domain availability | No |
| `domain.price` | Read the current USD registration price | No |
| `domain.register` | Register a domain | **Purchase** |
| `domain.list` | List domains owned through xAPI | No |
| `domain.get` | Inspect one domain by `domain_id` | No |
| `dns.list` | List a domain's DNS records | No |
| `dns.upsert` | Create or update a DNS record | **Write** |
| `dns.delete` | Delete a DNS record | **Write** |

Fetch the live schemas before use:

```bash
npx xapi-to get-batch domain.search domain.check domain.price domain.register \
  domain.list domain.get dns.list dns.upsert dns.delete
```

## Search, check, and price

`domain.search` accepts a keyword and up to 20 optional TLDs. Its availability
and one-year prices are suggestions, not a purchase quote. Search first, then
check and price the exact fully qualified domain:

```bash
npx xapi-to call domain.search \
  --input '{"keyword":"example","tlds":["com","dev","ai"]}'

npx xapi-to call domain.check --input '{"domain":"example.com"}'
npx xapi-to call domain.price --input '{"domain":"example.com","period":1}'
```

`domain.price` is the authoritative pre-registration price at call time. The
current USD billable price includes xAPI's fixed fee; non-USD registrar quotes
are unsupported. Re-price immediately before registration because availability
and upstream prices can change.

## Register a domain

Before calling `domain.register`:

1. Re-run `domain.check` and `domain.price` for the exact domain and period.
2. Show the exact domain, period, current USD price, and `max_price_usd` ceiling.
3. Confirm the registrant contact details and obtain explicit purchase approval.
4. Create one idempotency key for that exact request and reuse it only for retries.

The required contact fields are `first_name`, `last_name`, `address1`, `city`,
`state`, `postal_code`, `country`, `phone`, and `email`. `country` is a two-letter
ISO code. Phone numbers must use `+{country_code}.{number}`, for example
`+86.13800138000`. Do not log contact data or include it in task summaries.

```bash
npx xapi-to call domain.register --input '{
  "domain":"example.com",
  "period":1,
  "max_price_usd":20,
  "idempotency_key":"register-example-com-20260910",
  "auto_renew":false,
  "whois_privacy":true,
  "contact":{
    "first_name":"Given","last_name":"Family",
    "address1":"Street address","city":"City","state":"Region",
    "postal_code":"000000","country":"CN",
    "phone":"+86.13800138000","email":"owner@example.com"
  }
}'
```

`max_price_usd` is a hard final-charge ceiling, not the expected price.
`auto_renew` must currently remain `false`; renewal billing is not available.
Registration is non-refundable. Do not retry with a new key after an ambiguous
failure: first inspect `domain.list` to determine whether the purchase completed.

`domain.get` intentionally does not return the registrant contact. Treat that
privacy boundary as expected rather than assuming registration lost the data.

## DNS workflow

DNS actions use the xAPI `domain_id`, not the domain name. Resolve it with
`domain.list`, inspect the current records, and retain the stable `record_id`:

```bash
npx xapi-to call domain.list --input '{"limit":50,"offset":0}'
npx xapi-to call dns.list --input '{"domain_id":"<domain-id>"}'
```

Create a record by omitting both record identifiers:

```bash
npx xapi-to call dns.upsert --input '{
  "domain_id":"<domain-id>",
  "subdomain":"@","type":"A","value":"203.0.113.10",
  "idempotency_key":"dns-create-root-a-20260910"
}'
```

Update an existing record with its stable `record_id`. `record_index` is a
legacy fallback whose meaning can change when the record set changes; use it
only when a live response lacks `record_id`.

```bash
npx xapi-to call dns.upsert --input '{
  "domain_id":"<domain-id>","record_id":"<record-id>",
  "subdomain":"www","type":"CNAME","value":"example.com.",
  "idempotency_key":"dns-update-www-20260910"
}'

npx xapi-to call dns.delete --input '{
  "domain_id":"<domain-id>","record_id":"<record-id>",
  "idempotency_key":"dns-delete-record-20260910"
}'
```

For every write, confirm the domain, record type/name/value, and stable record
identifier. Reuse an idempotency key only for an identical retry; use a new key
when any requested value changes. After a successful write, call `dns.list`
again and verify the intended state instead of assuming propagation or success.
