# Reddit Guide

Complete guide for Reddit operations via xAPI — user profiles, posts, comments, subreddit feeds, popular/news/games feeds, trending, and search suggestions.

All Reddit endpoints are API-type actions under the `reddit` service. Every call requires `"method": "GET"` in the input and parameters go inside `"params"`.

**Tip:** Most endpoints accept `need_format` (boolean). Set it to `true` for cleaner, pre-processed responses; omit or set `false` for raw Reddit data.

## User Data

### Get user profile

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__user__profile \
  --input '{"method":"GET","params":{"username":"spez","need_format":true}}'
```

Returns `data.data.redditorInfoByName` with fields: `id` (e.g. `t2_1w72`), `name`, `prefixedName`, `isEmployee`, `isVerified`, `accountType`, `karma` (total, fromPosts, fromComments), `profile` (createdAt, subscribersCount, publicDescriptionText, styles).

### Get user's posts

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__user__posts \
  --input '{"method":"GET","params":{"username":"spez","sort":"TOP","need_format":true}}'
```

Optional parameters:
- `sort` — `NEW`, `TOP`, `HOT`, `CONTROVERSIAL`
- `after` — pagination cursor from previous response

### Get user's comments

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__user__comments \
  --input '{"method":"GET","params":{"username":"spez","sort":"TOP","need_format":true}}'
```

Optional parameters:
- `sort` — `NEW`, `TOP`, `HOT`, `CONTROVERSIAL`
- `after` — pagination cursor
- `page_size` — items per page (default: 25)

### Get user's active subreddits

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__user__active__subreddits \
  --input '{"method":"GET","params":{"username":"spez","need_format":true}}'
```

### Get user's trophies

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__user__trophies \
  --input '{"method":"GET","params":{"username":"spez","need_format":true}}'
```

## Post Data

### Get single post details

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__post__details \
  --input '{"method":"GET","params":{"post_id":"t3_1ojnh50","need_format":true}}'
```

The `post_id` must include the `t3_` prefix. To jump to a specific comment within the post, set `include_comment_id` to `true` and pass the `comment_id`.

### Batch get post details

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__post__details__batch \
  --input '{"method":"GET","params":{"post_ids":"t3_1ojnh50,t3_1abc123","need_format":true}}'
```

Comma-separated, up to 5 post IDs per request.

### Get post comments

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__post__comments \
  --input '{"method":"GET","params":{"post_id":"t3_1ojnh50","sort_type":"TOP","need_format":true}}'
```

Optional parameters:
- `sort_type` — `CONFIDENCE`, `NEW`, `TOP`, `HOT`, `CONTROVERSIAL`, `OLD`, `RANDOM`
- `after` — pagination cursor

### Get comment replies

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__comment__replies \
  --input '{"method":"GET","params":{"post_id":"t3_1qmup73","cursor":"commenttree:ex:(RjiJd)","need_format":true}}'
```

Both `post_id` and `cursor` are required. The `cursor` value comes from the `more.cursor` field in comment responses.

Optional: `sort_type` — same options as post comments.

## Subreddit Data

### Get subreddit info

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__subreddit__info \
  --input '{"method":"GET","params":{"subreddit_name":"bitcoin","need_format":true}}'
```

Returns `data.data.subredditInfoByName` with: `id`, `name`, `prefixedName`, `title`, `description`, `publicDescriptionText`, `subscribersCount`, `styles`.

### Get subreddit feed

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__subreddit__feed \
  --input '{"method":"GET","params":{"subreddit_name":"programming","sort":"HOT","need_format":true}}'
```

Optional parameters:
- `sort` — `BEST`, `HOT`, `NEW`, `TOP`, `CONTROVERSIAL`, `RISING`
- `after` — pagination cursor
- `filter_posts` — array of post IDs to exclude

### Get subreddit style

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__subreddit__style \
  --input '{"method":"GET","params":{"subreddit_name":"bitcoin","need_format":true}}'
```

Returns the subreddit's visual theme info (banner, icon, colors).

### Get subreddit post channels

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__subreddit__post__channels \
  --input '{"method":"GET","params":{"subreddit_name":"bitcoin","sort":"HOT","need_format":true}}'
```

Optional parameters:
- `sort` — `HOT`, `NEW`, `TOP`, `CONTROVERSIAL`, `RISING`
- `range` — `HOUR`, `DAY`, `WEEK`, `MONTH`, `YEAR`, `ALL`

### Check if subreddit is muted

```bash
npx xapi-to call reddit.api_v1_reddit_app_check__subreddit__muted \
  --input '{"method":"GET","params":{"subreddit_id":"t5_2s3qj","need_format":true}}'
```

Requires the subreddit ID with `t5_` prefix (get it from subreddit info).

### Get community highlights

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__community__highlights \
  --input '{"method":"GET","params":{"subreddit_id":"t5_2s3qj","need_format":true}}'
```

Requires `subreddit_id` with `t5_` prefix.

## Feeds

### Get popular feed

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__popular__feed \
  --input '{"method":"GET","params":{"sort":"HOT","need_format":true}}'
```

Returns `data.data.posts[]` with post objects and `after` for pagination.

Each post includes: `id`, `postTitle`, `url`, `score`, `commentCount`, `subreddit`, `authorInfo`, `permalink`, `postHint`, `upvoteRatio`, `createdAt`, `isNsfw`, `isSpoiler`, `media`, `thumbnail`.

Optional parameters:
- `sort` — `BEST`, `HOT`, `NEW`, `TOP`, `CONTROVERSIAL`, `RISING`
- `time` — `ALL`, `HOUR`, `DAY`, `WEEK`, `MONTH`, `YEAR`
- `after` — pagination cursor
- `filter_posts` — array of post IDs to exclude

### Get news feed

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__news__feed \
  --input '{"method":"GET","params":{"need_format":true}}'
```

Optional parameters:
- `after` — pagination cursor
- `subtopic_ids` — array of subtopic IDs to filter

### Get games feed

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__games__feed \
  --input '{"method":"GET","params":{"sort":"HOT","need_format":true}}'
```

Optional: `sort`, `time`, `after`.

## Search & Trending

### Get trending searches

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__trending__searches \
  --input '{"method":"GET","params":{"need_format":true}}'
```

Returns current trending search queries on Reddit.

### Search typeahead (suggestions)

```bash
npx xapi-to call reddit.api_v1_reddit_app_fetch__search__typeahead \
  --input '{"method":"GET","params":{"query":"bitcoin","need_format":true}}'
```

Returns search suggestions including query completions and matching subreddits.

Optional parameters:
- `allow_nsfw` — `"0"` or `"1"`
- `safe_search` — `"unset"` or `"strict"`

## Common Workflows

### Research a Reddit user

1. Get profile: `reddit...fetch__user__profile` → karma, account age, description
2. Get posts: `reddit...fetch__user__posts` with `sort=TOP` → most popular posts
3. Get comments: `reddit...fetch__user__comments` → user's comment activity
4. Active subreddits: `reddit...fetch__user__active__subreddits` → community participation

### Monitor a subreddit

1. Get info: `reddit...fetch__subreddit__info` → subscriber count, description
2. Get feed: `reddit...fetch__subreddit__feed` with `sort=HOT` → trending posts
3. Read post: `reddit...fetch__post__details` → full post content
4. Read comments: `reddit...fetch__post__comments` with `sort_type=TOP` → top comments

### Track what's trending

1. Trending: `reddit...fetch__trending__searches` → current trending topics
2. Popular feed: `reddit...fetch__popular__feed` with `sort=HOT` → top posts across Reddit
3. News feed: `reddit...fetch__news__feed` → latest news posts

### Deep-dive a post thread

1. Get post: `reddit...fetch__post__details` with `post_id` → post content
2. Get comments: `reddit...fetch__post__comments` with `sort_type=TOP` → top-level comments
3. Get replies: `reddit...fetch__comment__replies` with `cursor` → expand comment threads

## Pagination

All paginated endpoints use the `after` cursor pattern (except comment replies which use `cursor`):

1. Make the initial request without `after`
2. Extract `after` from the response (e.g. `data.data.after` or from `pageInfo.endCursor`)
3. Pass `after` in the next request to get the next page
4. When `after` is `null` or response has no more data, pagination is exhausted

## Reddit ID Prefixes

| Prefix | Type | Example |
|--------|------|---------|
| `t1_` | Comment | `t1_abc123` |
| `t2_` | User | `t2_1w72` |
| `t3_` | Post/Link | `t3_1ojnh50` |
| `t5_` | Subreddit | `t5_2s3qj` |

## API Reference

| API (prefix: `reddit.api_v1_reddit_app_`) | Description | Key Params |
|---|---|---|
| `fetch__user__profile` | User profile | `username`* |
| `fetch__user__posts` | User's posts | `username`*, `sort`, `after` |
| `fetch__user__comments` | User's comments | `username`*, `sort`, `after`, `page_size` |
| `fetch__user__active__subreddits` | User's active subreddits | `username`* |
| `fetch__user__trophies` | User's trophies | `username`* |
| `fetch__post__details` | Single post details | `post_id`* |
| `fetch__post__details__batch` | Batch post details (up to 5) | `post_ids`* |
| `fetch__post__comments` | Post comments | `post_id`*, `sort_type`, `after` |
| `fetch__comment__replies` | Comment replies | `post_id`*, `cursor`*, `sort_type` |
| `fetch__subreddit__info` | Subreddit info | `subreddit_name` |
| `fetch__subreddit__feed` | Subreddit feed | `subreddit_name`*, `sort`, `after` |
| `fetch__subreddit__style` | Subreddit style/theme | `subreddit_name` |
| `fetch__subreddit__post__channels` | Subreddit post channels | `subreddit_name`, `sort`, `range` |
| `check__subreddit__muted` | Check subreddit muted | `subreddit_id`* |
| `fetch__community__highlights` | Community highlights | `subreddit_id`* |
| `fetch__popular__feed` | Popular feed | `sort`, `time`, `after` |
| `fetch__news__feed` | News feed | `after`, `subtopic_ids` |
| `fetch__games__feed` | Games feed | `sort`, `time`, `after` |
| `fetch__trending__searches` | Trending searches | — |
| `fetch__search__typeahead` | Search suggestions | `query`* |

## Error Handling

- **Missing t3_ prefix** → Post IDs must include the `t3_` prefix (e.g. `t3_1ojnh50`, not just `1ojnh50`)
- **Empty results** → Verify the username or subreddit_name exists
- **Pagination exhausted** → `after` is `null` or missing in the response
- **Comment replies require cursor** → Get the `cursor` value from the `more` field in comment responses
