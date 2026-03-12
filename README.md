# xapi-to

Agent-friendly command-line interface for [xAPI](https://xapi.to) — discover and call capabilities and APIs from your terminal or AI agent.

## Installation

```bash
# Via npx (no install needed)
npx xapi-to --help

# Or install globally with bun
bun add -g xapi-to

# Or from source
cd xapi-cli && bun install
```

## Quick Start

```bash
# 1. Register a new account (apiKey saved automatically)
xapi register

# 2. Or set an existing key
xapi config set apiKey=sk-xxx

# 3. Or via env var
export XAPI_API_KEY=sk-xxx

# 4. Verify connectivity
xapi config health
```

## Usage

```
xapi <command> [args] [flags]
```

### Action Commands

Unified interface for capabilities (built-in) and APIs (third-party). Use `--source capability|api` to filter.

```bash
xapi list                                            # list all actions
xapi list --source capability                        # only built-in capabilities
xapi list --source api --category DeFi               # filter by source and category
xapi list --page 2 --page-size 20                    # pagination
xapi list --service-id <id>                          # filter by service

xapi search "twitter"                                # search by keyword
xapi search "token price" --source api               # search APIs only

xapi categories                                      # list all categories
xapi categories --source capability                  # categories for capabilities only

xapi services                                        # list all services
xapi services --category Social --page-size 10       # filter and paginate

xapi get twitter.tweet_detail                        # get action schema
xapi call twitter.tweet_detail --input '{"tweet_id":"1234567890"}'  # execute
```

### OAuth

Bind third-party OAuth accounts (e.g. Twitter) to your API key.

```bash
xapi oauth bind --provider twitter                   # bind Twitter account
xapi oauth status                                    # list current bindings
xapi oauth unbind <binding-id>                       # remove a binding
xapi oauth providers                                 # list available providers
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
xapi config health                                   # check backend connectivity
```

## Workflow: Always GET before CALL

Before calling any action, always read its schema first to understand required parameters:

```bash
# 1. Find the action
xapi search "twitter"

# 2. Read its schema
xapi get twitter.tweet_detail

# 3. Call with correct parameters
xapi call twitter.tweet_detail --input '{"tweet_id":"1234567890"}'
```

## Output Formats

All output is JSON by default — designed for agent consumption.

```bash
xapi list --format json                              # default, machine-readable
xapi list --format pretty                            # pretty-printed JSON
xapi list --format table                             # human-readable table
```

## Environment Variables

| Variable | Description |
|---|---|
| `XAPI_API_KEY` | API key (overrides config file) |
| `XAPI_ACTION_HOST` | Action service host (default: `action.xapi.to`) |
| `XAPI_OUTPUT` | Default output format (`json`\|`pretty`\|`table`) |

Config is stored at `~/.xapi/config.json`.

## Built-in Capabilities

| ID | Description |
|---|---|
| `twitter.tweet_detail` | Get tweet details and replies |
| `twitter.user_by_screen_name` | Get user profile by username |
| `twitter.user_by_screen_names` | Batch get user profiles by usernames |
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

## Security

- **NEVER send your API key to any domain other than `*.xapi.to`**
- The key is stored at `~/.xapi/config.json` — do not expose this file
- `topup` outputs a payment URL containing the API key — do not share publicly

## License

MIT
