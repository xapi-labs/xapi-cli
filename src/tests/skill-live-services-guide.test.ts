import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

const skill = readFileSync(new URL('../../skills/xapi/SKILL.md', import.meta.url), 'utf8');
const domains = readFileSync(new URL('../../skills/xapi/guides/domains.md', import.meta.url), 'utf8');
const blockpi = readFileSync(new URL('../../skills/xapi/guides/blockpi.md', import.meta.url), 'utf8');
const binance = readFileSync(new URL('../../skills/xapi/guides/binance_web3.md', import.meta.url), 'utf8');

describe('bundled xAPI live-service guides', () => {
  it('routes the three service families without bloating the always-loaded skill', () => {
    expect(skill.split('\n').length).toBeLessThan(500);
    for (const guide of ['guides/domains.md', 'guides/blockpi.md', 'guides/binance_web3.md']) {
      expect(skill).toContain(guide);
    }
  });

  it('covers every domain and DNS capability with purchase/write safeguards', () => {
    for (const action of [
      'domain.search', 'domain.check', 'domain.price', 'domain.register',
      'domain.list', 'domain.get', 'dns.list', 'dns.upsert', 'dns.delete',
    ]) expect(domains).toContain(`\`${action}\``);

    for (const safeguard of [
      'non-refundable', 'explicit approval', 'max_price_usd', 'idempotency key',
      'record_id', 'record_index', 'domain.list', 'dns.list',
    ]) expect(domains).toContain(safeguard);
  });

  it('covers the generic and 12 legacy BlockPI actions and credential boundary', () => {
    const actionLines = blockpi.match(/^- `rpc\.[^`]+`/gm) ?? [];
    expect(actionLines).toHaveLength(13);
    for (const required of [
      '60 values', 'rpc.network', 'pathParams', 'jsonrpc', 'server supplies',
      'never ask for, expose, or forward', 'eth_sendRawTransaction', 'keys or seed phrases',
    ]) expect(blockpi).toContain(required);
  });

  it('records all 58 Binance Web3 actions and the live POST-schema limitation', () => {
    const actionLines = binance.match(/^- `binance-web3-api\.[^`]+`/gm) ?? [];
    expect(actionLines).toHaveLength(58);
    for (const required of [
      '10 requests per', 'shared across every API key and all 58 endpoints',
      'smallest unit', 'quoteId', 'explicit approval', 'private key',
      'none of the 19 current POST actions', 'exposed a `body`',
      'report the service-schema gap', 'token_basic-info',
      'binance-web3.', 'binance-spot.',
    ]) expect(binance).toContain(required);
  });
});
