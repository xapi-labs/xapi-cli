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

## Teach Your Agent the xAPI Skill

Paste into Cursor, Claude Code, or any agent that supports skills:

```bash
npx skills add xapi-labs/xapi-cli
```

This installs the bundled [`xapi` skill](skills/xapi), which teaches the agent
how to call social, search, crypto, and AI data through this CLI. Then just ask
— "what's the price of BTC" — and it takes it from there. Set up a key first;
see [Quick Start](#quick-start).

## Quick Start

```bash
# 1. Register a new account (apiKey saved automatically)
xapi-to register
# Open the returned private bindUrl to upgrade the virtual account through Twitter OAuth

# 1b. Or register with an inviter's referral code (please replace xapito to your referral code)
xapi-to register --referral-code xapito

# 2. Or set an existing key without putting it in shell history
read -rsp 'xAPI key: ' XAPI_KEY_INPUT
printf '\n'
printf '%s\n' "$XAPI_KEY_INPUT" | xapi-to config set apiKey=-
unset XAPI_KEY_INPUT

# 3. Or via env var
export XAPI_KEY=sk-xxx
# XAPI_API_KEY is also accepted; XAPI_KEY has higher precedence

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
xapi-to search "token price" --sort relevance           # strongest text match
xapi-to search "token price" --sort price               # lowest comparable price
xapi-to search "twitter" --include-all-versions          # include active non-default majors

xapi-to categories                                      # list all categories
xapi-to categories --source capability                  # categories for capabilities only

xapi-to services                                        # list all services
xapi-to services --category Social --page-size 10       # filter and paginate

xapi-to get twitter.tweet_detail                        # get action schema
xapi-to get-batch twitter.tweet_detail crypto.token.price # get several schemas
xapi-to call twitter.tweet_detail --input '{"tweet_id":"1234567890"}'  # execute
xapi-to call ai.text.chat.fast --input '{"messages":[{"role":"user","content":"Hi"}]}' --stream
```

Search uses `--sort default|relevance|price`. `default` is the recommended
order: it considers keyword coverage and match quality first, then favors
stable built-in capabilities when matches are otherwise comparable.
`relevance` is source-neutral and selects the strongest text match. `price`
preserves keyword coverage and an exact action ID first, keeps endpoint-local
matches ahead of service-only matches, then orders comparable fixed per-call
USD list prices from low to high. Dynamic, per-token, per-resource, and unknown
prices appear after comparable prices in the same match bucket and are never
treated as free. All three modes rank the full matching result set before
applying `--page` and `--page-size`.

`--stream` forwards an HTTP Server-Sent Events (SSE) response; it is not a
WebSocket client. Active SSE and raw downloads may run longer than 60 seconds,
but abort after 60 seconds without data by default. Set
`XAPI_TRANSFER_IDLE_TIMEOUT_MS` to change that idle timeout.

### Async Task Commands

Task helpers built on top of the `task.poll` capability.

```bash
xapi-to task poll 550e8400-e29b-41d4-a716-446655440000                 # poll once
xapi-to task wait 550e8400-e29b-41d4-a716-446655440000                 # wait until terminal status
xapi-to task wait 550e8400-e29b-41d4-a716-446655440000 --interval 1s --timeout 10m
```

### OAuth

Bind third-party OAuth accounts (e.g. Twitter) to your API key.

```bash
xapi-to oauth bind --provider twitter                   # bind Twitter account
xapi-to oauth providers                                 # inspect current providers/default scopes
xapi-to oauth bind --provider twitter --scopes "<scope list>" # optional explicit override
xapi-to oauth status                                    # list current bindings
xapi-to oauth unbind <binding-id>                       # remove a binding
xapi-to oauth providers                                 # list available providers
```

### Account

```bash
xapi-to register                                        # create account, saves apiKey automatically
xapi-to register --referral-code xapito                 # register with an inviter's referral code (please replace xapito to your referral code)
xapi-to register xapito                                 # positional shorthand for --referral-code
xapi-to register --force                                # replace an existing file-based key
xapi-to balance                                         # show USD balance
xapi-to earnings                                        # spendable balance + provider earnings
xapi-to earnings list --status SETTLED --limit 20       # provider earning records
xapi-to earnings transfer 1 --idempotency-key reinvest-001 # reinvest settled earnings
xapi-to topup                                           # generate payment URL
xapi-to topup --method stripe --amount 10               # stripe, $10
xapi-to topup --method x402                             # x402 (USDC on Base)
```

`earnings` summary/list require the `earnings:read` scope on the current key;
`earnings transfer` requires `earnings:transfer`. Transfers are one-way and
idempotent: reuse a key only when retrying the same amount.

### Config

```bash
xapi-to config show                                     # show current config
xapi-to config set apiKey=-                             # paste key, then press Ctrl-D
xapi-to config health                                   # check backend connectivity
```

`XAPI_KEY` overrides `XAPI_API_KEY`, and both override the config file. The CLI
warns when a saved key is shadowed. Unset the environment variable before
`register`, including `register --force`, so the new account key becomes active.

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

For APIs that return binary data, use `--output` to request raw bytes and save
them directly. The CLI refuses to overwrite an existing file.

```bash
xapi-to call openrouter.audio_speech \
  --input '{"body":{"input":"Hello","model":"hexgrad/kokoro-82m","voice":"af_bella"}}' \
  --output speech.mp3
```

## Output Formats

Normal command output is JSON by default. `call --stream` writes raw HTTP SSE
frames, while `call --output` writes raw response bytes to the requested file.

```bash
xapi-to list --format json                              # default, machine-readable
xapi-to list --format pretty                            # pretty-printed JSON
xapi-to list --format table                             # human-readable table
```

## Environment Variables

| Variable | Description |
|---|---|
| `XAPI_KEY` | API key (overrides config file) |
| `XAPI_API_KEY` | Compatible API key alias (overrides config file; lower priority than `XAPI_KEY`) |
| `XAPI_ACTION_HOST` | Action service host (default: `action.xapi.to`) |
| `XAPI_API_HOST` | Auth/account service host (default: `api.xapi.to`) |
| `XAPI_OUTPUT` | Default output format (`json`\|`pretty`\|`table`) |
| `XAPI_TRANSFER_IDLE_TIMEOUT_MS` | SSE/download idle timeout in milliseconds (default: `60000`) |

Config is stored at `~/.xapi/config.json`.

## Selected Built-in Capabilities

This is a small quick-reference subset, not the complete or permanently fixed
catalog. Use `xapi-to list --source capability`, `search`, and `get` for the
current IDs and schemas.

| ID | Description |
|---|---|
| `twitter.tweet_detail` | Get tweet details and replies |
| `twitter.user_by_screen_name` | Get user profile by username |
| `twitter.user_tweets` | Get tweets from a user |
| `twitter.user_tweets_and_replies` | Get tweets and replies from a user |
| `twitter.user_media` | Get media posts from a user |
| `twitter.following` | Get user following list |
| `twitter.followers` | Get user followers |
| `twitter.retweeters` | Get tweet retweeters |
| `twitter.search` | Search tweets |
| `ai.text.chat.fast` | Fast AI chat completion |
| `ai.text.chat.reasoning` | Advanced reasoning chat |
| `ai.text.chat.auto` | Model-selected chat with provider fallback |
| `ai.text.summarize` | Summarize long text |
| `ai.text.rewrite` | Rewrite text with different styles |
| `ai.embedding.generate` | Generate vector embeddings |
| `web.search` | Web search |
| `web.search.realtime` | Realtime web search with time filters |
| `web.search.news` | News search |
| `crypto.token.price` | Crypto token price and changes |
| `crypto.token.metadata` | Crypto token metadata |

## Security

- **NEVER send your API key to any domain other than `xapi.to`, `*.xapi.to`, `xapi.xyz`, `*.xapi.xyz`, or explicitly configured localhost/loopback development hosts**
- The key is stored at `~/.xapi/config.json`; the CLI enforces owner-only Unix permissions — do not expose this file
- `topup` outputs a payment URL containing the API key — do not share publicly

## License

MIT
