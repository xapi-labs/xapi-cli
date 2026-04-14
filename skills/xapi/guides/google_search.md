# Google Search Guide

Complete guide for web search operations via xAPI — general search, realtime search, news, images, videos, scholar, maps, places, and shopping.

All search endpoints are capability-type actions under the `web.search` namespace. Parameters are passed directly (no `"method"` or `"params"` wrapper needed).

## Common Parameters

All search capabilities share these parameters:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | **(required)** | Search query |
| `gl` | string | `"us"` | Country code (e.g. `us`, `cn`, `jp`, `de`) |
| `hl` | string | `"en"` | Language code (e.g. `en`, `zh`, `ja`, `de`) |
| `page` | number | `1` | Page number for pagination |
| `autocorrect` | boolean | `true` | Whether to autocorrect the query |

## Web Search

### General web search

```bash
npx xapi-to call web.search --input '{"q":"OpenAI GPT-5","num":10}'
```

Additional parameters:
- `num` — number of results to return (default 10)
- `location` — location name for localized results

Returns `data.organic[]` with fields: `title`, `link`, `snippet`, `position`. May also include `data.knowledgeGraph` (structured entity info), `data.relatedSearches[]`, and `data.peopleAlsoAsk[]` (with `question`, `snippet`, `title`, `link`).

### Realtime web search

```bash
npx xapi-to call web.search.realtime --input '{"q":"breaking news","timeRange":"day","num":10}'
```

For finding the latest content with time-based filtering.

Additional parameters:
- `timeRange` — time filter: `"hour"`, `"day"` (default), `"week"`, `"month"`, `"year"`
- `num` — number of results (default 10)
- `location` — location for localized results

Returns `data.organic[]` with fields: `title`, `link`, `snippet`, `position`, `date`.

## News Search

```bash
npx xapi-to call web.search.news --input '{"q":"AI regulation"}'
```

Search Google News for articles.

Additional parameters:
- `tbs` — date range filter: `"qdr:h"` (past hour), `"qdr:d"` (past 24h), `"qdr:w"` (past week), `"qdr:m"` (past month), `"qdr:y"` (past year)

Returns `data.news[]` with fields: `title`, `link`, `snippet`, `date`, `source`, `imageUrl`.

## Image Search

```bash
npx xapi-to call web.search.image --input '{"q":"aurora borealis"}'
```

Search Google Images.

Additional parameters:
- `tbs` — date range filter (same values as news)

Returns `data.images[]` with fields: `title`, `imageUrl`, `imageWidth`, `imageHeight`, `thumbnailUrl`, `source`, `domain`, `link`.

## Video Search

```bash
npx xapi-to call web.search.video --input '{"q":"machine learning tutorial"}'
```

Search Google Videos (primarily YouTube results).

Additional parameters:
- `tbs` — date range filter (same values as news)

Returns `data.videos[]` with fields: `title`, `link`, `snippet`, `channel`, `date`, `duration`, `imageUrl`, `videoUrl`, `source`, `position`.

## Scholar Search

```bash
npx xapi-to call web.search.scholar --input '{"q":"transformer architecture attention"}'
```

Search Google Scholar for academic papers and citations.

Returns `data.organic[]` with fields: `title`, `link`, `snippet`, `publicationInfo`, `citedBy`, `year`, `pdfUrl`.

## Maps Search

```bash
npx xapi-to call web.search.maps --input '{"q":"coffee shop near Times Square"}'
```

Search Google Maps for locations and businesses.

Additional parameters:
- `ll` — latitude/longitude coordinates to center the search (e.g. `"@40.7455096,-74.0083012,14z"`)

Returns `data.places[]` with fields: `title`, `address`, `latitude`, `longitude`, `rating`, `ratingCount`, `type`, `types`, `phoneNumber`, `website`, `openingHours`, `priceLevel`, `thumbnailUrl`, `position`.

## Places Search

```bash
npx xapi-to call web.search.places --input '{"q":"best ramen in Tokyo","gl":"jp"}'
```

Search for businesses with basic listing information. For richer details (phone, website, opening hours), use `web.search.maps` instead.

Additional parameters:
- `location` — location name to scope the search (e.g. `"San Francisco, California, United States"`)
- `ll` — latitude/longitude coordinates (e.g. `"@37.7749295,-122.4194155,14z"`)

Returns `data.places[]` with fields: `title`, `address`, `latitude`, `longitude`, `rating`, `ratingCount`, `category`, `priceLevel`, `position`.

## Shopping Search

```bash
npx xapi-to call web.search.shopping --input '{"q":"mechanical keyboard"}'
```

Search Google Shopping for products and prices.

Additional parameters:
- `tbs` — date range filter
- `location` — location affecting prices and availability

Returns `data.shopping[]` with fields: `title`, `source`, `link`, `price`, `imageUrl`, `productId`, `position`. Some items also include `rating` and `ratingCount`.

## Common Workflows

### Research a topic

1. Web search: `web.search` → get authoritative sources
2. News search: `web.search.news` → get latest developments
3. Scholar search: `web.search.scholar` → find academic papers

### Monitor breaking news

1. Realtime search: `web.search.realtime` with `timeRange: "hour"` → latest content
2. News search: `web.search.news` with `tbs: "qdr:h"` → latest news articles

### Find a local business

1. Maps search: `web.search.maps` with `ll` coordinates → find nearby places with rich details (phone, website, hours)
2. Places search: `web.search.places` → get basic business listings with category and price level

### Product research

1. Shopping search: `web.search.shopping` → compare prices and ratings
2. Web search: `web.search` with `"<product> review"` → find reviews

## Localization Tips

- Set `gl` (country) and `hl` (language) together for best results:
  - Chinese results: `"gl":"cn","hl":"zh"`
  - Japanese results: `"gl":"jp","hl":"ja"`
  - German results: `"gl":"de","hl":"de"`
- Use `location` (for `web.search`, `web.search.realtime`, `web.search.places`, `web.search.shopping`) for city-level localization

## API Reference

| Capability | Description | Result Field | Key Result Fields |
|------------|-------------|--------------|-------------------|
| `web.search` | General web search | `organic[]` | `title`, `link`, `snippet`, `position` |
| `web.search.realtime` | Realtime web search | `organic[]` | `title`, `link`, `snippet`, `date` |
| `web.search.news` | News articles | `news[]` | `title`, `link`, `source`, `date` |
| `web.search.image` | Image search | `images[]` | `title`, `imageUrl`, `imageWidth`, `imageHeight` |
| `web.search.video` | Video search | `videos[]` | `title`, `link`, `channel`, `duration`, `videoUrl` |
| `web.search.scholar` | Academic papers | `organic[]` | `title`, `link`, `citedBy`, `year`, `pdfUrl` |
| `web.search.maps` | Map locations (rich) | `places[]` | `title`, `address`, `rating`, `type`, `phoneNumber`, `website` |
| `web.search.places` | Business listings | `places[]` | `title`, `address`, `rating`, `category`, `priceLevel` |
| `web.search.shopping` | Product search | `shopping[]` | `title`, `price`, `source`, `productId` |
