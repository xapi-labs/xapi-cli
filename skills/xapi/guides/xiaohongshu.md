# 小红书 (Xiaohongshu / RedNote) Guide

Complete guide for Xiaohongshu (小红书) operations via xAPI — user profiles, notes, comments, search, topics, products, and creator inspiration.

All Xiaohongshu endpoints are API-type actions under the `xiaohongshu` service. Every call requires `"method": "GET"` in the input and parameters go inside `"params"`.

**Tip:** Many endpoints accept both a direct ID (e.g. `user_id`, `note_id`) and a `share_text` (share link). You can use either one.

## User Data

### Get user info

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__user__info \
  --input '{"method":"GET","params":{"user_id":"<user_id>"}}'
```

Can also pass `share_text` (share link) instead of `user_id`.

### Get user's posted notes

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__user__posted__notes \
  --input '{"method":"GET","params":{"user_id":"<user_id>"}}'
```

Optional parameters:
- `cursor` — pagination cursor, leave empty for first request; pass last `note_id` from previous response
- `share_text` — can use share link instead of `user_id`

### Get user's faved notes

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__user__faved__notes \
  --input '{"method":"GET","params":{"user_id":"<user_id>"}}'
```

Optional parameters:
- `cursor` — pagination cursor, pass last `note_id` from previous response
- `share_text` — share link alternative

## Note Data

### Get image note detail

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__image__note__detail \
  --input '{"method":"GET","params":{"note_id":"<note_id>"}}'
```

Use this for image-type notes. Can also pass `share_text` instead of `note_id`.

### Get video note detail

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__video__note__detail \
  --input '{"method":"GET","params":{"note_id":"<note_id>"}}'
```

Use this for video-type notes. Can also pass `share_text` instead of `note_id`.

### Get mixed note detail

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__mixed__note__detail \
  --input '{"method":"GET","params":{"note_id":"<note_id>"}}'
```

Auto-detects note type (image or video) from feed. Can also pass `share_text` instead of `note_id`.

**Tip:** If you don't know whether a note is image or video, use `get__mixed__note__detail` — it handles both types.

### Get note comments

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__note__comments \
  --input '{"method":"GET","params":{"note_id":"<note_id>","index":0}}'
```

Optional parameters:
- `index` — comment index, pass `0` for first request
- `cursor` — pagination cursor, leave empty for first request
- `sort_strategy` — `default`, `latest_v2` (最新), `like_count` (最热)
- `share_text` — share link alternative

## Search

### Search notes

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_search__notes \
  --input '{"method":"GET","params":{"keyword":"咖啡推荐","page":1}}'
```

Optional parameters:
- `page` — page number, start from 1
- `note_type` — `不限` (all), `视频笔记` (video), `普通笔记` (image), `直播笔记` (live)
- `sort_type` — sort type
- `time_filter` — `不限` (all), `一天内` (1 day), `一周内` (1 week), `半年内` (6 months)
- `ai_mode` — `0` = off, `1` = on (AI-enhanced search)
- `search_id` — for pagination consistency
- `search_session_id` — for pagination consistency

### Search users

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_search__users \
  --input '{"method":"GET","params":{"keyword":"美食博主","page":1}}'
```

Optional: `page`, `search_id`.

### Search images

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_search__images \
  --input '{"method":"GET","params":{"keyword":"壁纸","page":1}}'
```

Optional: `page`, `search_id`, `word_request_id`, `search_session_id`.

### Search groups

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_search__groups \
  --input '{"method":"GET","params":{"keyword":"摄影","page_no":0}}'
```

Optional parameters:
- `page_no` — page number, start from **0** (not 1)
- `is_recommend` — `0` = no, `1` = yes
- `search_id` — for pagination

### Search products

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_search__products \
  --input '{"method":"GET","params":{"keyword":"面霜","page":1}}'
```

Optional: `page`, `search_id`.

## Topics

### Get topic info

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__topic__info \
  --input '{"method":"GET","params":{"page_id":"<topic_page_id>"}}'
```

Optional: `note_id` — pass when jumping from a specific note to its topic.

### Get topic feed

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__topic__feed \
  --input '{"method":"GET","params":{"page_id":"<topic_page_id>","sort":"trend"}}'
```

Optional parameters:
- `sort` — `trend` (最热), `time` (最新)
- `cursor_score` — pagination cursor score for next page
- `last_note_id` — last note ID from previous page
- `last_note_ct` — last note create time from previous page
- `session_id` — keep consistent across pagination
- `first_load_time` — keep consistent across pagination

## Products (商品)

### Get product detail

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__product__detail \
  --input '{"method":"GET","params":{"sku_id":"<sku_id>"}}'
```

### Get product reviews

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__product__reviews \
  --input '{"method":"GET","params":{"sku_id":"<sku_id>","page":0}}'
```

Optional parameters:
- `page` — page number, start from **0**
- `sort_strategy_type` — `0` = general, `1` = latest
- `share_pics_only` — `0` = all reviews, `1` = only reviews with images

### Get product review overview

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__product__review__overview \
  --input '{"method":"GET","params":{"sku_id":"<sku_id>"}}'
```

Optional: `tab`.

### Get product recommendations

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__product__recommendations \
  --input '{"method":"GET","params":{"sku_id":"<sku_id>"}}'
```

Optional: `cursor_score` for pagination, `region`.

## Creator Inspiration (创作灵感)

### Get creator inspiration feed

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__creator__inspiration__feed \
  --input '{"method":"GET","params":{}}'
```

Optional parameters:
- `tab` — tab type
- `cursor` — pagination cursor

### Get creator hot inspiration feed

```bash
npx xapi-to call xiaohongshu.api_v1_xiaohongshu_app__v2_get__creator__hot__inspiration__feed \
  --input '{"method":"GET","params":{}}'
```

Optional: `cursor` for pagination.

## Common Workflows

### Research a Xiaohongshu user

1. Get user info: `xiaohongshu...get__user__info` with `user_id` → profile, follower stats
2. Get posted notes: `xiaohongshu...get__user__posted__notes` → browse content
3. Get faved notes: `xiaohongshu...get__user__faved__notes` → what they like

### Analyze a note

1. Get note detail: `xiaohongshu...get__mixed__note__detail` with `note_id` → full note data
2. Get comments: `xiaohongshu...get__note__comments` with `sort_strategy=like_count` → top comments

### Discover content by topic

1. Get topic info: `xiaohongshu...get__topic__info` with `page_id` → topic metadata
2. Get topic feed: `xiaohongshu...get__topic__feed` with `sort=trend` → trending notes in topic

### Research a product

1. Get product detail: `xiaohongshu...get__product__detail` with `sku_id` → product info
2. Get review overview: `xiaohongshu...get__product__review__overview` → rating summary
3. Get reviews: `xiaohongshu...get__product__reviews` → detailed reviews
4. Get recommendations: `xiaohongshu...get__product__recommendations` → similar products

### Search content

1. Search notes: `xiaohongshu...search__notes` with `keyword` → find relevant notes
2. Search users: `xiaohongshu...search__users` → find creators
3. Search products: `xiaohongshu...search__products` → find products

## Pagination Patterns

| Pattern | Endpoints | How to use |
|---------|-----------|------------|
| `cursor` (note_id) | user posted/faved notes | Pass last `note_id` from previous response |
| `cursor` | comments, creator feed, product recommendations | Pass `cursor` from previous response |
| `page` (from 1) | search notes/users/images/products | Increment `page` by 1 |
| `page_no` (from 0) | search groups | Increment `page_no` by 1 |
| `page` (from 0) | product reviews | Increment `page` by 1 |
| `cursor_score` + `last_note_id` | topic feed | Pass both from previous response |

## API Reference

| API (prefix: `xiaohongshu.api_v1_xiaohongshu_app__v2_`) | Description | Key Params |
|---|---|---|
| `get__user__info` | User profile | `user_id` or `share_text` |
| `get__user__posted__notes` | User's notes | `user_id`, `cursor` |
| `get__user__faved__notes` | User's favorites | `user_id`, `cursor` |
| `get__image__note__detail` | Image note detail | `note_id` or `share_text` |
| `get__video__note__detail` | Video note detail | `note_id` or `share_text` |
| `get__mixed__note__detail` | Mixed note detail (auto-detect) | `note_id` or `share_text` |
| `get__note__comments` | Note comments | `note_id`, `index`, `cursor`, `sort_strategy` |
| `search__notes` | Search notes | `keyword`*, `page`, `note_type`, `time_filter` |
| `search__users` | Search users | `keyword`*, `page` |
| `search__images` | Search images | `keyword`*, `page` |
| `search__groups` | Search groups | `keyword`*, `page_no` |
| `search__products` | Search products | `keyword`*, `page` |
| `get__topic__info` | Topic info | `page_id`* |
| `get__topic__feed` | Topic feed | `page_id`*, `sort`, `cursor_score` |
| `get__product__detail` | Product detail | `sku_id`* |
| `get__product__reviews` | Product reviews | `sku_id`*, `page`, `sort_strategy_type` |
| `get__product__review__overview` | Product review overview | `sku_id`* |
| `get__product__recommendations` | Product recommendations | `sku_id`*, `cursor_score` |
| `get__creator__inspiration__feed` | Creator inspiration feed | `tab`, `cursor` |
| `get__creator__hot__inspiration__feed` | Creator hot inspiration | `cursor` |

## Error Handling

- **Missing note_id** → Use `search__notes` to find notes, or parse `note_id` from share links
- **Image vs Video note** → If unsure, use `get__mixed__note__detail` which auto-detects
- **Pagination: page starts from 0 or 1** → Check endpoint docs: search notes/users/images start from `1`, search groups and product reviews start from `0`
- **Empty results** → Verify the `user_id`, `note_id`, or `sku_id` is valid
