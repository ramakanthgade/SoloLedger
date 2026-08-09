import { describe, expect, it } from 'vitest';
import { normalizeTrade, normalizeTradeRows, normalizeTransfer } from './normalize';
import { transactionExchangeKey } from '@/lib/storage/db';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { TEST_TAX_SETTINGS } from '@/test/taxSettings';
import coinex from './__fixtures__/coinex/replay.json';
import poloniex from './__fixtures__/poloniex/replay.json';
import woo from './__fixtures__/woo/replay.json';
import hitbtc from './__fixtures__/hitbtc/replay.json';
import bingx from './__fixtures__/bingx/replay.json';

const exchanges = ['coinex', 'poloniex', 'woo', 'hitbtc', 'bingx'] as const;
const fixtures = { coinex, poloniex, woo, hitbtc, bingx };

describe('five exchange native replay references', () => {
  it.each(exchanges)('%s spot fill uses its immutable native fill id', (exchange) => {
    const fixture = fixtures[exchange as keyof typeof fixtures];
    const row = normalizeTrade(exchange, fixture.trade, fixture.market);
    expect(row).toMatchObject({ source: `${exchange}_api`, sourceRef: `${exchange}-fill-1`, type: 'buy' });
  });

  it.each(exchanges)('%s settled transfer uses its immutable wallet record id', (exchange) => {
    const row = normalizeTransfer(exchange, fixtures[exchange as keyof typeof fixtures].deposit, 'deposit');
    expect(row).toMatchObject({
      source: `${exchange}_api`, sourceRef: `${exchange}-deposit-1`, type: 'transfer_in',
      raw: expect.objectContaining({ exchangeSyncKind: 'deposit', transferType: 'deposit' })
    });
  });

  it('makes the requested BingX endpoint authoritative over CCXT transferType', () => {
    const parsedAsDeposit = { ...bingx.deposit, id: 'same-id', type: 'deposit' };
    expect(normalizeTransfer('bingx', parsedAsDeposit, 'deposit')).toMatchObject({
      type: 'transfer_in', raw: expect.objectContaining({ exchangeSyncKind: 'deposit' })
    });
    expect(normalizeTransfer('bingx', parsedAsDeposit, 'withdrawal')).toMatchObject({
      type: 'transfer_out', raw: expect.objectContaining({ exchangeSyncKind: 'withdrawal', transferType: 'withdrawal' })
    });
  });

  it.each(exchanges)('%s rejects trades and transfers without immutable native ids', (exchange) => {
    const fixture = fixtures[exchange as keyof typeof fixtures];
    expect(normalizeTrade(exchange, { ...fixture.trade, id: undefined }, fixture.market)).toBeNull();
    expect(normalizeTransfer(exchange, { ...fixture.deposit, id: undefined }, 'deposit')).toBeNull();
  });

  it.each(exchanges)('%s materializes linked crypto-pair buy/sell rows without duplicate custody or fee postings', (exchange) => {
    const market = { ...fixtures[exchange as keyof typeof fixtures].market, id: 'ETHBTC', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC' };
    const buyRows = normalizeTradeRows(exchange, {
      id: `${exchange}-crypto-buy`, timestamp: 1_700_000_000_000, symbol: 'ETH/BTC', side: 'buy',
      amount: 2, cost: 0.1, fee: { cost: 0.002, currency: 'ETH' }
    }, market);
    const sellRows = normalizeTradeRows(exchange, {
      id: `${exchange}-crypto-sell`, timestamp: 1_700_000_001_000, symbol: 'ETH/BTC', side: 'sell',
      amount: 1, cost: 0.06, fee: { cost: 0.001, currency: 'BTC' }
    }, market);
    expect(buyRows).toMatchObject([
      { type: 'sell', asset: 'BTC', amount: 0.1, feeAsset: 'ETH', feeAmount: 0.002, sourceRef: `${exchange}-crypto-buy:sell` },
      { type: 'buy', asset: 'ETH', amount: 2, feeAmount: undefined, sourceRef: `${exchange}-crypto-buy:buy` }
    ]);
    expect(sellRows).toMatchObject([
      { type: 'sell', asset: 'ETH', amount: 1, feeAsset: 'BTC', feeAmount: 0.001, sourceRef: `${exchange}-crypto-sell:sell` },
      { type: 'buy', asset: 'BTC', amount: 0.06, feeAmount: undefined, sourceRef: `${exchange}-crypto-sell:buy` }
    ]);
    const rows = [...buyRows, ...sellRows];
    expect(rows.some((item) => item.type === 'trade')).toBe(false);
    expect(new Set(rows.map((item) => item.sourceRef)).size).toBe(4);
    const postings = derivePostings(rows, { exchangeConnections: [{ id: 'account', exchange }] });
    expect(postings.map((posting) => [posting.asset, posting.signedQuantity, posting.role]))
      .toEqual([
        ['BTC', -0.1, 'principal'], ['ETH', -0.002, 'fee'], ['ETH', 2, 'principal'],
        ['ETH', -1, 'principal'], ['BTC', -0.001, 'fee'], ['BTC', 0.06, 'principal']
      ]);
  });

  it('opens the acquired ETH lot and uses it for a later ETH sale without core cost-basis trade expansion', () => {
    const market = { ...coinex.market, id: 'ETHBTC', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC' };
    const linked = normalizeTradeRows('coinex', {
      id: 'crypto-fill', timestamp: 2_000, symbol: 'ETH/BTC', side: 'buy', amount: 2, cost: 0.1
    }, market).map((row) => ({ ...row, fiatValue: 1_000, flags: [] }));
    const initialBtc = {
      ...linked[1], id: 'btc-lot', timestamp: 1_000, type: 'buy' as const,
      asset: 'BTC', amount: 0.1, fiatValue: 600, sourceRef: 'btc-lot'
    };
    const laterEthSale = {
      ...linked[0], id: 'eth-sale', timestamp: 3_000, type: 'sell' as const,
      asset: 'ETH', amount: 1, fiatValue: 700, sourceRef: 'eth-sale', feeAmount: undefined, feeAsset: undefined
    };
    const result = calculateCostBasis([initialBtc, ...linked, laterEthSale], {
      method: 'FIFO', settings: TEST_TAX_SETTINGS
    });
    expect(result.disposals.find((row) => row.sourceTxId === linked[0].id)).toMatchObject({
      asset: 'BTC', proceeds: 1_000, costBasis: 600, gain: 400
    });
    expect(result.disposals.find((row) => row.sourceTxId === 'eth-sale')).toMatchObject({
      asset: 'ETH', proceeds: 700, costBasis: 500, gain: 200
    });
    expect(result.lots.find((lot) => lot.sourceTxId === linked[1].id)).toMatchObject({
      asset: 'ETH', amountOriginal: 2, amountRemaining: 1, costBasisTotal: 1_000
    });
  });

  it('scopes durable keys by connection, exchange and immutable endpoint kind', () => {
    const base = { sourceRef: 'shared-native-id', importBatchId: 'account-a', raw: { exchangeSyncKind: 'trade' as const } };
    const keys = exchanges.map((exchange) => transactionExchangeKey({ ...base, source: `${exchange}_api` }));
    expect(keys).toEqual(exchanges.map((exchange) => `ex-api:account-a:${exchange}:trade:shared-native-id`));
    expect(new Set(keys).size).toBe(exchanges.length);
    const trade = keys[0];
    expect(transactionExchangeKey({ ...base, source: 'coinex_api', importBatchId: 'account-b' })).not.toBe(trade);
    expect(transactionExchangeKey({ ...base, source: 'coinex_api', raw: { exchangeSyncKind: 'deposit' } })).not.toBe(trade);
    expect(transactionExchangeKey({ ...base, source: 'coinex_api' })).toBe(trade);
    // Existing stable CSV/API behavior outside these five remains unchanged.
    expect(transactionExchangeKey({ source: 'binance_api', sourceRef: 'legacy-ref' })).toBe('ex:legacy-ref');
  });
});
