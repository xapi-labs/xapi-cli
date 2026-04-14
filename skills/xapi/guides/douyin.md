# Douyin (抖音) Guide

Complete guide for Douyin (抖音) operations via xAPI — user profiles, videos, comments, hot search, hashtags, music, and video statistics.

All Douyin endpoints are API-type actions under the `douyin` service. Every call requires `"method": "GET"` in the input and parameters go inside `"params"`.

## User Data

### Get user profile

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_handler__user__profile \
  --input '{"method":"GET","params":{"sec_user_id":"<sec_user_id>"}}'
```

Requires `sec_user_id`. Returns user info at `data.data.user`.

### Get user's videos

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__user__post__videos \
  --input '{"method":"GET","params":{"sec_user_id":"<sec_user_id>","count":10}}'
```

Requires `sec_user_id`. Paginate with `max_cursor`. Optional: `sort_type`.

### Get user's liked videos

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__user__like__videos \
  --input '{"method":"GET","params":{"sec_user_id":"<sec_user_id>","counts":10}}'
```

Requires `sec_user_id`. Paginate with `max_cursor`. Note: the parameter is `counts` (with 's'), not `count`.

### Get user fans list

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__user__fans__list \
  --input '{"method":"GET","params":{"sec_user_id":"<sec_user_id>","count":20}}'
```

Paginate with `max_time`.

### Get user series list

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__user__series__list \
  --input '{"method":"GET","params":{"sec_user_id":"<sec_user_id>"}}'
```

## Video Data

### Get video by ID

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__one__video \
  --input '{"method":"GET","params":{"aweme_id":"<video_id>"}}'
```

Also available: V2 (`fetch__one__video__v2`) and V3 (`fetch__one__video__v3`, no copyright restrictions).

### Get video by share URL

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__one__video__by__share__url \
  --input '{"method":"GET","params":{"share_url":"https://v.douyin.com/xxxxx/"}}'
```

### Batch get videos

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__multi__video \
  --input '{"method":"GET","params":{"aweme_ids":"id1,id2,id3"}}'
```

Also available: V2 (`fetch__multi__video__v2`).

### Get video statistics

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__video__statistics \
  --input '{"method":"GET","params":{"aweme_ids":"<video_id>"}}'
```

Returns like count, download count, play count, share count. Supports comma-separated IDs for batch queries.

### Get high quality play URL

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__video__high__quality__play__url \
  --input '{"method":"GET","params":{"aweme_id":"<video_id>"}}'
```

Returns the highest quality video play URL.

### Get video comments

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__video__comments \
  --input '{"method":"GET","params":{"aweme_id":"<video_id>","count":20,"cursor":0}}'
```

Paginate with `cursor`.

### Get comment replies

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__video__comment__replies \
  --input '{"method":"GET","params":{"item_id":"<video_id>","comment_id":"<comment_id>","count":20,"cursor":0}}'
```

## Video Mix (合集)

### Get video mix detail

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__video__mix__detail \
  --input '{"method":"GET","params":{"mix_id":"<mix_id>"}}'
```

### Get video mix post list

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__video__mix__post__list \
  --input '{"method":"GET","params":{"mix_id":"<mix_id>","count":20,"cursor":0}}'
```

Paginate with `cursor`.

### Get series detail

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__series__detail \
  --input '{"method":"GET","params":{"series_id":"<series_id>"}}'
```

### Get series video list

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__series__video__list \
  --input '{"method":"GET","params":{"series_id":"<series_id>"}}'
```

## Hot Search (热搜)

### Get Douyin hot search list

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__hot__search__list \
  --input '{"method":"GET","params":{}}'
```

Returns ~50 trending topics at `data.data.data.word_list[]`. Most entries have fields: `word` (topic title), `hot_value`, `view_count`, `event_time`, `position`. Pinned/top entries may only have `word`, `hot_value`, `view_count` without `event_time` or `position`.

Optional: `board_type`, `board_sub_type` for different ranking categories.

### Get brand hot search list

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__brand__hot__search__list \
  --input '{"method":"GET","params":{}}'
```

### Get live hot search list

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__live__hot__search__list \
  --input '{"method":"GET","params":{}}'
```

## Hashtags

### Get hashtag details

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__hashtag__detail \
  --input '{"method":"GET","params":{"ch_id":123456}}'
```

Note: `ch_id` is an **integer** for Douyin.

### Get hashtag video list

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__hashtag__video__list \
  --input '{"method":"GET","params":{"ch_id":"<hashtag_id>","count":20,"cursor":0}}'
```

Optional: `sort_type` — `0` = comprehensive, `1` = most likes, `2` = latest first.

## Music

### Get music details

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__music__detail \
  --input '{"method":"GET","params":{"music_id":"<music_id>"}}'
```

### Get music video list

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__music__video__list \
  --input '{"method":"GET","params":{"music_id":"<music_id>"}}'
```

### Get music hot search list

```bash
npx xapi-to call douyin.api_v1_douyin_app_v3_fetch__music__hot__search__list \
  --input '{"method":"GET","params":{}}'
```

## Common Workflows

### Track Douyin trending

1. Hot search: `douyin...fetch__hot__search__list` → top 50 trending topics
2. Brand hot search: `douyin...fetch__brand__hot__search__list` → brand trending
3. Get video details for a trending topic

### Research a Douyin creator

1. Get profile: `douyin...handler__user__profile` with `sec_user_id` → user info
2. Get videos: `douyin...fetch__user__post__videos` → browse recent posts
3. Get stats: `douyin...fetch__video__statistics` → batch check engagement metrics

### Analyze a Douyin video

1. Get video: `douyin...fetch__one__video` with `aweme_id` → full video data
2. Get stats: `douyin...fetch__video__statistics` → play count, likes, downloads, shares
3. Read comments: `douyin...fetch__video__comments` → top comments
4. Get replies: `douyin...fetch__video__comment__replies` → comment threads

### Browse a video series

1. Get series: `douyin...fetch__series__detail` or `douyin...fetch__video__mix__detail`
2. List videos: `douyin...fetch__series__video__list` or `douyin...fetch__video__mix__post__list`

## Pagination Patterns

| Pattern | Endpoints | How to use |
|---------|-----------|------------|
| `max_cursor` | user videos, liked videos | Pass `max_cursor` from previous response |
| `cursor` | comments, hashtag videos, mix post list | Pass `cursor` from previous response |
| `max_time` | fans list | Pass `max_time` from previous response |

## API Reference

| API (prefix: `douyin.api_v1_douyin_app_v3_`) | Description | Key Params |
|---|---|---|
| `handler__user__profile` | Get user profile | `sec_user_id` |
| `fetch__user__post__videos` | User's videos | `sec_user_id`, `count`, `max_cursor` |
| `fetch__user__like__videos` | User's liked videos | `sec_user_id`, `counts`, `max_cursor` |
| `fetch__user__fans__list` | User's fans | `sec_user_id`, `count`, `max_time` |
| `fetch__user__series__list` | User's series | `sec_user_id` |
| `fetch__one__video` | Single video | `aweme_id` |
| `fetch__one__video__v2` | Single video V2 | `aweme_id` |
| `fetch__one__video__v3` | Single video V3 (no copyright restrictions) | `aweme_id` |
| `fetch__one__video__by__share__url` | Video by share URL | `share_url` |
| `fetch__multi__video` | Batch get videos | `aweme_ids` |
| `fetch__video__statistics` | Video stats (batch) | `aweme_ids` |
| `fetch__video__high__quality__play__url` | High quality play URL | `aweme_id` |
| `fetch__video__comments` | Video comments | `aweme_id`, `count`, `cursor` |
| `fetch__video__comment__replies` | Comment replies | `item_id`, `comment_id`, `count`, `cursor` |
| `fetch__video__mix__detail` | Video mix detail | `mix_id` |
| `fetch__video__mix__post__list` | Video mix posts | `mix_id`, `count`, `cursor` |
| `fetch__series__detail` | Series detail | `series_id` |
| `fetch__series__video__list` | Series videos | `series_id` |
| `fetch__hot__search__list` | Hot search list | `board_type`, `board_sub_type` |
| `fetch__brand__hot__search__list` | Brand hot search | — |
| `fetch__live__hot__search__list` | Live hot search | — |
| `fetch__hashtag__detail` | Hashtag details | `ch_id` (integer) |
| `fetch__hashtag__video__list` | Hashtag videos | `ch_id`, `count`, `cursor`, `sort_type` |
| `fetch__music__detail` | Music details | `music_id` |
| `fetch__music__video__list` | Music videos | `music_id` |
| `fetch__music__hot__search__list` | Music hot search | — |

## Error Handling

- **Missing sec_user_id** → Douyin requires `sec_user_id` for most user-related endpoints; obtain it through other channels
- **Empty results** → Check that `aweme_id`, `ch_id`, `mix_id`, or `music_id` is valid
- **Pagination exhausted** → When `has_more` is `0` or `false`, no more pages available
