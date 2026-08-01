# Twitter / X Guide

Complete guide for Twitter operations via xAPI — reading data, posting tweets, replying, and OAuth setup.

> **Upstream provider:** All `twitter.*` capabilities accept an optional `provider` — `"x"` (fapi.uk, the default) or `"twitter"` (legacy upstream). The response is normalized to an identical structure regardless of provider, so you normally omit it. Pass `"provider":"twitter"` only to force the legacy upstream, e.g. `--input '{"screen_name":"elonmusk","provider":"twitter"}'`.

## Reading Twitter Data (no OAuth needed)

### Look up a user by @handle

```bash
npx xapi-to call twitter.user_by_screen_name --input '{"screen_name":"elonmusk"}'
```

Returns `rest_id` (numeric user ID), `name`, `screen_name`, `followers_count`, `statuses_count`, etc.

**Important:** Most Twitter actions require the numeric `user_id` (called `rest_id` in the response), not the @handle. Always look up the user first to get the ID.

### Get a user's recent tweets

```bash
npx xapi-to call twitter.user_tweets --input '{"user_id":"44196397","count":10}'
```

Each tweet includes: `id`, `full_text`, `created_at`, `favorite_count`, `retweet_count`, `reply_count`, `views_count`, `media`, `author`, and `quoted_tweet` if applicable.

### Get a user's tweets and replies

```bash
npx xapi-to call twitter.user_tweets_and_replies --input '{"user_id":"44196397","count":10}'
```

Similar to `twitter.user_tweets`, but the timeline also includes the user's replies to other tweets and conversation threads they participate in. Each item includes the same fields: `id`, `full_text`, `created_at`, `favorite_count`, `retweet_count`, `reply_count`, `views_count`, `media`, `author`, and `quoted_tweet` if applicable.

**When to choose which:**

- `twitter.user_tweets` — only the user's own posts. Use for content/timeline of original tweets.
- `twitter.user_tweets_and_replies` — posts plus replies and conversation participants. Use to monitor a user's reply activity or full timeline.

**Filter tip:** because conversation entries can contain tweets from other authors, filter by `author.id === user_id` if you only want the monitored user's content.

### Get a specific tweet and its replies

```bash
npx xapi-to call twitter.tweet_detail --input '{"tweet_id":"2035526376468394305"}'
```

### Read an X Article (long-form post)

Some tweets are long-form **X Articles**. For these, `twitter.tweet_detail` returns only a `t.co` link as `full_text` (the link resolves to `x.com/i/article/<article_id>`), plus an `article` object with just `title` and `preview_text` — **not** the full body.

To get the full article text, call the raw GraphQL `twitter.graphql_TweetDetail` with an extra `fieldToggles` query parameter:

```bash
npx xapi-to call twitter.graphql_TweetDetail --input '{
  "method": "GET",
  "params": {
    "variables": "{\"focalTweetId\":\"<tweet_id>\",\"with_rux_injections\":false,\"includePromotedContent\":false,\"withCommunity\":true,\"withQuickPromoteEligibilityTweetFields\":true,\"withBirdwatchNotes\":true,\"withVoice\":true,\"withV2Timeline\":true}",
    "fieldToggles": "{\"withArticleRichContentState\":true,\"withArticlePlainText\":true}"
  }
}'
```

The full text is in the response at `...tweet_results.result.article.article_results.result.content_state.plain_text` (with `withArticleRichContentState` you also get structured `blocks` for headings/formatting). Use the **tweet_id** from the share URL (`x.com/<user>/status/<tweet_id>` or `x.com/<user>/article/<tweet_id>`) as `focalTweetId`, not the internal article id.

Tips:

- The response is large (~150 KB). Pipe it to a file and extract `plain_text` programmatically rather than dumping it to the terminal.
- Without the `fieldToggles` parameter, the same call returns only `title`/`preview_text` — this parameter is required for the article body.

### Search tweets

```bash
npx xapi-to call twitter.search --input '{"raw_query":"AI agents","count":20}'
```

### Get user's media posts

```bash
npx xapi-to call twitter.user_media --input '{"user_id":"44196397"}'
```

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

Posting, replying, quoting, liking, and retweeting all require OAuth. This is a **one-time setup** — the user authorizes once, then the agent can post freely.

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

## API Reference

| API | Method | Description |
|-----------|--------|-------------|
| `twitter.user_by_screen_name` | — | Look up user by @handle |
| `twitter.user_tweets` | — | Get user's recent tweets |
| `twitter.user_tweets_and_replies` | — | Get user's tweets and replies |
| `twitter.user_media` | — | Get user's media posts |
| `twitter.tweet_detail` | — | Get tweet + replies |
| `twitter.search` | — | Search tweets |
| `twitter.followers` | — | Get user's followers |
| `twitter.following` | — | Get user's following |
| `twitter.retweeters` | — | Get tweet retweeters |
| `x-official.2_tweets` | POST | Post a tweet |
| `x-official.2_tweets` | DELETE | Delete a tweet |
| `x-official.2_users_id_likes` | POST | Like a tweet |
| `x-official.2_users_id_retweets` | POST | Retweet |

## Error Handling

- **OAuth Required** → Run `npx xapi-to oauth bind --provider twitter`
- **403 Forbidden** → Twitter account may have restrictions; check account status
- **Tweet too long** → Shorten to 280 chars (140 CJK)
- **User not found** → Check the screen_name spelling
