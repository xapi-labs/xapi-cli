# Binance Web3 API Guide

The official `Binance Web3 API` service uses the action prefix
`binance-web3-api.` and currently exposes 58 Crypto actions for market data,
address analytics, RWA data, DEX aggregation, wallet balances, transaction
data/building/broadcast, and DeFi data and transaction building.

Do not confuse it with `binance-web3.` (Binance Web3 Intelligence) or
`binance-spot.` (Binance Spot). They are separate services with different
actions, schemas, and upstream behavior.

## Discovery and shared limit

The current service ID is `02a6d64c-dd64-4ff3-aa0b-d1d2eccdec67`:

```bash
npx xapi-to list --source api \
  --service-id 02a6d64c-dd64-4ff3-aa0b-d1d2eccdec67 --page-size 100
npx xapi-to get binance-web3-api.api_v1_dex_market_token_search
```

The live catalog currently declares a service-level limit of **10 requests per
second per user**, shared across every API key and all 58 endpoints. Pace the
combined workload, not each action independently. The current fixed listed
price is `$0/call`; re-check `get` because limits and pricing can change.

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

`candles.limit` is currently 1–300. `before` and `after` are exclusive Unix
millisecond bounds. Read each endpoint's enum independently; for example,
portfolio `timeFrame` values differ from leaderboard values.

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

At the time this guide was verified, none of the 19 current POST actions
exposed a `body` in its live `get` schema. Eighteen exposed only the fixed
`method: "POST"`; the one exception, `token_basic-info`, also exposes required
query `params` (`binanceChainId` and `tokenContractAddress`) and can be called
with those declared fields. The missing body affects balance-by-token, token
price/info, transaction simulation/broadcast/gas estimation, RFQ order
submission, and all 11 DeFi POST actions.

Do not copy a Binance-native request body or invent a `body`. For an action that
needs request content, wait until `npx xapi-to get <action-id>` exposes it and
report the service-schema gap instead. The query-only token basic-info action
may be called exactly as its live `params` schema declares. Once fixed, the
live xAPI schema—not this snapshot—is authoritative.

## Current action catalog (58)

### DEX aggregation (9)

- `binance-web3-api.api_v1_dex_aggregator_approve-transaction`
- `binance-web3-api.api_v1_dex_aggregator_history`
- `binance-web3-api.api_v1_dex_aggregator_order_{orderId}`
- `binance-web3-api.api_v1_dex_aggregator_quote`
- `binance-web3-api.api_v1_dex_aggregator_quote-and-swap`
- `binance-web3-api.api_v1_dex_aggregator_supported_chain`
- `binance-web3-api.api_v1_dex_aggregator_swap`
- `binance-web3-api.api_v1_dex_aggregator_swap-instruction`
- `binance-web3-api.api_v1_dex_aggregator_order_submit`

### Wallet balances (3)

- `binance-web3-api.api_v1_dex_balance_all-token-balances-by-address`
- `binance-web3-api.api_v1_dex_balance_supported_chain`
- `binance-web3-api.api_v1_dex_balance_token-balances-by-address`

### Market, address profile, and RWA data (26)

- `binance-web3-api.api_v1_dex_market_address-tracker_trades`
- `binance-web3-api.api_v1_dex_market_candles`
- `binance-web3-api.api_v1_dex_market_leaderboard_list`
- `binance-web3-api.api_v1_dex_market_memepump_tokenDevInfo`
- `binance-web3-api.api_v1_dex_market_portfolio_dex-history`
- `binance-web3-api.api_v1_dex_market_portfolio_overview`
- `binance-web3-api.api_v1_dex_market_portfolio_recent-pnl`
- `binance-web3-api.api_v1_dex_market_portfolio_supported_chain`
- `binance-web3-api.api_v1_dex_market_portfolio_token_latest-pnl`
- `binance-web3-api.api_v1_dex_market_rwa_platforms`
- `binance-web3-api.api_v1_dex_market_rwa_price`
- `binance-web3-api.api_v1_dex_market_rwa_search`
- `binance-web3-api.api_v1_dex_market_rwa_tokens`
- `binance-web3-api.api_v1_dex_market_rwa_underlying-market`
- `binance-web3-api.api_v1_dex_market_rwa_underlying-profile`
- `binance-web3-api.api_v1_dex_market_supported_chain`
- `binance-web3-api.api_v1_dex_market_token_advanced-info`
- `binance-web3-api.api_v1_dex_market_token_holder`
- `binance-web3-api.api_v1_dex_market_token_hot-token`
- `binance-web3-api.api_v1_dex_market_token_search`
- `binance-web3-api.api_v1_dex_market_token_top-liquidity`
- `binance-web3-api.api_v1_dex_market_token_top-trader`
- `binance-web3-api.api_v1_dex_market_trades`
- `binance-web3-api.api_v1_dex_market_price`
- `binance-web3-api.api_v1_dex_market_price-info`
- `binance-web3-api.api_v1_dex_market_token_basic-info`

### Transaction data, building, and broadcast (9)

- `binance-web3-api.api_v1_dex_post-transaction_orders`
- `binance-web3-api.api_v1_dex_post-transaction_transaction-detail-by-txhash`
- `binance-web3-api.api_v1_dex_post-transaction_transactions-by-address`
- `binance-web3-api.api_v1_dex_pre-transaction_block-height`
- `binance-web3-api.api_v1_dex_pre-transaction_gas-price`
- `binance-web3-api.api_v1_dex_pre-transaction_supported_chain`
- `binance-web3-api.api_v1_dex_pre-transaction_broadcast-transaction`
- `binance-web3-api.api_v1_dex_pre-transaction_gas-limit`
- `binance-web3-api.api_v1_dex_pre-transaction_simulate`

### DeFi data and transaction building (11)

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
