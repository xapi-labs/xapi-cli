# Twitter / X Guide

Complete guide for Twitter operations via xAPI — reading data, downloading tweet videos, posting tweets, replying, and OAuth setup.

> **Upstream provider:** All `twitter.*` capabilities accept an optional `provider` — `"x"` (fapi.uk, the default) or `"twitter"` (legacy upstream). The response is normalized to an identical structure regardless of provider, so you normally omit it. Pass `"provider":"twitter"` only to force the legacy upstream, e.g. `--input '{"screen_name":"elonmusk","provider":"twitter"}'`.

## Contents

- [Read Twitter data](#reading-twitter-data-no-oauth-needed)
- [Download a tweet video](#download-a-tweet-video)
- [Post and mutate with OAuth](#posting-tweets-oauth-required)
- [Common workflows](#common-workflows)
- [Pagination reference](#pagination-reference)
- [API reference](#api-reference)
- [Error handling](#error-handling)

## Reading Twitter Data (no OAuth needed)

### Look up a user by @handle

```bash
npx xapi-to call twitter.user_by_screen_name --input '{"screen_name":"elonmusk"}'
```

Returns `rest_id` (numeric user ID), `name`, `screen_name`, `followers_count`, `statuses_count`, etc.

**Important:** Most Twitter actions require the numeric `user_id` (called `rest_id` in the response), not the @handle. Always look up the user first to get the ID.

### Get a user's recent tweets

```bash
npx xapi-to call twitter.user_tweets --input '{"user_id":"44196397"}'
```

Each tweet includes: `id`, `full_text`, `created_at`, `favorite_count`, `retweet_count`, `reply_count`, `views_count`, `media`, `author`, and `quoted_tweet` if applicable.

Paginate with the previous response's `data.cursors.bottom`:

```bash
npx xapi-to call twitter.user_tweets \
  --input '{"user_id":"44196397","cursor":"<cursors.bottom>"}'
```

### Get a user's tweets and replies

```bash
npx xapi-to call twitter.user_tweets_and_replies --input '{"user_id":"44196397"}'
```

Similar to `twitter.user_tweets`, but the timeline also includes the user's replies to other tweets and conversation threads they participate in. Each item includes the same fields: `id`, `full_text`, `created_at`, `favorite_count`, `retweet_count`, `reply_count`, `views_count`, `media`, `author`, and `quoted_tweet` if applicable.

**When to choose which:**

- `twitter.user_tweets` — only the user's own posts. Use for content/timeline of original tweets.
- `twitter.user_tweets_and_replies` — posts plus replies and conversation participants. Use to monitor a user's reply activity or full timeline.

**Filter tip:** because conversation entries can contain tweets from other authors, filter by `author.id === user_id` if you only want the monitored user's content.

Pagination uses the same `cursor` → `data.cursors.bottom` pattern as `twitter.user_tweets`.

For `twitter.user_tweets` and `twitter.user_tweets_and_replies`, set `"cache":true` to use the fast cache when available and skip the normal upstream call. Cached results can be less fresh; keep the default `false` when freshness matters.

### Get a specific tweet and its replies

```bash
npx xapi-to call twitter.tweet_detail --input '{"tweet_id":"2035526376468394305"}'
```

To load more replies, pass the previous response's `data.cursors.bottom` as `cursor`:

```bash
npx xapi-to call twitter.tweet_detail \
  --input '{"tweet_id":"2035526376468394305","cursor":"<cursors.bottom>"}'
```

Paginated pages commonly contain more `replies` but no main tweet, so `data.tweet` may be `null` when `cursor` is present.

### Download a tweet video

Use the bundled downloader with either a complete status URL or its numeric tweet ID. Resolve `<xapi-skill-directory>` to the directory containing this guide's parent `SKILL.md`:

```bash
bash <xapi-skill-directory>/scripts/download_tweet_videos.sh \
  'https://x.com/NousResearch/status/2084325600643445095'
```

Pass an optional existing output directory as the second argument; otherwise files are written to the current directory. A single video is named `tweet-<tweet-id>.mp4`; multiple videos are numbered `tweet-<tweet-id>-1.mp4`, `-2.mp4`, and so on. The script includes videos in the main, quoted, and retweeted tweets, deduplicates identical media URLs, and refuses to overwrite any existing output.

The script verifies that the deployed `twitter.tweet_detail` schema exposes `video_url` before making the paid call. It omits `provider` to retain automatic failover from the default `x` upstream to the legacy `twitter` upstream on transient failures. The response's `data.provider` identifies the upstream that served it; explicitly setting `provider` would pin that upstream and disable failover.

Each download is written to a same-directory temporary file, required to have MIME type `video/mp4`, optionally checked with `ffprobe`, and only renamed to its final path after every media file passes. Failures clean up temporary files, so a partial transfer is never published as the final MP4.

`data.tweet.media[].url` and `preview_url` are preview images; do not download them as MP4. The optional `video_info.variants` retains the original MP4 and HLS variants when a specific rendition is needed. `call --output` is not appropriate because the xAPI action returns JSON metadata rather than video bytes; the bundled script downloads each resolved `video_url` with `curl`.

### Read an X Article (long-form post)

Some tweets are long-form **X Articles**. `twitter.tweet_detail` detects them and returns the full normalized article directly in `data.tweet.article`; no raw GraphQL call or `fieldToggles` parameter is needed.

```bash
npx xapi-to call twitter.tweet_detail --input '{"tweet_id":"<tweet_id>"}'
```

The normalized `article` object contains:

- `id`, `title`, and `preview_text`
- `text` — full plain text
- `markdown` — full text with headings, lists, quotes, code blocks, and inline links preserved
- `cover_image` — URL and optional dimensions
- `links` — deduplicated external links in appearance order
- `first_published_at` and `modified_at` — ISO 8601 timestamps when available

Use the **tweet ID** from the share URL (`x.com/<user>/status/<tweet_id>` or `x.com/<user>/article/<tweet_id>`), not an internal article ID.

### Search tweets

```bash
npx xapi-to call twitter.search --input '{"raw_query":"AI agents","count":20}'
```

For `provider: "x"` (the default), structured advanced-search filters are also available:

```bash
npx xapi-to call twitter.search --input '{
  "raw_query":"AI",
  "from":"OpenAI",
  "mentioning":"AnthropicAI",
  "phrase":"AI agents",
  "since":"2026-08-01",
  "until":"2026-08-05",
  "min_likes":100,
  "min_replies":10,
  "min_retweets":20,
  "count":20
}'
```

Supported structured filters: `from`, `to`, `mentioning`, `phrase`, `any`, `none`, `tag`, `since`, `until`, `min_replies`, `min_likes`, `min_retweets`, and `count`. `sort_by` accepts `Top`, `Latest` (default), `People`, `Photos`, or `Videos`; the default `x` provider maps both media-specific values to its combined Media search. Dates use `YYYY-MM-DD`; `until` is exclusive. Paginate with `cursor` from `data.cursor_bottom`.

### Get user's media posts

```bash
npx xapi-to call twitter.user_media --input '{"user_id":"44196397"}'
```

Paginate with `cursor` from the previous response's `data.cursor_bottom`. Both the default `x` provider and legacy `twitter` provider are supported.

### Get followers / following

```bash
npx xapi-to call twitter.followers --input '{"user_id":"44196397"}'
npx xapi-to call twitter.following --input '{"user_id":"44196397"}'
```

### Get retweeters

```bash
npx xapi-to call twitter.retweeters --input '{"tweet_id":"1234567890"}'
```

## Posting Tweets (OAuth required)

Posting, replying, quoting, liking, retweeting, and deleting require OAuth. A saved binding provides technical authorization, not standing user consent: confirm the current content and target before a write, and obtain explicit confirmation before destructive or bulk actions.

### Step 1: Bind Twitter OAuth

```bash
npx xapi-to oauth bind --provider twitter
```

This opens a browser for the user to authorize. After authorization, the binding is saved to the API key.

Verify:

```bash
npx xapi-to oauth status
```

Should show `tweet.write` in scopes.

### Step 2: Post a tweet

```bash
npx xapi-to call x-official.2_tweets --method POST \
  --input '{"body":{"text":"Hello from my AI agent!"}}'
```

**Character limit:** 280 characters (140 CJK characters). Each CJK character counts as 2.

### Reply to a tweet

```bash
npx xapi-to call x-official.2_tweets --method POST \
  --input '{"body":{"text":"Great point!","reply":{"in_reply_to_tweet_id":"2035526376468394305"}}}'
```

### Quote tweet

```bash
npx xapi-to call x-official.2_tweets --method POST \
  --input '{"body":{"text":"Worth reading 👇","quote_tweet_id":"2035526376468394305"}}'
```

### Delete a tweet

```bash
npx xapi-to call x-official.2_tweets_id --method DELETE \
  --input '{"pathParams":{"id":"2036012345678901234"}}'
```

### Like a tweet

```bash
npx xapi-to call x-official.2_users_id_likes --method POST \
  --input '{"pathParams":{"id":"<your_user_id>"},"body":{"tweet_id":"2035526376468394305"}}'
```

### Retweet

```bash
npx xapi-to call x-official.2_users_id_retweets --method POST \
  --input '{"pathParams":{"id":"<your_user_id>"},"body":{"tweet_id":"2035526376468394305"}}'
```

## Common Workflows

### Research and tweet

1. Search the web: `web.search.realtime` → get latest news
2. Summarize: `ai.text.summarize` → create a concise summary
3. Post: `x-official.2_tweets` POST → tweet the summary

### Monitor and reply

1. Get user activity: `twitter.user_tweets` (originals only) or `twitter.user_tweets_and_replies` (includes replies) → check latest posts
2. Get tweet detail: `twitter.tweet_detail` → read the thread
3. Reply: `x-official.2_tweets` POST with `reply` → respond

## Pagination Reference

| Capability | Next cursor field | Next request input |
|---|---|---|
| `twitter.user_tweets` | `data.cursors.bottom` | `cursor` |
| `twitter.user_tweets_and_replies` | `data.cursors.bottom` | `cursor` |
| `twitter.tweet_detail` replies | `data.cursors.bottom` | `cursor` |
| `twitter.user_media` | `data.cursor_bottom` | `cursor` |
| `twitter.search` | `data.cursor_bottom` | `cursor` |
| `twitter.followers` | `data.cursor_bottom` | `cursor` |
| `twitter.following` | `data.cursor_bottom` | `cursor` |
| `twitter.retweeters` | `data.cursor_bottom` | `cursor` |

Omit `cursor` for the first page. Stop when the relevant bottom cursor is absent or empty.

## API Reference

| API | Method | Description |
|-----------|--------|-------------|
| `twitter.user_by_screen_name` | — | Look up user by @handle |
| `twitter.user_tweets` | — | Get and paginate user's recent tweets |
| `twitter.user_tweets_and_replies` | — | Get and paginate user's tweets and replies |
| `twitter.user_media` | — | Get and paginate user's media posts |
| `twitter.tweet_detail` | — | Get tweet, full X Article content, and paginated replies |
| `twitter.search` | — | Search tweets with cursor and advanced filters |
| `twitter.followers` | — | Get user's followers |
| `twitter.following` | — | Get user's following |
| `twitter.retweeters` | — | Get tweet retweeters |
| `x-official.2_tweets` | POST | Post a tweet |
| `x-official.2_tweets_id` | DELETE | Delete a tweet |
| `x-official.2_users_id_likes` | POST | Like a tweet |
| `x-official.2_users_id_retweets` | POST | Retweet |

## Error Handling

- **OAuth Required** → Run `npx xapi-to oauth bind --provider twitter`
- **403 Forbidden** → Twitter account may have restrictions; check account status
- **Tweet too long** → Shorten to 280 chars (140 CJK)
- **User not found** → Check the screen_name spelling
