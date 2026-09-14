import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../../skills/xapi/SKILL.md', import.meta.url), 'utf8');
const domains = readFileSync(new URL('../../skills/xapi/guides/domains.md', import.meta.url), 'utf8');
const blockpi = readFileSync(new URL('../../skills/xapi/guides/blockpi.md', import.meta.url), 'utf8');
const binance = readFileSync(new URL('../../skills/xapi/guides/binance_web3.md', import.meta.url), 'utf8');

const DOMAIN_ACTIONS = [
  'domain.search', 'domain.check', 'domain.price', 'domain.register',
  'domain.list', 'domain.get', 'dns.list', 'dns.upsert', 'dns.delete',
];

const BLOCKPI_ACTIONS = [
  'rpc.network', 'rpc.chain_blockNumber', 'rpc.chain_call', 'rpc.chain_chainId',
  'rpc.chain_gasPrice', 'rpc.chain_getBalance', 'rpc.chain_getBlockByHash',
  'rpc.chain_getBlockByNumber', 'rpc.chain_getCode', 'rpc.chain_getLogs',
  'rpc.chain_getTransactionByHash', 'rpc.chain_getTransactionCount',
  'rpc.chain_getTransactionReceipt',
];

const BINANCE_ACTIONS = [
  'binance-web3-api.api_v1_dex_market_candles',
  'binance-web3-api.api_v1_dex_market_memepump_tokenDevInfo',
  'binance-web3-api.api_v1_dex_market_price',
  'binance-web3-api.api_v1_dex_market_price-info',
  'binance-web3-api.api_v1_dex_market_supported_chain',
  'binance-web3-api.api_v1_dex_market_token_advanced-info',
  'binance-web3-api.api_v1_dex_market_token_basic-info',
  'binance-web3-api.api_v1_dex_market_token_holder',
  'binance-web3-api.api_v1_dex_market_token_hot-token',
  'binance-web3-api.api_v1_dex_market_token_search',
  'binance-web3-api.api_v1_dex_market_token_top-liquidity',
  'binance-web3-api.api_v1_dex_market_token_top-trader',
  'binance-web3-api.api_v1_dex_market_trades',
  'binance-web3-api.api_v1_dex_market_address-tracker_trades',
  'binance-web3-api.api_v1_dex_market_leaderboard_list',
  'binance-web3-api.api_v1_dex_market_portfolio_dex-history',
  'binance-web3-api.api_v1_dex_market_portfolio_overview',
  'binance-web3-api.api_v1_dex_market_portfolio_recent-pnl',
  'binance-web3-api.api_v1_dex_market_portfolio_supported_chain',
  'binance-web3-api.api_v1_dex_market_portfolio_token_latest-pnl',
  'binance-web3-api.api_v1_dex_market_rwa_platforms',
  'binance-web3-api.api_v1_dex_market_rwa_price',
  'binance-web3-api.api_v1_dex_market_rwa_search',
  'binance-web3-api.api_v1_dex_market_rwa_tokens',
  'binance-web3-api.api_v1_dex_market_rwa_underlying-market',
  'binance-web3-api.api_v1_dex_market_rwa_underlying-profile',
  'binance-web3-api.api_v1_dex_aggregator_approve-transaction',
  'binance-web3-api.api_v1_dex_aggregator_history',
  'binance-web3-api.api_v1_dex_aggregator_order_{orderId}',
  'binance-web3-api.api_v1_dex_aggregator_quote',
  'binance-web3-api.api_v1_dex_aggregator_quote-and-swap',
  'binance-web3-api.api_v1_dex_aggregator_supported_chain',
  'binance-web3-api.api_v1_dex_aggregator_swap',
  'binance-web3-api.api_v1_dex_aggregator_swap-instruction',
  'binance-web3-api.api_v1_dex_aggregator_order_submit',
  'binance-web3-api.api_v1_dex_post-transaction_orders',
  'binance-web3-api.api_v1_dex_pre-transaction_block-height',
  'binance-web3-api.api_v1_dex_pre-transaction_broadcast-transaction',
  'binance-web3-api.api_v1_dex_pre-transaction_gas-limit',
  'binance-web3-api.api_v1_dex_pre-transaction_gas-price',
  'binance-web3-api.api_v1_dex_pre-transaction_simulate',
  'binance-web3-api.api_v1_dex_pre-transaction_supported_chain',
  'binance-web3-api.api_v1_dex_balance_all-token-balances-by-address',
  'binance-web3-api.api_v1_dex_balance_supported_chain',
  'binance-web3-api.api_v1_dex_balance_token-balances-by-address',
  'binance-web3-api.api_v1_dex_post-transaction_transaction-detail-by-txhash',
  'binance-web3-api.api_v1_dex_post-transaction_transactions-by-address',
  'binance-web3-api.api_v1_defi_data_investment_detail',
  'binance-web3-api.api_v1_defi_data_investment_list',
  'binance-web3-api.api_v1_defi_data_position_list',
  'binance-web3-api.api_v1_defi_data_protocol_detail',
  'binance-web3-api.api_v1_defi_data_protocol_list',
  'binance-web3-api.api_v1_defi_transaction_claim',
  'binance-web3-api.api_v1_defi_transaction_deposit',
  'binance-web3-api.api_v1_defi_transaction_lp-add',
  'binance-web3-api.api_v1_defi_transaction_lp-add_calculate',
  'binance-web3-api.api_v1_defi_transaction_lp-remove',
  'binance-web3-api.api_v1_defi_transaction_redeem',
];

function listedActions(markdown: string, prefix: string): string[] {
  return [...markdown.matchAll(/^- `([^`]+)`/gm)]
    .map((match) => match[1])
    .filter((action) => action.startsWith(prefix));
}

function expectValidJsonExamples(markdown: string, expectedCount: number): void {
  const examples = [...markdown.matchAll(/--input '([\s\S]*?)'/g)].map((match) => match[1]);
  expect(examples).toHaveLength(expectedCount);
  for (const example of examples) expect(() => JSON.parse(example)).not.toThrow();
}

function expectBalancedFences(markdown: string): void {
  expect((markdown.match(/^```/gm) ?? []).length % 2).toBe(0);
}

describe('bundled xAPI live-service guides', () => {
  it('keeps the root skill as a concise router to all three guides', () => {
    expect(skill.split('\n').length).toBeLessThan(400);
    for (const guide of ['guides/domains.md', 'guides/blockpi.md', 'guides/binance_web3.md']) {
      expect(skill).toContain(guide);
    }
    expect(skill).toContain('Do not redirect an explicit BlockPI or Binance Web3 request');
  });

  it('covers the exact domain/DNS action set and purchase/write safeguards', () => {
    for (const action of DOMAIN_ACTIONS) expect(domains).toContain(`\`${action}\``);
    for (const safeguard of [
      'non-refundable', 'explicit approval', 'max_price_usd', 'idempotency key',
      'record_id', 'record_index', 'domain.list', 'dns.list',
    ]) expect(domains).toContain(safeguard);
    expectValidJsonExamples(domains, 9);
    expectBalancedFences(domains);
  });

  it('covers the exact BlockPI action set, credential boundary, and failure modes', () => {
    expect(listedActions(blockpi, 'rpc.')).toEqual(BLOCKPI_ACTIONS);
    for (const required of [
      '60 values', 'pathParams', 'jsonrpc', 'server supplies',
      'never ask for, expose, or forward', 'eth_sendRawTransaction',
      'keys or seed phrases', 'fails closed', 'public RPC endpoints',
    ]) expect(blockpi).toContain(required);
    expectValidJsonExamples(blockpi, 3);
    expectBalancedFences(blockpi);
  });

  it('records the exact 58 Binance actions under the official product taxonomy', () => {
    expect(listedActions(binance, 'binance-web3-api.')).toEqual(BINANCE_ACTIONS);
    for (const heading of [
      'General Data (13)', 'Address Portfolio (7)', 'RWA Data (6)',
      'Trading API (9)', 'Transaction API (7)', 'Wallet API (5)',
      'DeFi Data and Transaction (11)',
    ]) expect(binance).toContain(heading);
  });

  it('documents Binance safety, limits, serving-contract drift, and provider errors', () => {
    for (const required of [
      '10 requests per', 'shared across every API key and all 58 endpoints',
      'smallest unit', 'quoteId', 'explicit approval', 'private key',
      'all 18 body-bearing POST operations', 'serving-contract',
      'report the service-schema gap', '40304', '40104',
      'binance-web3.', 'binance-spot.',
    ]) expect(binance).toContain(required);
    expectValidJsonExamples(binance, 5);
    expectBalancedFences(binance);
  });
});
