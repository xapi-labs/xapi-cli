# xapi-to

Agent-friendly command-line interface for [xAPI](https://xapi.to) — discover and call capabilities and APIs from your terminal or AI agent.

## Installation

```bash
# Via npx (no install needed)
npx xapi-to --help

# Or install globally with npm
npm install -g xapi-to

# Or from source
cd xapi-cli && bun install
```

The published CLI runs on Node.js 18+. Bun is only required for local source development and tests.

## Quick Start

```bash
# 1. Register a new account (apiKey saved automatically)
xapi-to register

# 1b. Or register with an inviter's referral code (please replace xapito to your referral code)
xapi-to register --referral-code xapito

# 2. Or set an existing key
xapi-to config set apiKey=sk-xxx

# 3. Or via env var
export XAPI_KEY=sk-xxx

# 4. Verify connectivity
xapi-to config health
```

## Usage

```
xapi-to <command> [args] [flags]
```

### Action Commands

Unified interface for capabilities (built-in) and APIs (third-party). Use `--source capability|api` to filter.

```bash
xapi-to list                                            # list all actions
xapi-to list --source capability                        # only built-in capabilities
xapi-to list --source api --category DeFi               # filter by source and category
xapi-to list --page 2 --page-size 20                    # pagination
xapi-to list --service-id <id>                          # filter by service

xapi-to search "twitter"                                # search by keyword
xapi-to search "token price" --source api               # search APIs only

xapi-to categories                                      # list all categories
xapi-to categories --source capability                  # categories for capabilities only

xapi-to services                                        # list all services
xapi-to services --category Social --page-size 10       # filter and paginate

xapi-to get twitter.tweet_detail                        # get action schema
xapi-to call twitter.tweet_detail --input '{"tweet_id":"1234567890"}'  # execute
```

### OAuth

Bind third-party OAuth accounts (e.g. Twitter) to your API key.

```bash
xapi-to oauth bind --provider twitter                   # bind Twitter account
xapi-to oauth status                                    # list current bindings
xapi-to oauth unbind <binding-id>                       # remove a binding
xapi-to oauth providers                                 # list available providers
```

### Account

```bash
xapi-to register                                        # create account, saves apiKey automatically
xapi-to register --referral-code xapito                 # register with an inviter's referral code (please replace xapito to your referral code)
xapi-to register xapito                                 # positional shorthand for --referral-code
xapi-to balance                                         # show USD balance
xapi-to topup                                           # generate payment URL
xapi-to topup --method stripe --amount 10               # stripe, $10
xapi-to topup --method x402                             # x402 (USDC on Base)
```

### Config

```bash
xapi-to config show                                     # show current config
xapi-to config set apiKey=sk-xxx                        # save API key
xapi-to config health                                   # check backend connectivity
```

## Workflow: Always GET before CALL

Before calling any action, always read its schema first to understand required parameters:

```bash
# 1. Find the action
xapi-to search "twitter"

# 2. Read its schema
xapi-to get twitter.tweet_detail

# 3. Call with correct parameters
xapi-to call twitter.tweet_detail --input '{"tweet_id":"1234567890"}'
```

## Output Formats

All output is JSON by default — designed for agent consumption.

```bash
xapi-to list --format json                              # default, machine-readable
xapi-to list --format pretty                            # pretty-printed JSON
xapi-to list --format table                             # human-readable table
```

## Environment Variables

| Variable | Description |
|---|---|
| `XAPI_KEY` | API key (overrides config file) |
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
