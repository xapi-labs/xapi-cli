# Crypto Guide

Complete guide for crypto/on-chain data via xAPI — token price & market data, holders, security, OHLCV, wallet analytics, DEX pairs, CEX spot prices, and news.

All crypto endpoints are **built-in capabilities** (`--source capability`). Pass parameters with `--input` as a JSON object.

## Contents

- [Addressing models](#the-two-addressing-models-read-this-first)
- [Chains](#chains)
- [Token data](#token-data-by-contract-address)
- [Wallet analytics](#wallet-analytics-by-wallet-address)
- [Transactions and DEX pairs](#transaction-and-dex-pair)
- [CEX spot data](#cex-spot-data-by-symbol)
- [News](#news)
- [Symbol-to-contract workflow](#common-workflow-from-symbol-to-on-chain-data)
- [Pagination](#cursor-pagination)
- [Error handling](#error-handling)

## The two addressing models (read this first)

Crypto endpoints split into two families by how you identify the asset:

| Family | Identify by | Endpoints | Use when |
|--------|-------------|-----------|----------|
| **On-chain** | **contract / wallet / pool address** + `chain` | `crypto.token.*`, `crypto.wallet.*`, `crypto.tx.*`, `crypto.dex.*` | You have (or can resolve) a contract address on a specific chain |
| **CEX** | **symbol** (BTC, ETH, …) | `crypto.cex.*` | You only have a ticker symbol and want a centralized-exchange spot price |

**Common mistake:** do NOT pass a symbol like `"BTC"` as the `token` of `crypto.token.price` — that field is a **contract address**. For "how much is BTC worth?" use `crypto.cex.price` with `{"symbol":"BTC"}`. If the user gives you a name/symbol and you need on-chain data, first resolve it to an address with `crypto.token.search` (see workflow below).

## Chains

`chain` accepts these canonical values (default `bsc`):

`eth` · `bsc` · `solana` · `base` · `arbitrum` · `polygon` · `optimism` · `avalanche`

Common aliases are normalized automatically: `ethereum`/`ether` → `eth`, `bnb`/`bnb-chain`/`binance`/`binance-smart-chain` → `bsc`, `sol` → `solana`.

All on-chain endpoints accept an optional `provider` to pin a specific upstream and **disable automatic fallback**. By default the gateway aggregates several upstreams (e.g. moralis / birdeye / dexscreener, depending on chain and endpoint) and falls back on failure. The valid `provider` values differ per endpoint — run `npx xapi-to get <id>` to see the exact enum. Only pin a provider for debugging or when you need a specific source.

## Token data (by contract address)

### Price + 24h market data

```bash
npx xapi-to call crypto.token.price \
  --input '{"token":"0x55d398326f99059ff775485246999027b3197955","chain":"bsc"}'
```

Returns `data.priceUsd`, `symbol`, `name`, plus 24h change / volume / liquidity / market cap (fields depend on the resolving provider).

### Full overview (metadata + price + market in one call) — preferred

```bash
npx xapi-to call crypto.token.overview \
  --input '{"token":"0x55d398326f99059ff775485246999027b3197955","chain":"bsc"}'
```

Prefer `crypto.token.overview` over the deprecated `crypto.token.metadata` — it returns name/symbol/decimals/logo **and** price/market data in a single request.

> `crypto.token.metadata` still works but is **deprecated**; migrate to `crypto.token.overview`.

### OHLCV candles

```bash
npx xapi-to call crypto.token.ohlcv \
  --input '{"token":"0x...","chain":"bsc","interval":"1h","limit":100}'
```

`interval` defaults to `1d`; valid values are `1m`, `5m`, `15m`, `1h`, `4h`, `1d`, `1w`. `limit` is the number of candles. (Same interval set applies to `crypto.cex.ohlcv`.)

### Holders / top traders / security

```bash
# Top holders (optional limit)
npx xapi-to call crypto.token.holders --input '{"token":"0x...","chain":"bsc","limit":50}'

# Top traders of the token
npx xapi-to call crypto.token.top_traders --input '{"token":"0x...","chain":"bsc"}'

# Security check (honeypot, buy/sell tax, ownership, etc.)
npx xapi-to call crypto.token.security --input '{"token":"0x...","chain":"bsc"}'
```

Run `crypto.token.security` before treating any token as tradeable — it flags honeypots and abnormal taxes.

`crypto.token.holders` is paginated. When the response contains `data.next_cursor`, pass it back unchanged:

```bash
npx xapi-to call crypto.token.holders \
  --input '{"token":"0x...","chain":"bsc","limit":50,"cursor":"<next_cursor>"}'
```

Moralis supports holder pagination on EVM chains and Birdeye supports it on Solana. The cursor pins the provider that issued it.

### Trending tokens (chain-level, no address needed)

```bash
npx xapi-to call crypto.token.trending --input '{"chain":"bsc","limit":20}'
```

### Search tokens by name / symbol / address

```bash
npx xapi-to call crypto.token.search --input '{"query":"PEPE","limit":10}'
```

`query` can be a name, symbol, pair, or address. Results include contract addresses you can feed into the other `crypto.token.*` endpoints.

## Wallet analytics (by wallet address)

```bash
# Current token balances
npx xapi-to call crypto.wallet.balance --input '{"address":"0x...","chain":"bsc"}'

# Realized/unrealized profit & loss
npx xapi-to call crypto.wallet.pnl --input '{"address":"0x...","chain":"bsc"}'

# Transaction history (optional limit)
npx xapi-to call crypto.wallet.history --input '{"address":"0x...","chain":"bsc","limit":50}'
```

Typical wallet-analysis flow: `wallet.balance` (what they hold) → `wallet.pnl` (how they're doing) → `wallet.history` (recent activity).

`crypto.wallet.balance` and `crypto.wallet.history` are paginated when served by Moralis. Read `data.next_cursor` and pass it back as `cursor` for the next page. `crypto.wallet.pnl` is not paginated.

## Transaction and DEX pair

```bash
# Decode a single transaction
npx xapi-to call crypto.tx.detail --input '{"txHash":"0x...","chain":"bsc"}'

# DEX pair / pool stats by pair contract address
npx xapi-to call crypto.dex.pair --input '{"pair":"0x...","chain":"bsc"}'
```

Note `crypto.dex.pair` takes the **pool/pair contract address** (not a token address).

## CEX spot data by symbol

Use these when you only have a ticker and want a centralized-exchange price.

```bash
# Spot price + 24h change/volume/high/low
npx xapi-to call crypto.cex.price --input '{"symbol":"BTC"}'

# CEX OHLCV candles
npx xapi-to call crypto.cex.ohlcv --input '{"symbol":"BTC","interval":"1d","limit":100}'
```

`symbol` accepts a bare ticker (`BTC`, `ETH`) or a full pair (`BTCUSDT`, `BTC-USDT`). For a bare symbol you may pass `quote` (default `USDT`).

## News

```bash
# Latest crypto news, optionally scoped to a coin
npx xapi-to call crypto.news --input '{"symbol":"BTC","limit":20}'
```

All parameters are optional; omit `symbol` for general market news.

## Common workflow from symbol to on-chain data

The user gives you a token name or symbol but you need on-chain metrics (holders, security, liquidity):

```bash
# 1. Resolve the symbol/name to a contract address + chain
npx xapi-to call crypto.token.search --input '{"query":"PEPE"}'
#    → pick the right result, read its contract address and chain

# 2. Query on-chain endpoints with that address
npx xapi-to call crypto.token.overview --input '{"token":"0x6982...","chain":"eth"}'
npx xapi-to call crypto.token.security --input '{"token":"0x6982...","chain":"eth"}'
```

For a plain "what's the price of BTC" question with no on-chain requirement, skip all of this and use `crypto.cex.price`.

## Cursor Pagination

Three crypto capabilities expose cursor pagination:

| Capability | Next cursor field | Next request input | Paging providers |
|---|---|---|---|
| `crypto.token.holders` | `data.next_cursor` | `cursor` | Moralis (EVM), Birdeye (Solana) |
| `crypto.wallet.balance` | `data.next_cursor` | `cursor` | Moralis |
| `crypto.wallet.history` | `data.next_cursor` | `cursor` | Moralis |

The cursor is an opaque `<provider>:<native>` value. Do not parse, edit, or combine it with a different explicit `provider`; pass it back unchanged. A cursor pins requests to its issuing provider, so pagination deliberately does not fall back to a different upstream. Stop when `next_cursor` is null or absent.

`crypto.token.trending` and `crypto.token.top_traders` are top-N list capabilities, not cursor-paginated feeds.

## Error handling

- **Unsupported chain** → use one of the canonical chain values listed above (or a known alias).
- **`token`/`address` looks like a symbol** → it must be a contract/wallet address; resolve via `crypto.token.search`, or switch to `crypto.cex.*` for symbol-based pricing.
- **Empty / partial fields** → different upstream providers return different field sets; pin a `provider` or try `crypto.token.overview` for the most complete payload.
- **Invalid or mismatched cursor** → pass `next_cursor` back unchanged and do not force a different provider; start again without `cursor` if the original cursor is unavailable.
