# Weibo Guide

Complete guide for Weibo operations via xAPI — hot search, content search, user profiles, posts, comments, and media.

All Weibo endpoints are API-type actions under the `weibo-app` service. Every call requires `"method": "GET"` in the input and parameters go inside `"params"`.

## Hot Search (热搜)

### Get trending hot search

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__hot__search \
  --input '{"method":"GET","params":{"category":"realtimehot"}}'
```

The `category` parameter selects which trending list to fetch:

| Value | Category |
|-------|----------|
| `realtimehot` | 热搜（default） |
| `social` | 社会 |
| `fun` | 文娱 |
| `technologynav` | 科技 |
| `lifenav` | 生活 |
| `region` | 同城 |
| `sportnav` | 体育 |
| `gamenav` | ACG |

Results are in `data.data.items[]`, which contains multiple groups. Filter for the group with `type: "vertical"` and ~50 sub-items — this is the main hot search list. Each entry has `data.desc` (topic title) and `data.scheme` (deep link). A separate "实时上升热点" group (preceded by a text label) lists ~20 rapidly rising topics.

**Note:** The `count` and `page` parameters are accepted (count max 50) but do not affect the number of results — the full list is always returned.

### Get hot search categories

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__hot__search__categories \
  --input '{"method":"GET"}'
```

No parameters needed. Returns available trending category metadata.

## Search (搜索)

### Comprehensive search

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__search__all \
  --input '{"method":"GET","params":{"query":"AI","search_type":1,"page":1}}'
```

Pagination: `page` is an integer.

The `search_type` parameter controls what to search for:

| Value | Type |
|-------|------|
| `1` | Comprehensive (综合) |
| `61` | Real-time (实时) |
| `3` | Users (用户) |
| `64` | Videos (视频) |
| `63` | Images (图片) |
| `62` | Followed (关注) |
| `60` | Trending (热门) |
| `21` | All platforms (全站) |
| `38` | Topics (话题) |
| `98` | Super topics (超话) |
| `92` | Locations (地点) |
| `97` | Products (商品) |

Results are in `data.data.items[]`, which mixes different `category` types. Filter for items with `category: "feed"` to get posts — their data is in the `.data` sub-object with fields: `text` (HTML), `user`, `created_at`, `reposts_count`, `comments_count`, `attitudes_count`. Items with `category: "group"` are UI elements (e.g. user cards, topic cards) and can be skipped.

### AI smart search

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__ai__smart__search \
  --input '{"method":"GET","params":{"query":"人工智能","page":1}}'
```

AI-powered search that returns curated results. Supports pagination via `page`.

## User Data (用户)

### Get user profile

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__user__info \
  --input '{"method":"GET","params":{"uid":"1669879400"}}'
```

The `uid` is the numeric Weibo user ID. Returns user info at `data.data.header.data.userInfo` with fields including `screen_name`, `description`, `domain`, `lang`, `status`, and more.

**How to find a uid:** Use `fetch_search_all` with `search_type: 3` (user search) to look up a user by name, then extract `uid` from the results.

### Get user detailed profile

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__user__info__detail \
  --input '{"method":"GET","params":{"uid":"1669879400"}}'
```

Returns extended profile at `data.data.userInfo` with additional fields beyond `fetch_user_info`: verification details, badge info, credit score, `urank`, `mbrank`, etc. Also includes `items` sections with structured profile details (education, work history).

### Get user timeline (博文列表)

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__user__timeline \
  --input '{"method":"GET","params":{"uid":"1669879400","page":1}}'
```

Results are in `data.data.items[]`, which mixes different `category` types. Filter for items with `category: "feed"` to get posts — their data is in the `.data` sub-object with fields: `mid` (post ID), `text` (HTML), `created_at`, `reposts_count`, `comments_count`, `attitudes_count`, `user`. Items with `category: "card"` are UI elements and can be skipped.

Optional parameters:
- `page` — page number, integer (default 1)
- `filter_type` — filter type, e.g. `"all"`
- `month` — time filter in YYYYMM format (e.g. `"202604"`)

### Get user articles (头条文章)

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__user__articles \
  --input '{"method":"GET","params":{"uid":"1669879400"}}'
```

Paginate with `since_id` (cursor from previous response).

### Get user super topics (超话)

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__user__super__topics \
  --input '{"method":"GET","params":{"uid":"1669879400","page":1}}'
```

## Post Data (博文)

### Get post detail

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__status__detail \
  --input '{"method":"GET","params":{"status_id":"5284850937629474"}}'
```

The `status_id` is the numeric post ID (same as `mid`). Returns post data at `data.data.detailInfo.status` with: `id`, `mid`, `text`, `created_at`, `source`, `reposts_count`, `comments_count`, `attitudes_count`, `user`.

### Get post comments (评论)

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__status__comments \
  --input '{"method":"GET","params":{"status_id":"5284850937629474","sort_type":"0"}}'
```

`sort_type`: `"0"` = sort by popularity, `"1"` = sort by time. Paginate with `max_id` cursor.

### Get post reposts (转发)

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__status__reposts \
  --input '{"method":"GET","params":{"status_id":"5284850937629474"}}'
```

Paginate with `max_id` cursor.

### Get post likes (点赞)

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__status__likes \
  --input '{"method":"GET","params":{"status_id":"5284850937629474","attitude_type":"0"}}'
```

`attitude_type` values: `"0"` = all, `"1"` = like, `"2"` = happy, `"3"` = surprised, `"4"` = sad, `"5"` = angry, `"6"` = tip, `"8"` = hug.

## Media (多媒体)

### Get user photos (相册)

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__user__album \
  --input '{"method":"GET","params":{"uid":"1669879400"}}'
```

Paginate with `since_id`.

### Get user videos

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__user__videos \
  --input '{"method":"GET","params":{"uid":"1669879400"}}'
```

Paginate with `since_id`.

### Get user audio

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__user__audios \
  --input '{"method":"GET","params":{"uid":"1669879400"}}'
```

Paginate with `since_id`.

### Get video detail

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__video__detail \
  --input '{"method":"GET","params":{"mid":"5284850937629474"}}'
```

Returns video post data at `data.data.status`.

### Get featured video feed

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__video__featured__feed \
  --input '{"method":"GET","params":{}}'
```

For page 2+, pass `"page": "2"` (**string**, not integer). First page should omit the `page` param.

## Feed (信息流)

### Get home recommend feed

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__home__recommend__feed \
  --input '{"method":"GET","params":{"count":15}}'
```

Returns recommended posts from the Weibo homepage feed. For page 2+, pass `"page": "2"` (**string**, not integer). First page should omit `page`.

### Get user homepage feed

```bash
npx xapi-to call weibo-app.api_v1_weibo_app_fetch__user__profile__feed \
  --input '{"method":"GET","params":{"uid":"1669879400"}}'
```

Returns the user's profile page feed (UI-oriented). For post data, prefer `fetch_user_timeline`. Paginate with `since_id`.

## Common Workflows

### Monitor trending topics

1. Fetch hot search: `weibo-app.api_v1_weibo_app_fetch__hot__search` with `category: "realtimehot"` → get top 50 topics
2. Search a topic: `weibo-app.api_v1_weibo_app_fetch__search__all` with `query: "<topic>"` → find relevant posts
3. Get post details: `weibo-app.api_v1_weibo_app_fetch__status__detail` → read full content and engagement

### Research a Weibo user

1. Search user: `weibo-app.api_v1_weibo_app_fetch__search__all` with `search_type: 3` and `query: "<name>"` → find uid
2. Get profile: `weibo-app.api_v1_weibo_app_fetch__user__info` → basic info (followers, bio, verification)
3. Get timeline: `weibo-app.api_v1_weibo_app_fetch__user__timeline` → recent posts with engagement stats
4. Get media: `weibo-app.api_v1_weibo_app_fetch__user__album` / `weibo-app.api_v1_weibo_app_fetch__user__videos` → photos and videos

### Analyze post engagement

1. Get post: `weibo-app.api_v1_weibo_app_fetch__status__detail` → reposts_count, comments_count, attitudes_count
2. Read comments: `weibo-app.api_v1_weibo_app_fetch__status__comments` with `sort_type: "0"` → top comments
3. Check reposts: `weibo-app.api_v1_weibo_app_fetch__status__reposts` → who reposted
4. Check likes: `weibo-app.api_v1_weibo_app_fetch__status__likes` → who liked

## API Reference

| API | Description | Key Params |
|-----|-------------|------------|
| `weibo-app.api_v1_weibo_app_fetch__hot__search` | Hot search trending list | `category` |
| `weibo-app.api_v1_weibo_app_fetch__hot__search__categories` | Hot search categories | — |
| `weibo-app.api_v1_weibo_app_fetch__search__all` | Comprehensive search | `query`, `search_type`, `page` |
| `weibo-app.api_v1_weibo_app_fetch__ai__smart__search` | AI smart search | `query`, `page` |
| `weibo-app.api_v1_weibo_app_fetch__user__info` | User basic profile | `uid` |
| `weibo-app.api_v1_weibo_app_fetch__user__info__detail` | User extended profile | `uid` |
| `weibo-app.api_v1_weibo_app_fetch__user__timeline` | User's posts | `uid`, `page` |
| `weibo-app.api_v1_weibo_app_fetch__user__profile__feed` | User homepage feed | `uid`, `since_id` |
| `weibo-app.api_v1_weibo_app_fetch__user__articles` | User's articles | `uid`, `since_id` |
| `weibo-app.api_v1_weibo_app_fetch__user__super__topics` | User's super topics | `uid`, `page` |
| `weibo-app.api_v1_weibo_app_fetch__status__detail` | Post detail | `status_id` |
| `weibo-app.api_v1_weibo_app_fetch__status__comments` | Post comments | `status_id`, `sort_type` |
| `weibo-app.api_v1_weibo_app_fetch__status__reposts` | Post reposts | `status_id`, `max_id` |
| `weibo-app.api_v1_weibo_app_fetch__status__likes` | Post likes | `status_id`, `attitude_type` |
| `weibo-app.api_v1_weibo_app_fetch__user__album` | User photos | `uid`, `since_id` |
| `weibo-app.api_v1_weibo_app_fetch__user__videos` | User videos | `uid`, `since_id` |
| `weibo-app.api_v1_weibo_app_fetch__user__audios` | User audio | `uid`, `since_id` |
| `weibo-app.api_v1_weibo_app_fetch__video__detail` | Video detail | `mid` |
| `weibo-app.api_v1_weibo_app_fetch__video__featured__feed` | Featured videos | `page` |
| `weibo-app.api_v1_weibo_app_fetch__home__recommend__feed` | Home recommend feed | `count`, `page` |

## Error Handling

- **422 Validation Error** → Check parameter types and ranges (e.g. `count` must be 1–50)
- **Empty results** → Verify `uid` or `status_id` is correct; use search to find valid IDs
- **Pagination** → Use `since_id` (cursor) or `page` depending on the endpoint; check response for next cursor value
