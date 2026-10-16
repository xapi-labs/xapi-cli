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

Use the live `get` response as the authority for price, schema, methods and
availability. Prices and supported networks can change; do not apply an EVM
action's price to a separate chain service.

## Select a non-EVM service

These are separate mainnet services, not values of `rpc.network`:

| Chain | Action lookup | Public Gateway route | Request format |
|---|---|---|---|
| Solana | `solana` | `POST https://solana.p.xapi.to/` | Single JSON-RPC 2.0 object; positional `params` |
| NEAR | `near` | `POST https://near.p.xapi.to/` | Single JSON-RPC 2.0 object; method-specific named or positional `params` |
| Starknet | `starknet` | `POST https://starknet.p.xapi.to/` | Single JSON-RPC 2.0 object; method-specific named or positional `params` |
| Bitcoin | `bitcoin`, `bitcoin.block`, `bitcoin.broadcast` | `POST /`, `/block`, `/broadcast` on `https://bitcoin.p.xapi.to` | Single JSON-RPC 1.0 or 2.0 object; positional `params` |
| Aptos | `aptos.v1`, `aptos.v1_transactions`, `aptos.v1_transactions_simulate`, `aptos.v1_transactions_batch` | `/v1` and transaction routes on `https://aptos.p.xapi.to` | REST; JSON or signed-transaction BCS as specified below |

Discover before calling, then inspect the exact returned schema:

```bash
npx xapi-to search "Solana Mainnet" --source api --page-size 100
npx xapi-to get solana
npx xapi-to get near
npx xapi-to get starknet
npx xapi-to get bitcoin
npx xapi-to get aptos.v1_transactions
```

A bare service ID such as `solana` represents `/`; `solana.root` represents a
literal `/root` path and is not a root alias. A human ID can have multiple HTTP
methods: choose the matching schema and pass the HTTP method explicitly. Prefer
the exact endpoint `uuid` returned by discovery when selecting one endpoint;
never invent a UUID or replace a missing/stale UUID with a human alias. Re-discover
instead. For example, this read uses the root Solana Action:

```bash
npx xapi-to call solana --input '{
  "method":"POST",
  "body":{"jsonrpc":"2.0","id":1,"method":"getSlot","params":[]}
}'
```

These JSON-RPC services admit one request object per HTTP call, not batch arrays
or notifications. Inspect JSON-RPC `error` even with HTTP 200. Bitcoin wallet
methods and public `/mempool` access are unavailable in the maintained contract.
NEAR and Starknet submission methods are disabled in the maintained contract;
do not infer write support from their read operations. Solana, Bitcoin and Aptos
submission also depend on operator gates and the serving revision. An advertised
route is not proof that its gate is enabled. HTTPS/HTTP/2 transport support does
not imply gRPC or WebSocket subscriptions.

## Aptos JSON and BCS

Inspect the serving contract and exact endpoint before preparing a request:

| Method and path | Request media type | Meaning |
|---|---|---|
| `GET /v1` | No body | Ledger information |
| `POST /v1/transactions` | `application/json` or `application/x.aptos.signed_transaction+bcs` | One caller-signed transaction |
| `POST /v1/transactions/simulate` | Same JSON or signed-transaction BCS types | Simulation; inspect each VM result |
| `POST /v1/transactions/batch` | `application/x.aptos.signed_transaction+bcs` only | BCS vector of 1–20 signed transactions |

All three transaction POST routes have a 256 KiB body limit. Generic CLI/MCP
Action execution currently encodes request bodies as JSON; it does not upload
raw BCS input. Use the public Gateway with `--data-binary @file` for BCS. CLI
`--output` saves response bytes and does not turn JSON input into a BCS upload.
Do not send a filename, base64/hex text, or a JSON array as the raw BCS body.

For JSON simulation, prepare `simulation.json` using the intended transaction
fields, current sender sequence number and corresponding public key, with an
SDK simulation authenticator or deliberately non-verifying signature. Ed25519
simulation commonly uses 64 zero-filled signature bytes; valid signatures are
rejected by the simulation API. Simulation does not broadcast, but can still
incur a billed call. Use a normally configured xAPI key in `XAPI_KEY`:

```bash
curl -sS -i https://aptos.p.xapi.to/v1/transactions/simulate \
  -H "XAPI-KEY: $XAPI_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @simulation.json
```

The same simulation can be encoded by an Aptos SDK as one complete
`SignedTransaction` with a non-verifying authenticator:

```bash
curl -sS -i https://aptos.p.xapi.to/v1/transactions/simulate \
  -H "XAPI-KEY: $XAPI_KEY" \
  -H 'Content-Type: application/x.aptos.signed_transaction+bcs' \
  --data-binary @simulation.bcs
```

Single submission uses `/v1/transactions` with the JSON signed transaction or
raw SDK-encoded `SignedTransaction` file and the matching media type. Submission
examples require the explicit transaction approval described under Transaction
safety; a simulation result alone does not authorize a broadcast.

For an approved batch, serialize a BCS **vector**, including its ULEB128 length
prefix (counts 1–20 use one byte), followed by the complete signed transactions.
Use the SDK vector serializer; concatenating single-transaction files omits the
vector length and is invalid. After transaction approval:

```bash
curl -sS -i https://aptos.p.xapi.to/v1/transactions/batch \
  -H "XAPI-KEY: $XAPI_KEY" \
  -H 'Content-Type: application/x.aptos.signed_transaction+bcs' \
  --data-binary @approved-signed-transactions.bcs
```

JSON batch requests return HTTP 415. HTTP 206 means partial batch acceptance:
inspect per-transaction failures and query the accepted transactions before any
retry. Neither 202/single acceptance nor 206/batch acceptance proves inclusion,
execution success or finality; confirm each hash on-chain. HTTP 200 simulation
can contain `success:false` and a VM error, so it is not a successful transfer.

Production forwarding verification on 2026-10-16 used only invalid signatures:
single JSON/BCS returned signature rejection; BCS batch reached upstream batch
validation; simulation returned HTTP 200 with a failed VM result. Plain, gzip
and chunked BCS variants produced consistent logical payload and validation
results. This verifies forwarding and rejection, not valid transaction acceptance
or on-chain confirmation. Use a deliberately invalid, format-complete fixture
for a forwarding check; do not construct a valid signed transaction to obtain 2xx.

The maintained public Aptos contract has 27 operations. Raw table
`POST /v1/tables/{handle}/raw_item` is hidden pending upstream compatibility.
`hidden` controls public discovery/export and does not disable an existing
runtime route. Do not infer availability from its omission or advertise it as
supported. Its binary response type `application/x-bcs` is different from the
signed-transaction **request** media type above.

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
Methods such as `eth_sendRawTransaction`, Solana `sendTransaction`, Bitcoin
`sendrawtransaction` and Aptos single/batch submission can create irreversible on-chain
effects even though they use the same generic action. Before submitting a
signed transaction, obtain explicit approval for the chain, sender, recipient,
value, calldata, gas policy, and transaction hash workflow. Do not send private
keys or seed phrases through xAPI, and do not automatically retry an ambiguous
broadcast. Check the transaction hash or sender nonce first. For a batch, approval
must cover every transaction; partial acceptance does not authorize resending
the complete batch.
