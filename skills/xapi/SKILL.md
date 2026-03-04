---
name: xapi
description: Use xapi CLI to access real-time external data — Twitter/X profiles, tweets, and timelines, crypto token prices and metadata, web search, news, and AI text processing (summarize, rewrite, chat, embeddings). Trigger this skill whenever the user wants to look up a Twitter user, get tweet details, check crypto prices, search the web or news, generate embeddings, summarize or rewrite text, or call any third-party API through xapi. Also use this skill when the user mentions xapi, asks about available capabilities or APIs, or wants to discover what external services are accessible.
---

# xapi CLI Skill

Use the `xapi` CLI to access real-time external data and services. xapi is an agent-friendly CLI — all output is JSON by default, making it easy to parse and chain.

## Installation

xapi is available via npx (no install needed):

```bash
npx @xapi-to/xapi <command>
```

## Setup

Before calling any capability, you need an API key:

```bash
# Register a new account (apiKey is saved automatically)
npx @xapi-to/xapi register

# Or set an existing key
npx @xapi-to/xapi config set apiKey=<your-key>

# Verify connectivity
npx @xapi-to/xapi config health
```

The API key is stored at `~/.xapi/config.json`. You can also set it via `XAPI_API_KEY` env var.

## Two types of services

xapi offers two types of services:

1. **Capabilities (`cap`)** — Built-in, code-defined capabilities with known IDs (Twitter, crypto, AI, web search, news)
2. **APIs (`api`)** — Third-party API proxies registered in the database, identified by UUID. Discover them with `api list`, `api search`, or `api categories`.

## Capabilities — Quick Reference

Always use `--input` with JSON for passing parameters to `cap call` and `api call`.

### Twitter / X

```bash
# Get user profile
npx @xapi-to/xapi cap call twitter.user_by_screen_name --input '{"screen_name":"elonmusk"}'

# Get user's tweets
npx @xapi-to/xapi cap call twitter.user_tweets --input '{"user_id":"44196397","count":10}'

# Get tweet details and replies
npx @xapi-to/xapi cap call twitter.tweet_detail --input '{"tweet_id":"1234567890"}'

# Get user's media posts
npx @xapi-to/xapi cap call twitter.user_media --input '{"user_id":"44196397"}'

# Get followers / following
npx @xapi-to/xapi cap call twitter.followers --input '{"user_id":"44196397"}'
npx @xapi-to/xapi cap call twitter.following --input '{"user_id":"44196397"}'

# Search tweets
npx @xapi-to/xapi cap call twitter.search_timeline --input '{"query":"bitcoin","count":20}'

# Get retweeters of a tweet
npx @xapi-to/xapi cap call twitter.retweeters --input '{"tweet_id":"1234567890"}'
```

Note: Twitter user_id is a numeric ID. To get it, first call `twitter.user_by_screen_name` with the username, then extract `user_id` from the response.

### Crypto

```bash
# Get token price and 24h change
npx @xapi-to/xapi cap call crypto.token.price --input '{"symbol":"BTC"}'

# Get token metadata
npx @xapi-to/xapi cap call crypto.token.metadata --input '{"symbol":"ETH"}'
```

### Web & News Search

```bash
# Web search
npx @xapi-to/xapi cap call web.search --input '{"query":"latest AI news"}'

# Realtime web search with time filter
npx @xapi-to/xapi cap call web.search.realtime --input '{"query":"breaking news","time_filter":"day"}'

# Latest news
npx @xapi-to/xapi cap call news.search.latest --input '{"query":"crypto regulation"}'
```

### AI Text Processing

```bash
# Fast chat completion
npx @xapi-to/xapi cap call ai.text.chat.fast --input '{"prompt":"Explain quantum computing in one sentence"}'

# Reasoning chat (more thorough)
npx @xapi-to/xapi cap call ai.text.chat.reasoning --input '{"prompt":"Analyze the pros and cons of microservices"}'

# Summarize text
npx @xapi-to/xapi cap call ai.text.summarize --input '{"text":"<long text here>"}'

# Rewrite text
npx @xapi-to/xapi cap call ai.text.rewrite --input '{"text":"<text>","style":"formal"}'

# Generate embeddings
npx @xapi-to/xapi cap call ai.embedding.generate --input '{"text":"hello world"}'
```

## Discovering APIs

For third-party APIs beyond the built-in capabilities:

```bash
# Browse all API categories
npx @xapi-to/xapi api categories

# List APIs (paginated)
npx @xapi-to/xapi api list --page 1 --page-size 20
npx @xapi-to/xapi api list --category DeFi

# Search APIs
npx @xapi-to/xapi api search "token price" --limit 5

# Get API schema (shows required parameters)
npx @xapi-to/xapi api get <uuid>

# Call an API
npx @xapi-to/xapi api call <uuid> --input '{"query":"BTC"}'
```

## Discovering Capabilities

```bash
# List all capabilities
npx @xapi-to/xapi cap list

# Search capabilities
npx @xapi-to/xapi cap search "twitter"

# Get capability schema (shows required parameters)
npx @xapi-to/xapi cap get twitter.tweet_detail
```

## Workflow Pattern

When fulfilling a user request that needs external data:

1. **Check if a known capability exists** — refer to the quick reference above
2. **If not, search** — `cap search` or `api search` to find a matching service
3. **Get the schema** — `cap get <id>` or `api get <uuid>` to see required parameters
4. **Call it** — `cap call` or `api call` with `--input` JSON
5. **Parse the JSON output** and present relevant information to the user

## Input format

Always use `--input` with a JSON object to pass parameters:

```bash
npx @xapi-to/xapi cap call <capability-id> --input '{"key":"value","count":10}'
npx @xapi-to/xapi api call <uuid> --input '{"key":"value"}'
```

This ensures correct types (strings, numbers, booleans) are preserved.

## Account Management

```bash
# Check balance
npx @xapi-to/xapi balance

# Top up account
npx @xapi-to/xapi topup --method stripe --amount 10
npx @xapi-to/xapi topup --method x402
```

## Tips

- All output is JSON by default. Use `--format pretty` for readable output or `--format table` for tabular display.
- For Twitter, always get `user_id` first via `twitter.user_by_screen_name` before calling other Twitter APIs that require it.
- If you get an authentication error, run `npx @xapi-to/xapi register` to create a new account or check your API key with `npx @xapi-to/xapi config show`.
