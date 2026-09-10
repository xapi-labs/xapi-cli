# BlockPI RPC Guide

The `rpc` third-party service exposes EVM JSON-RPC through BlockPI. The current
catalog has one generic action and 12 legacy convenience actions over 60
explicitly registered mainnets and testnets. The server supplies the BlockPI
partner credential; callers send only their xAPI key to xAPI and must never ask for, expose, or forward the upstream credential.

Always inspect the live schema and price before calling:

```bash
npx xapi-to get rpc.network
npx xapi-to search "BlockPI RPC" --source api --page-size 100
```

The catalog currently lists each action at `$0.000003/call`; treat `get` as the
authority because pricing and supported networks may change.

## Generic JSON-RPC

Prefer `rpc.network` for arbitrary EVM methods. It accepts exactly one JSON-RPC
request object, not a batch. Keep the HTTP method and JSON-RPC method separate:

```bash
npx xapi-to call rpc.network --input '{
  "method":"POST",
  "pathParams":{"network":"ethereum"},
  "body":{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}
}'
```

The required outer fields are `method`, `pathParams`, and `body`.
`pathParams.network` selects the registered BlockPI network. The body requires
`jsonrpc: "2.0"` and the JSON-RPC `method`; `id` and `params` are optional.

The generic route fails closed with HTTP 503 when the server-side partner key
is unavailable; it never silently sends a raw RPC call without that credential.
The legacy convenience routes have a different availability contract and may
fall back to their configured public RPC endpoints. Diagnose the two route
families separately instead of treating every BlockPI 503 as a bad request.

For example, read an address balance without exposing any provider key:

```bash
npx xapi-to call rpc.network --input '{
  "method":"POST",
  "pathParams":{"network":"base"},
  "body":{"jsonrpc":"2.0","id":"balance-1","method":"eth_getBalance",
          "params":["0x0000000000000000000000000000000000000000","latest"]}
}'
```

## Registered networks

The current `rpc.network` enum contains 60 values:

```text
abstract, arbitrum, arbitrum-nova, arbitrum-sepolia, arc-testnet,
avalanche, avalanche-fuji, base, base-sepolia, berachain, blast, bsc,
bsc-testnet, celo, celo-sepolia, conflux-espace, cronos, ethereum,
ethereum-hoodi, ethereum-sepolia, etherlink, fantom, gnosis, hemi,
hyperliquid, ink, kaia, kaia-kairos, linea, linea-sepolia, mantle, merlin,
merlin-testnet, meter, metis, monad, monad-testnet, optimism,
optimism-sepolia, plasma, plume, polygon, polygon-amoy, robinhood, scroll,
scroll-sepolia, sei-evm, sei-testnet-evm, sonic, stable, story, taiko,
unichain, unichain-sepolia, viction, xlayer, zetachain-athens-evm,
zetachain-evm, zksync-era, zksync-era-sepolia
```

Do not normalize or invent aliases. Re-run `get rpc.network` and use its exact
enum when a network is absent or when the task depends on current support.

## Legacy convenience actions

These actions translate simple REST-shaped inputs to common EVM methods:

- `rpc.network` — arbitrary single JSON-RPC request
- `rpc.chain_blockNumber` — latest block number
- `rpc.chain_call` — `eth_call`
- `rpc.chain_chainId` — chain ID
- `rpc.chain_gasPrice` — gas price
- `rpc.chain_getBalance` — native balance
- `rpc.chain_getBlockByHash` — block by hash
- `rpc.chain_getBlockByNumber` — block by number/tag
- `rpc.chain_getCode` — contract bytecode
- `rpc.chain_getLogs` — event logs
- `rpc.chain_getTransactionByHash` — transaction by hash
- `rpc.chain_getTransactionCount` — address nonce
- `rpc.chain_getTransactionReceipt` — transaction receipt

Legacy actions use `pathParams.chain` plus action-specific query `params`.
Never infer those parameters from the raw JSON-RPC signature; inspect the exact
action first:

```bash
npx xapi-to get rpc.chain_getBalance
npx xapi-to call rpc.chain_getBalance --input '{
  "method":"POST",
  "pathParams":{"chain":"ethereum"},
  "params":{"address":"0x0000000000000000000000000000000000000000",
            "block":"latest"}
}'
```

## Transaction safety

Reads such as block, balance, code, logs, and receipt queries are non-mutating.
Methods such as `eth_sendRawTransaction` can create irreversible on-chain
effects even though they use the same generic action. Before submitting a
signed transaction, obtain explicit approval for the chain, sender, recipient,
value, calldata, gas policy, and transaction hash workflow. Do not send private
keys or seed phrases through xAPI, and do not automatically retry an ambiguous
broadcast. Check the transaction hash or sender nonce first.
