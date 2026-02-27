# xapi-cli

Agent-friendly command-line interface for [xapi](https://xapi.to) — discover and call capabilities and APIs from your terminal or AI agent.

## Installation

```bash
# Requires Bun
bun install
```

## Quick Start

```bash
# Set your API key
bun run src/index.ts config set apiKey=sk-xxx

# Or via env var
export XAPI_API_KEY=sk-xxx
```

## Usage

```
xapi <group> <command> [args] [flags]
```

### Capabilities (`cap`)

Code-defined capabilities like Twitter, crypto, AI, web search.

```bash
xapi cap list                                        # list all capabilities
xapi cap search "twitter"                            # search by keyword
xapi cap get twitter.tweet_detail                    # get schema
xapi cap call twitter.tweet_detail tweet_id=1234     # execute
xapi cap call twitter.user_by_screen_name screen_name=elonmusk
```

### APIs (`api`)

Database-defined third-party API proxies.

```bash
xapi api list                                        # paginated list
xapi api list --page 2 --page-size 20
xapi api list --category DeFi
xapi api categories                                  # list all categories
xapi api search "token price" --limit 5
xapi api get <uuid>
xapi api call <uuid> --input '{"query":"BTC"}'
```

### Account

```bash
xapi register                                        # create account, saves apiKey automatically
xapi balance                                         # show xToken balance
xapi topup                                           # generate payment URL
xapi topup --method stripe --amount 10               # stripe, $10
xapi topup --method x402                             # x402 (USDC on Base)
```

### Config

```bash
xapi config show                                     # show current config
xapi config set apiKey=sk-xxx                        # save API key
xapi config health                                   # check connectivity
```

## Output Formats

All output is JSON by default — designed for agent consumption.

```bash
xapi cap list --format json      # default, machine-readable
xapi cap list --format pretty    # pretty-printed JSON
xapi cap list --format table     # human-readable table
```

## Environment Variables

| Variable | Description |
|---|---|
| `XAPI_API_KEY` | API key (overrides config file) |
| `XAPI_OUTPUT` | Default output format (`json`\|`pretty`\|`table`) |

Config is stored at `~/.xapi/config.json`.

## Available Capabilities

| ID | Description |
|---|---|
| `twitter.tweet_detail` | Get tweet details and replies |
| `twitter.user_by_screen_name` | Get user profile by username |
| `twitter.user_tweets` | Get tweets from a user |
| `twitter.user_media` | Get media posts from a user |
| `twitter.following` | Get user following list |
| `twitter.followers` | Get user followers |
| `twitter.retweeters` | Get tweet retweeters |
| `twitter.search_timeline` | Search tweets, users, photos, videos |
| `ai.text.chat.fast` | Fast AI chat completion |
| `ai.text.chat.reasoning` | Advanced reasoning chat |
| `ai.text.summarize` | Summarize long text |
| `ai.text.rewrite` | Rewrite text with different styles |
| `ai.embedding.generate` | Generate vector embeddings |
| `web.search` | Web search |
| `web.search.realtime` | Realtime web search with time filters |
| `news.search.latest` | Latest news search |
| `crypto.token.price` | Crypto token price and changes |
| `crypto.token.metadata` | Crypto token metadata |

## License

MIT
