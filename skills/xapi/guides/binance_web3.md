# Binance Web3 API Guide

The official `Binance Web3 API` service uses the action prefix
`binance-web3-api.` and currently exposes 58 Crypto actions for market data,
address analytics, RWA data, DEX aggregation, wallet balances, transaction
data/building/broadcast, and DeFi data and transaction building.

Do not confuse it with `binance-web3.` (Binance Web3 Intelligence) or
`binance-spot.` (Binance Spot). They are separate services with different
actions, schemas, and upstream behavior.

## Discovery and shared limit

Discover the service ID instead of persisting a database UUID in automation:

```bash
npx xapi-to services --category Crypto --page-size 100
npx xapi-to list --source api \
  --service-id <binance-web3-api-service-id> --page-size 100
npx xapi-to get binance-web3-api.api_v1_dex_market_token_search
```

The live catalog currently declares a service-level limit of **10 requests per
second per user**, shared across every API key and all 58 endpoints. Pace the
combined workload, not each action independently. The current fixed listed
price is `$0/call`; re-check `get` because limits and pricing can change.

Use a single shared queue per xAPI user and service across workers, endpoints,
and API keys. Separate endpoint-local limiters can exceed the combined quota.
Cache market reads and coalesce identical in-flight requests before dispatch;
cache keys must include the chain, exact token address, bar, and time bounds.
Use short TTLs for the open candle and longer TTLs for closed historical data.
On 429, honor `Retry-After` and the returned quota reset time instead of retrying
immediately. Never cache an upstream business error as market data.

GET actions take `{"method":"GET","params":{...}}` (plus `pathParams` when
the schema requires them). Chain identifiers are Binance IDs such as `"1"`
for Ethereum, `"56"` for BSC, and `"CT_501"` for Solana. They are not the
BlockPI network names or the built-in `crypto.*` chain enum.

## Safe read examples

Discover the current chain list before relying on remembered IDs:

```bash
npx xapi-to call binance-web3-api.api_v1_dex_market_supported_chain \
  --input '{"method":"GET"}'
```

Search by symbol/address, then use the returned contract and chain ID:

```bash
npx xapi-to call binance-web3-api.api_v1_dex_market_token_search --input '{
  "method":"GET","params":{"chains":"1,56,CT_501","search":"USDT"}
}'

npx xapi-to call binance-web3-api.api_v1_dex_market_candles --input '{
  "method":"GET","params":{
    "binanceChainId":"1",
    "tokenContractAddress":"0xdac17f958d2ee523a2206206994597c13d831ec7",
    "bar":"1h","limit":100
  }
}'
```

### Candle pagination and field mapping

`candles.limit` is currently 1–300. `after` is the upper time bound for querying
older candles; `before` is the lower bound for newer candles. Both use Unix
milliseconds, not seconds. Although the official documentation calls them
exclusive, live results may include the boundary candle for either parameter.

For historical backfill, use `after = min(timestampMs) - 1` from the previous
page. Filter each next page to timestamps strictly less than that previous
minimum; deduplicate by `chain ID + token contract + bar + timestampMs`.
Do not depend on response order or just remove the first/last row. Stop on an
empty page or when the cursor does not move backwards; do not loop indefinitely
on repeated boundary data. For newer-page queries, filter strictly above the
previous bound as well.

Binance returns each candle as
`[open, high, low, close, volumeUsd, timestampMs, tradeCount]`.
The official downloadable OpenAPI defines both OHLC prices and volume in USD.
Map index 4 to USD turnover, not base-token quantity; do not synthesize token
volume by dividing it by the close price. Convert index 5 from milliseconds to
seconds only at a consumer boundary that explicitly requires seconds.

For latest-page refreshes, let the newer response replace a candle with the
same key: the current candle's OHLC, volume, and trade count can still change.
Do not use historical duplicate filtering to discard updated open candles.
Read each endpoint's enum independently; portfolio `timeFrame` values, for
example, differ from leaderboard values.

Sources: [official market reference](https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/general-data#get-candles)
and [downloadable OpenAPI](https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/1.0.0/schema.json).
The boundary caveat was reproduced with BSC USDT, `bar=1h`, `limit=3`.

RWA search supports ticker, company name, or contract address:

```bash
npx xapi-to call binance-web3-api.api_v1_dex_market_rwa_search --input '{
  "method":"GET","params":{"keyword":"NVDA","platformId":"ondo"}
}'
```

`platformId` currently accepts `ondo` or `bstock` and is optional.

## Quote and transaction boundary

Aggregator quote amounts are positive integer strings in the sell token's
smallest unit. A quote is not a swap and does not authorize signing:

```bash
npx xapi-to call binance-web3-api.api_v1_dex_aggregator_quote --input '{
  "method":"GET","params":{
    "amount":"1000000","binanceChainId":"56",
    "fromTokenAddress":"0x55d398326f99059fF775485246999027B3197955",
    "toTokenAddress":"0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"
  }
}'
```

The normal flow is `quote` → choose a returned route/`quoteId` (about 30-second
TTL) → `swap` to build transaction data. `quote-and-swap` combines the first
two steps when a vendor is selected. EVM approvals and swaps, Solana compiled
transactions/instructions, RFQ typed data, and DeFi transaction endpoints
return data for the caller to inspect, sign, and submit. They do not authorize
xAPI or an agent to sign on the user's behalf.

Before any sign or broadcast step, obtain explicit approval for the selected
chain, wallet, token addresses, exact amounts, route/vendor, slippage, fees,
approval allowance, recipient, gas policy, and expected transaction effects.
Never pass a private key or seed phrase to xAPI.

## Current POST schema gap

At the time this guide was verified, the serving XAPI action catalog omitted
the `body` from all 18 body-bearing POST operations even though the provider's
current import payload contained those schemas. The nineteenth POST operation,
`token_basic-info`, is intentionally query-only and exposes required `params`
(`binanceChainId` and `tokenContractAddress`). This mismatch is serving-contract
drift, not evidence that the official operations take no input.

Do not copy a Binance-native request body or invent a `body`. For an action that
needs request content, wait until `npx xapi-to get <action-id>` exposes it and
report the service-schema gap instead. The query-only token basic-info action
may be called exactly as its live `params` schema declares. Once fixed, the
live xAPI schema—not this snapshot—is authoritative.

For `price-info`, the official body is an array of up to 100 objects, each
containing `binanceChainId` and `tokenContractAddress`. The latest xhub source
spec already defines this correctly; repairing the serving contract requires
an owner to update endpoint `bodySchema` in a new editable revision and publish
it through review. A repository merge alone does not update the serving catalog.
Use endpoint IDs read from that working revision, not copied serving UUIDs.
Until live `get` exposes the array body, keep this action disabled in adapters.

## Provider errors

Binance may return a successful HTTP response with a nonzero business code.
Treat `code: 0` as success and preserve the upstream code/message on failure.
In particular:

- `40304` means a regional compliance restriction; changing parameters or
  retrying cannot bypass it.
- `40104` means the configured upstream API key lacks permission for that
  product; DeFi access requires explicit enablement.

Do not automatically retry either error or misreport it as an xAPI-key failure.

## Current action catalog (58)

### General Data (13)

- `binance-web3-api.api_v1_dex_market_candles`
- `binance-web3-api.api_v1_dex_market_memepump_tokenDevInfo`
- `binance-web3-api.api_v1_dex_market_price`
- `binance-web3-api.api_v1_dex_market_price-info`
- `binance-web3-api.api_v1_dex_market_supported_chain`
- `binance-web3-api.api_v1_dex_market_token_advanced-info`
- `binance-web3-api.api_v1_dex_market_token_basic-info`
- `binance-web3-api.api_v1_dex_market_token_holder`
- `binance-web3-api.api_v1_dex_market_token_hot-token`
- `binance-web3-api.api_v1_dex_market_token_search`
- `binance-web3-api.api_v1_dex_market_token_top-liquidity`
- `binance-web3-api.api_v1_dex_market_token_top-trader`
- `binance-web3-api.api_v1_dex_market_trades`

### Address Portfolio (7)

- `binance-web3-api.api_v1_dex_market_address-tracker_trades`
- `binance-web3-api.api_v1_dex_market_leaderboard_list`
- `binance-web3-api.api_v1_dex_market_portfolio_dex-history`
- `binance-web3-api.api_v1_dex_market_portfolio_overview`
- `binance-web3-api.api_v1_dex_market_portfolio_recent-pnl`
- `binance-web3-api.api_v1_dex_market_portfolio_supported_chain`
- `binance-web3-api.api_v1_dex_market_portfolio_token_latest-pnl`

### RWA Data (6)

- `binance-web3-api.api_v1_dex_market_rwa_platforms`
- `binance-web3-api.api_v1_dex_market_rwa_price`
- `binance-web3-api.api_v1_dex_market_rwa_search`
- `binance-web3-api.api_v1_dex_market_rwa_tokens`
- `binance-web3-api.api_v1_dex_market_rwa_underlying-market`
- `binance-web3-api.api_v1_dex_market_rwa_underlying-profile`

### Trading API (9)

- `binance-web3-api.api_v1_dex_aggregator_approve-transaction`
- `binance-web3-api.api_v1_dex_aggregator_history`
- `binance-web3-api.api_v1_dex_aggregator_order_{orderId}`
- `binance-web3-api.api_v1_dex_aggregator_quote`
- `binance-web3-api.api_v1_dex_aggregator_quote-and-swap`
- `binance-web3-api.api_v1_dex_aggregator_supported_chain`
- `binance-web3-api.api_v1_dex_aggregator_swap`
- `binance-web3-api.api_v1_dex_aggregator_swap-instruction`
- `binance-web3-api.api_v1_dex_aggregator_order_submit`

### Transaction API (7)

- `binance-web3-api.api_v1_dex_post-transaction_orders`
- `binance-web3-api.api_v1_dex_pre-transaction_block-height`
- `binance-web3-api.api_v1_dex_pre-transaction_broadcast-transaction`
- `binance-web3-api.api_v1_dex_pre-transaction_gas-limit`
- `binance-web3-api.api_v1_dex_pre-transaction_gas-price`
- `binance-web3-api.api_v1_dex_pre-transaction_simulate`
- `binance-web3-api.api_v1_dex_pre-transaction_supported_chain`

### Wallet API (5)

- `binance-web3-api.api_v1_dex_balance_all-token-balances-by-address`
- `binance-web3-api.api_v1_dex_balance_supported_chain`
- `binance-web3-api.api_v1_dex_balance_token-balances-by-address`
- `binance-web3-api.api_v1_dex_post-transaction_transaction-detail-by-txhash`
- `binance-web3-api.api_v1_dex_post-transaction_transactions-by-address`

### DeFi Data and Transaction (11)

- `binance-web3-api.api_v1_defi_data_investment_detail`
- `binance-web3-api.api_v1_defi_data_investment_list`
- `binance-web3-api.api_v1_defi_data_position_list`
- `binance-web3-api.api_v1_defi_data_protocol_detail`
- `binance-web3-api.api_v1_defi_data_protocol_list`
- `binance-web3-api.api_v1_defi_transaction_claim`
- `binance-web3-api.api_v1_defi_transaction_deposit`
- `binance-web3-api.api_v1_defi_transaction_lp-add`
- `binance-web3-api.api_v1_defi_transaction_lp-add_calculate`
- `binance-web3-api.api_v1_defi_transaction_lp-remove`
- `binance-web3-api.api_v1_defi_transaction_redeem`

Use `list --service-id` to detect additions/removals and `get` immediately
before each call. Do not infer that similarly named endpoints share parameters,
enum values, pagination, or response shapes.
