# Serper Guide

Use the direct `serper.*` API actions when the task needs provider-native
Google results, several searches in one mini-batch, or Serper surfaces that the
built-in `web.search.*` capabilities do not expose. For a simple single search
with a normalized xAPI response, prefer `web.search.*` and read
`google_search.md` instead.

The current `serper` service exposes 12 v7 actions. They are third-party API
actions, so parameters go inside `body`:

```bash
npx xapi-to get serper.search
npx xapi-to call serper.search --input '{"body":{"q":"OpenAI","gl":"us","hl":"en"}}'
```

Run `get` before relying on optional parameters or response fields. Serper
responses are passed through in provider-native form and can gain fields that
are not declared in the xAPI output schema.

## Mini-batch

Eleven actions accept either one request object or an array of request objects
in `body`. The response is respectively one result object or an array of result
objects in request order:

```bash
npx xapi-to call serper.search --input \
  '{"body":[{"q":"OpenAI","gl":"us","hl":"en"},{"q":"Cloudflare","gl":"us","hl":"en"}]}'
```

Each array member has the same shape as a single request. Do not wrap the
members in `queries`, and do not confuse this with `xapi-to get-batch`, which
retrieves several Action schemas without executing them.

`serper.reviews` is the only current `serper.*` action that does not support
mini-batch. Send exactly one object in its `body`.

## Billing

All 12 actions use dynamic xAPI billing at **$0.002 per Serper credit**. For a
single request, the charge is `response.credits * $0.002`; for a mini-batch it
is `sum(response[*].credits) * $0.002`.

The `cost: 0` placeholder shown in discovery output does not mean the call is
free; dynamic prices are not comparable as a fixed per-call price. Inspect the
Action's `meta.description` and `meta.pricing`, and keep returned `credits` when
auditing usage.

## Current Actions

| Action | Use it for | Primary input |
|---|---|---|
| `serper.search` | General Google web results | `q` |
| `serper.images` | Google Images; current schema accepts `num` 10 or 100 | `q` |
| `serper.news` | Google News results | `q` |
| `serper.videos` | Google video results | `q` |
| `serper.shopping` | Product and shopping results | `q` |
| `serper.scholar` | Academic publications and citations | `q` |
| `serper.patents` | Patent search | `q` |
| `serper.autocomplete` | Suggestions for a partial query | `q` |
| `serper.places` | Local businesses and place search | `q` |
| `serper.maps` | Map search or lookup by Google Place ID/CID | `q`, `placeId`, or `cid` |
| `serper.lens` | Reverse image search from a public image URL | `url` |
| `serper.reviews` | Place reviews and cursor pagination | `placeId`, `cid`, or `fid` |

The common search-family controls are `gl`, `hl`, `location`, `page`, `num`,
`tbs`, and `autocorrect`, but not every action exposes every control. Use the
current `get` schema instead of copying parameters between actions.

## Focused Examples

### News with a Google time filter

```bash
npx xapi-to call serper.news --input \
  '{"body":{"q":"AI regulation","gl":"us","hl":"en","tbs":"qdr:d"}}'
```

### Maps by coordinates

```bash
npx xapi-to call serper.maps --input \
  '{"body":{"q":"coffee","ll":"@40.7455096,-74.0083012,14z","hl":"en"}}'
```

Use `placeId` or `cid` instead of `q` when resolving a known Google place.

### Google Lens

```bash
npx xapi-to call serper.lens --input \
  '{"body":{"url":"https://example.com/public-image.jpg","gl":"us","hl":"en"}}'
```

The image must be reachable through a public URL; a local filesystem path is
not a valid Lens input.

### Reviews and pagination

```bash
# First page; body must be an object, not an array
npx xapi-to call serper.reviews --input \
  '{"body":{"placeId":"ChIJ...","sortBy":"newest","gl":"us","hl":"en"}}'

# Continue with the provider's cursor
npx xapi-to call serper.reviews --input \
  '{"body":{"placeId":"ChIJ...","nextPageToken":"<token>","sortBy":"newest","gl":"us","hl":"en"}}'
```

Current `sortBy` values are `mostRelevant`, `newest`, `highestRating`, and
`lowestRating`.

## Service Boundary

Serper's upstream product also advertises webpage extraction, but the current
xAPI service directory exposes only the 12 `serper.*` actions above. Do not
invent or call `serper.webpage`. Search the live registry first; if a Webpage
Action is added later, use its own discovered Action ID and schema because the
upstream scraper is a separate surface from Google search.

For provider details that are not exposed by `xapi-to get`, consult the current
official Serper documentation at <https://serper.dev/>. xAPI's `body` wrapper,
Action IDs, and billing metadata remain authoritative for calls through xAPI.
