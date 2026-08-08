import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { normalizeTrade, normalizeTransfer } from './normalize';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

/**
 * Batch-1 exchange normalization (Bitstamp, Bitget, MEXC, BitMart, Bitvavo).
 * Drives the REAL ccxt 4.5.68 parsers over hand-authored raw responses to
 * prove the unified shape the engine consumes, then asserts the §B-5b
 * sourceRef identity (native id first, formula fallback) and the settled-only
 * transfer filter. No CSV twin parsers exist for these exchanges yet, so
 * there is no dedup contract to pin here — only API↔API idempotence via the
 * stable native id.
 */

interface CcxtParser {
  parseTrades(rows: unknown[], market?: UnifiedMarket): UnifiedTrade[];
  parseTransactions(rows: unknown[]): UnifiedTransfer[];
}

const btcUsdt: UnifiedMarket = { id: 'BTCUSDT', symbol: 'BTC/USDT', base: 'BTC', quote: 'USDT', spot: true, active: true };

async function parser(exchange: string): Promise<CcxtParser> {
  const ccxt = await import('ccxt') as unknown as Record<string, new (config: object) => CcxtParser>;
  return new ccxt[exchange]({ options: { defaultType: 'spot' } });
}

// ---- Bitstamp: user_transactions, type 2 = market trade; keys carry the pair ----
describe('Bitstamp (user_transactions type=2 trade rows)', () => {
  it('parses a buy fill and maps the native numeric id as sourceRef', async () => {
    const client = await parser('bitstamp');
    const raw = [{
      fee: '0.11128',
      btc_usd: '4451.25',
      datetime: '2021-11-25 12:59:59.322000',
      usd: '-22.26',
      order_id: 1429545880227846,
      btc: '0.00500000',
      type: '2', // market trade
      id: 209895701,
      eur: '0'
    }];
    const btcUsd: UnifiedMarket = { id: 'BTCUSD', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', spot: true, active: true };
    const trades = client.parseTrades(raw, undefined);
    expect(trades).toHaveLength(1);
    const tx = normalizeTrade('bitstamp', trades[0], btcUsd);
    expect(tx).toMatchObject({ source: 'bitstamp_api', sourceRef: '209895701', type: 'buy', asset: 'BTC', amount: 0.005 });
  });
});

// ---- Bitget: V2 spot fills ----
describe('Bitget (V2 spot fills)', () => {
  it('parses a fill and uses the native tradeId as sourceRef', async () => {
    const client = await parser('bitget');
    const raw = [{
      userId: '7264631751',
      symbol: 'BTCUSDT',
      orderId: '1098394344925597696',
      tradeId: '1098394344974925824',
      orderType: 'market',
      side: 'sell',
      priceAvg: '28467.68',
      size: '0.0002',
      amount: '5.693536',
      feeDetail: { deduction: 'no', feeCoin: 'USDT', totalDeductionFee: '', totalFee: '-0.005693536' },
      tradeScope: 'taker',
      cTime: '1697603539699',
      uTime: '1697603539754'
    }];
    const trades = client.parseTrades(raw, btcUsdt);
    expect(trades).toHaveLength(1);
    const tx = normalizeTrade('bitget', trades[0], btcUsdt);
    expect(tx).toMatchObject({ source: 'bitget_api', sourceRef: '1098394344974925824', type: 'sell', asset: 'BTC', amount: 0.0002 });
  });

  it('parses a settled deposit and uses the native orderId as sourceRef', async () => {
    const client = await parser('bitget');
    const raw = [{
      orderId: '1083832260799930368',
      tradeId: '35bf0e588a42b25c71a9d45abe7308cabdeec6b7b423910b9bd4743d3a9a9efa',
      coin: 'BTC',
      type: 'deposit',
      size: '0.00030000',
      status: 'success',
      toAddress: '1BfZh7JESJGBUszCGeZnzxbVVvBycbJSbA',
      dest: 'on_chain',
      chain: 'BTC',
      fromAddress: null,
      cTime: '1694131668281',
      uTime: '1694131680247'
    }];
    const transfers = client.parseTransactions(raw);
    const tx = normalizeTransfer('bitget', transfers[0]);
    expect(tx).toMatchObject({ source: 'bitget_api', sourceRef: '1083832260799930368', type: 'transfer_in', asset: 'BTC', amount: 0.0003 });
  });
});

// ---- MEXC: Binance-style myTrades + capital deposit/withdraw hisrec ----
describe('MEXC (spot myTrades)', () => {
  it('parses a buy fill and uses the native id as sourceRef', async () => {
    const client = await parser('mexc');
    const raw = [{
      symbol: 'BTCUSDT',
      id: '133948532984922113',
      orderId: '133948532531949568',
      orderListId: '-1',
      price: '41995.51',
      qty: '0.0002',
      quoteQty: '8.399102',
      commission: '0.016798204',
      commissionAsset: 'USDT',
      time: '1647718055000',
      isBuyer: true,
      isMaker: false,
      isBestMatch: true
    }];
    const trades = client.parseTrades(raw, btcUsdt);
    expect(trades).toHaveLength(1);
    const tx = normalizeTrade('mexc', trades[0], btcUsdt);
    expect(tx).toMatchObject({ source: 'mexc_api', sourceRef: '133948532984922113', type: 'buy', asset: 'BTC', amount: 0.0002 });
  });

  it('keeps only settled transfers (deposit status 5 = ok)', async () => {
    const client = await parser('mexc');
    const settled = [{
      amount: '10',
      coin: 'USDC-TRX',
      network: 'TRX',
      status: '5', // SUCCESS
      address: 'TSMcEDDvkqY9dz8RkFnrS86U59GwEZjfvh',
      txId: '51a8f49e6f03f2c056e71fe3291aa65e1032880be855b65cecd0595a1b8af95b:0',
      insertTime: '1664805021000',
      unlockConfirm: '200',
      confirmTimes: '203'
    }];
    const pending = [{ ...settled[0], status: '4', amount: '7' }]; // PENDING
    const settledTx = normalizeTransfer('mexc', client.parseTransactions(settled)[0]);
    expect(settledTx).toMatchObject({ source: 'mexc_api', type: 'transfer_in', amount: 10 });
    const pendingTx = normalizeTransfer('mexc', client.parseTransactions(pending)[0]);
    expect(pendingTx).toBeNull();
  });
});

// ---- BitMart: V4 query-trades + V2 deposit-withdraw history ----
describe('BitMart (V4 query-trades)', () => {
  it('parses a fill and uses the native tradeId as sourceRef', async () => {
    const client = await parser('bitmart');
    const raw = [{
      tradeId: '182342999769370687',
      orderId: '183270218784142990',
      clientOrderId: '183270218784142990',
      symbol: 'BTC_USDT',
      side: 'buy',
      orderMode: 'spot',
      type: 'market',
      price: '0.245948',
      size: '20.71',
      notional: '5.09358308',
      fee: '0.00509358',
      feeCoinName: 'USDT',
      createTime: 1695658457836
    }];
    const trades = client.parseTrades(raw, btcUsdt);
    expect(trades).toHaveLength(1);
    const tx = normalizeTrade('bitmart', trades[0], btcUsdt);
    expect(tx).toMatchObject({ source: 'bitmart_api', sourceRef: '182342999769370687', type: 'buy', asset: 'BTC' });
  });

  it('keeps only settled transfers (status 3 = ok)', async () => {
    const client = await parser('bitmart');
    const ok = [{ withdraw_id: '1679952', deposit_id: '', operation_type: 'withdraw', currency: 'BTC', apply_time: 1588867374000, arrival_amount: '59.0', fee: '1.0', status: 3, address: '0xabc', address_memo: '', tx_id: '0xtx' }];
    const pending = [{ ...ok[0], status: 0 }];
    expect(normalizeTransfer('bitmart', client.parseTransactions(ok)[0])).toMatchObject({ source: 'bitmart_api', type: 'transfer_out' });
    expect(normalizeTransfer('bitmart', client.parseTransactions(pending)[0])).toBeNull();
  });
});

// ---- Bitvavo: trade history + deposit/withdrawal history ----
describe('Bitvavo (trade history)', () => {
  it('parses a fill and uses the native uuid id as sourceRef', async () => {
    const client = await parser('bitvavo');
    const raw = [{
      id: 'b0c86aa5-6ed3-4a2d-ba3a-be9a964220f4',
      orderId: 'af76d6ce-9f7c-4006-b715-bb5d430652d0',
      timestamp: 1590505649245,
      market: 'BTC-EUR',
      side: 'sell',
      amount: '0.249825',
      price: '183.49',
      taker: true,
      fee: '0.12038925',
      feeCurrency: 'EUR',
      settled: true
    }];
    const btcEur: UnifiedMarket = { id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true, active: true };
    const trades = client.parseTrades(raw, btcEur);
    expect(trades).toHaveLength(1);
    const tx = normalizeTrade('bitvavo', trades[0], btcEur);
    expect(tx).toMatchObject({ source: 'bitvavo_api', sourceRef: 'b0c86aa5-6ed3-4a2d-ba3a-be9a964220f4', type: 'sell', asset: 'BTC' });
  });

  it('keeps only settled transfers (status completed = ok)', async () => {
    const client = await parser('bitvavo');
    const done = [{ transactionId: 'abc-1', timestamp: 1590505649245, type: 'withdrawal', amount: '0.1', symbol: 'BTC', status: 'completed', address: '1xyz', txId: 'txhash' }];
    const pending = [{ ...done[0], status: 'sending' }];
    expect(normalizeTransfer('bitvavo', client.parseTransactions(done)[0])).toMatchObject({ source: 'bitvavo_api', type: 'transfer_out' });
    expect(normalizeTransfer('bitvavo', client.parseTransactions(pending)[0])).toBeNull();
  });
});
