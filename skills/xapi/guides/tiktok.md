# TikTok Guide

Complete guide for TikTok operations via xAPI — user profiles, videos, comments, search, hashtags, music, live rooms, and recommended feed.

All TikTok endpoints are API-type actions under the `tiktok` service. Every call requires `"method": "GET"` in the input and parameters go inside `"params"`.

## User Data

### Get user profile

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_handler__user__profile \
  --input '{"method":"GET","params":{"unique_id":"tiktok"}}'
```

Look up a user by `unique_id` (username), `user_id` (numeric), or `sec_user_id`. At least one must be provided.

Returns `data.data.user` with fields: `uid`, `unique_id`, `nickname`, `signature`, `follower_count`, `following_count`, `total_favorited`, `aweme_count`, `avatar_thumb`, `avatar_medium`, `sec_uid`.

**Important:** The user profile returns `sec_uid`, but other TikTok APIs expect the parameter name `sec_user_id`. Pass the value of `sec_uid` as `sec_user_id` when calling other endpoints.

### Get user_id and sec_user_id by username

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_get__user__id__and__sec__user__id__by__username \
  --input '{"method":"GET","params":{"username":"tiktok"}}'
```

**Important:** Many TikTok actions require `sec_user_id` instead of the username. Use this endpoint or `handler_user_profile` to get it first.

### Get user's videos

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__user__post__videos \
  --input '{"method":"GET","params":{"unique_id":"tiktok","count":10}}'
```

Can also pass `sec_user_id` instead of `unique_id`. Paginate with `max_cursor` from previous response.

Optional parameters:
- `count` — items per page
- `sort_type` — sort type
- `max_cursor` — pagination cursor

For faster response with simplified data, use the V3 endpoint: `tiktok.api_v1_tiktok_app_v3_fetch__user__post__videos__v3`.

### Get user's liked videos

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__user__like__videos \
  --input '{"method":"GET","params":{"sec_user_id":"<sec_user_id>","counts":10}}'
```

Requires `sec_user_id`. Paginate with `max_cursor`. Note: the parameter is `counts` (with 's'), not `count`.

### Get followers / following

```bash
# Followers
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__user__follower__list \
  --input '{"method":"GET","params":{"user_id":"107955","count":20}}'

# Following
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__user__following__list \
  --input '{"method":"GET","params":{"user_id":"107955","count":20}}'
```

Pass either `user_id` or `sec_user_id`. Paginate with `min_time` and `page_token` from previous response.

### Get similar user recommendations

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__similar__user__recommendations \
  --input '{"method":"GET","params":{"user_id":"107955"}}'
```

## Video Data

### Get video by ID

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__one__video__v2 \
  --input '{"method":"GET","params":{"aweme_id":"<video_id>"}}'
```

The `aweme_id` is the numeric video ID. Returns full video data including `desc`, `statistics`, `author`, `music`, `video` (with play URLs).

### Get video by share URL

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__one__video__by__share__url__v2 \
  --input '{"method":"GET","params":{"share_url":"https://www.tiktok.com/@user/video/1234567890"}}'
```

### Batch get videos

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__multi__video__v2 \
  --input '{"method":"GET","params":{"aweme_ids":"id1,id2,id3"}}'
```

### Get video comments

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__video__comments \
  --input '{"method":"GET","params":{"aweme_id":"<video_id>","count":20,"cursor":0}}'
```

Paginate with `cursor`.

### Get comment replies

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__video__comment__replies \
  --input '{"method":"GET","params":{"item_id":"<video_id>","comment_id":"<comment_id>","count":20,"cursor":0}}'
```

## Search

### General search (comprehensive)

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__general__search__result \
  --input '{"method":"GET","params":{"keyword":"cat","count":10}}'
```

Returns mixed results (videos, users, hashtags). Paginate with `offset`.

Optional parameters:
- `sort_type` — sort type
- `publish_time` — publish time filter

### Video search

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__video__search__result \
  --input '{"method":"GET","params":{"keyword":"cooking","count":10}}'
```

Optional: `region`, `sort_type`, `publish_time`. Paginate with `offset`.

### User search

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__user__search__result \
  --input '{"method":"GET","params":{"keyword":"chef","count":10}}'
```

Optional filters: `user_search_follower_count`, `user_search_profile_type`. Paginate with `offset`.

### Music search

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__music__search__result \
  --input '{"method":"GET","params":{"keyword":"pop","count":10}}'
```

Optional: `region`, `filter_by`, `sort_type`. Paginate with `offset`.

### Hashtag search

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__hashtag__search__result \
  --input '{"method":"GET","params":{"keyword":"dance","count":10}}'
```

Paginate with `offset`.

## Hashtags

### Get hashtag details

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__hashtag__detail \
  --input '{"method":"GET","params":{"ch_id":"<hashtag_id>"}}'
```

### Get hashtag video list

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__hashtag__video__list \
  --input '{"method":"GET","params":{"ch_id":"<hashtag_id>","count":20,"cursor":0}}'
```

Paginate with `cursor`.

## Music

### Get music details

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__music__detail \
  --input '{"method":"GET","params":{"music_id":"<music_id>"}}'
```

### Get videos using a music

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__music__video__list \
  --input '{"method":"GET","params":{"music_id":"<music_id>","count":20,"cursor":0}}'
```

Paginate with `cursor`.

## Live

### Get live room info

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__live__room__info \
  --input '{"method":"GET","params":{"room_id":"<room_id>"}}'
```

### Check if live room is online

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_check__live__room__online \
  --input '{"method":"GET","params":{"room_id":"<room_id>"}}'
```

### Batch check live rooms online

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_check__live__room__online__batch \
  --input '{"method":"GET","params":{"room_ids":"id1,id2,id3"}}'
```

### Get live search results

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__live__search__result \
  --input '{"method":"GET","params":{"keyword":"gaming"}}'
```

## Feed

### Get home feed (recommended videos)

```bash
npx xapi-to call tiktok.api_v1_tiktok_app_v3_fetch__home__feed \
  --input '{"method":"GET","params":{}}'
```

Returns recommended "For You" page videos. **Note:** This endpoint may return empty results depending on account/region configuration.

## Common Workflows

### Research a TikTok creator

1. Look up user: `tiktok...handler__user__profile` with `unique_id` → get `uid`, `sec_user_id`, follower stats
2. Get videos: `tiktok...fetch__user__post__videos` → browse recent content
3. Check engagement: view `statistics` in each video (play count, likes, comments, shares)

### Analyze a TikTok video

1. Get video: `tiktok...fetch__one__video__v2` with `aweme_id` → full video data
2. Read comments: `tiktok...fetch__video__comments` → top comments
3. Get replies: `tiktok...fetch__video__comment__replies` → comment threads

### Discover content by hashtag

1. Search hashtags: `tiktok...fetch__hashtag__search__result` with `keyword` → find hashtag IDs
2. Get details: `tiktok...fetch__hashtag__detail` with `ch_id` → view count, video count
3. Browse videos: `tiktok...fetch__hashtag__video__list` → videos using this hashtag

## Pagination Patterns

| Pattern | Endpoints | How to use |
|---------|-----------|------------|
| `max_cursor` | user videos, liked videos | Pass `max_cursor` from previous response |
| `cursor` | comments, hashtag videos, music videos | Pass `cursor` from previous response |
| `offset` | all search endpoints | Increment by `count` each page |
| `min_time` + `page_token` | follower/following lists | Pass both from previous response |

## API Reference

| API (prefix: `tiktok.api_v1_tiktok_app_v3_`) | Description | Key Params |
|---|---|---|
| `handler__user__profile` | Get user profile | `unique_id` or `user_id` or `sec_user_id` |
| `get__user__id__and__sec__user__id__by__username` | Get IDs by username | `username` |
| `fetch__user__post__videos` | User's videos | `unique_id` or `sec_user_id`, `count`, `max_cursor` |
| `fetch__user__post__videos__v3` | User's videos (simplified) | `unique_id` or `sec_user_id`, `count`, `max_cursor` |
| `fetch__user__like__videos` | User's liked videos | `sec_user_id`, `counts`, `max_cursor` |
| `fetch__user__follower__list` | User's followers | `user_id` or `sec_user_id`, `count` |
| `fetch__user__following__list` | User's following | `user_id` or `sec_user_id`, `count` |
| `fetch__one__video__v2` | Single video | `aweme_id` |
| `fetch__one__video__by__share__url__v2` | Video by share URL | `share_url` |
| `fetch__multi__video__v2` | Batch get videos | `aweme_ids` |
| `fetch__video__comments` | Video comments | `aweme_id`, `count`, `cursor` |
| `fetch__video__comment__replies` | Comment replies | `item_id`, `comment_id`, `count`, `cursor` |
| `fetch__general__search__result` | General search | `keyword`, `count`, `offset` |
| `fetch__video__search__result` | Video search | `keyword`, `count`, `offset` |
| `fetch__user__search__result` | User search | `keyword`, `count`, `offset` |
| `fetch__music__search__result` | Music search | `keyword`, `count`, `offset` |
| `fetch__hashtag__search__result` | Hashtag search | `keyword`, `count`, `offset` |
| `fetch__hashtag__detail` | Hashtag details | `ch_id` |
| `fetch__hashtag__video__list` | Hashtag videos | `ch_id`, `count`, `cursor` |
| `fetch__music__detail` | Music details | `music_id` |
| `fetch__music__video__list` | Music videos | `music_id`, `count`, `cursor` |
| `fetch__live__room__info` | Live room info | `room_id` |
| `check__live__room__online` | Check live online | `room_id` |
| `fetch__home__feed` | Home feed | — |

## Error Handling

- **Missing sec_user_id** → Use `handler_user_profile` or `get_user_id_and_sec_user_id_by_username` to get it first
- **Empty results** → Check that `aweme_id`, `ch_id`, or `music_id` is valid
- **Pagination exhausted** → When `has_more` is `0` or `false`, no more pages available
