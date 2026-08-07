import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFixtureRows } from '@/lib/parsers/__fixtures__/fixtureUtils';
import { geminiParser } from '@/lib/parsers/gemini';
import { clearAllData, db, deduplicateTransactions, transactionExchangeKey } from '@/lib/storage/db';
import { normalizeTrade, normalizeTransfer } from './normalize';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import type { Transaction } from '@/types/transaction';
import { resolveTaxPolicy } from '@/lib/taxonomy/taxPolicy';
import { DEFAULT_SETTINGS } from '@/lib/storage/db';
import { derivePostings } from '@/lib/ledger/derivedPostings';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = <T,>(file: string): T =>
  (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'gemini', file), 'utf8')) as { response: T }).response;
const markets: Record<string, UnifiedMarket> = {
  'BTC/USD': { id: 'btcusd', symbol: 'BTC/USD', base: 'BTC', quote: 'USD', spot: true, active: true },
  'ETH/USD': { id: 'ethusd', symbol: 'ETH/USD', base: 'ETH', quote: 'USD', spot: true, active: true },
  'ETH/BTC': { id: 'ethbtc', symbol: 'ETH/BTC', base: 'ETH', quote: 'BTC', spot: true, active: true }
};
type CcxtGemini = { parseTrades(rows: unknown[], market: UnifiedMarket): UnifiedTrade[]; parseTransactions(rows: unknown[]): UnifiedTransfer[] };
let gemini: CcxtGemini;

beforeAll(async () => {
  const ccxt = await import('ccxt') as unknown as { gemini: new (config: object) => CcxtGemini };
  gemini = new ccxt.gemini({});
});
beforeEach(async () => clearAllData());

function apiRows() {
  const raw = fixture<Record<string, unknown[]>>('myTrades.json');
  const trades = Object.values(markets).flatMap((market) => gemini.parseTrades(raw[market.id!] ?? [], market));
  const tradeRows = trades.map((trade) => normalizeTrade('gemini', trade, markets[trade.symbol!]))
    .filter((row): row is Transaction => row != null);
  const transferRows = gemini.parseTransactions(fixture<unknown[]>('transfers.json'))
    .map((transfer) => normalizeTransfer('gemini', transfer))
    .filter((row): row is Transaction => row != null);
  return { tradeRows, transferRows };
}

describe('Gemini normalization and dedup safety', () => {
  it('keeps tax semantics, settled-only transfers and native raw evidence', () => {
    const { tradeRows, transferRows } = apiRows();
    expect(tradeRows).toHaveLength(4);
    expect(tradeRows.map((row) => row.type)).toEqual(['buy', 'buy', 'sell', 'trade']);
    expect(tradeRows[3]).toMatchObject({ asset: 'BTC', counterAsset: 'ETH', notes: 'Crypto-for-crypto trade' });
    expect(tradeRows[0]).toMatchObject({ source: 'gemini_api', sourceRef: 'trade:910001', raw: { tradeId: '910001', exchangeSyncKind: 'trade' } });
    expect(transferRows).toHaveLength(2);
    expect(transferRows.map((row) => row.type).sort()).toEqual(['transfer_in', 'transfer_out']);
    expect(transferRows.every((row) => row.flags.includes('possible_internal_transfer'))).toBe(true);
  });

  it('scopes GUSD/SGD fiat economics to Gemini and prefers raw fee currency', () => {
    const gusdMarket = { id: 'btcgusd', symbol: 'BTC/GUSD', base: 'BTC', quote: 'GUSD', spot: true };
    const sgdMarket = { id: 'ethsgd', symbol: 'ETH/SGD', base: 'ETH', quote: 'SGD', spot: true };
    const trade: UnifiedTrade = {
      id: 'fee', timestamp: 1, side: 'buy', amount: 2, cost: 20,
      fee: { cost: 1, currency: 'USD' }, info: { fee_currency: 'GUSD' }
    };
    expect(normalizeTrade('gemini', trade, gusdMarket)).toMatchObject({
      type: 'buy', fiatCurrency: 'USD', fiatValue: 20, feeAsset: 'GUSD'
    });
    expect(normalizeTrade('gemini', trade, sgdMarket)).toMatchObject({
      type: 'buy', fiatCurrency: 'SGD', fiatValue: 20
    });
    // Regression guard: GUSD did not become a global stable quote for existing exchanges.
    expect(normalizeTrade('binance', trade, gusdMarket)).toMatchObject({
      type: 'trade', fiatCurrency: 'USD', fiatValue: undefined
    });
  });

  it('classifies every documented transfer type conservatively and keeps raw network/hash evidence', () => {
    const base = {
      timestamp: 1_000, currency: 'ETH', amount: 2, status: 'ok',
      info: { status: 'Complete' }
    } satisfies UnifiedTransfer;
    const rows = [
      normalizeTransfer('gemini', { ...base, id: 'd', type: 'deposit', info: { ...base.info, type: 'Deposit' } }),
      normalizeTransfer('gemini', { ...base, id: 'w', type: 'withdrawal', info: { ...base.info, type: 'Withdrawal' } }),
      normalizeTransfer('gemini', { ...base, id: 'r', type: 'reward', info: { ...base.info, type: 'Reward' } }),
      normalizeTransfer('gemini', { ...base, id: 'ac', type: 'admincredit', info: { ...base.info, type: 'AdminCredit' } }),
      normalizeTransfer('gemini', { ...base, id: 'ad', type: 'admindebit', info: { ...base.info, type: 'AdminDebit' } })
    ];
    expect(rows.map((row) => row?.type)).toEqual(['transfer_in', 'transfer_out', 'income', 'transfer_in', 'transfer_out']);
    expect(rows[2]).toMatchObject({ category: 'reward', flags: ['missing_market_value'] });
    expect(rows[3]?.flags).toContain('needs_review');
    expect(rows[4]?.flags).toContain('needs_review');
    expect(rows[3]).toMatchObject({ category: 'other', categoryConfidence: 0 });
    expect(rows[4]).toMatchObject({ category: 'other', categoryConfidence: 0 });
    for (const adjustment of [rows[3], rows[4]]) {
      expect(resolveTaxPolicy({ kind: 'transaction', transaction: adjustment!, settings: DEFAULT_SETTINGS }))
        .toMatchObject({ treatment: 'requires_review', reasonCode: 'unsupported_transaction' });
    }
    const postings = derivePostings(
      [rows[3]!, rows[4]!].map((row) => ({ ...row, importBatchId: 'gemini-account' })),
      { exchangeConnections: [{ id: 'gemini-account', exchange: 'gemini' }] }
    );
    expect(postings.map((posting) => posting.signedQuantity)).toEqual([2, -2]);

    const hash = `0x${'a'.repeat(64)}`;
    const withdrawal = normalizeTransfer('gemini', {
      ...base, id: 'chain', type: 'withdrawal', txid: undefined,
      fee: { cost: 0.1, currency: 'ETH' },
      info: { ...base.info, type: 'Withdrawal', network: 'ethereum', txHash: hash, feeCurrency: 'GUSD' }
    });
    expect(withdrawal).toMatchObject({ chain: 'ethereum', txHash: hash, feeAsset: 'GUSD' });
  });

  it('does not silently collapse equal same-second fills and is API-replay idempotent', async () => {
    const first = apiRows().tradeRows.slice(0, 2).map((row) => ({ ...row, importBatchId: 'gemini-account' }));
    expect(first[0].timestamp).toBeGreaterThan(Math.floor(first[0].timestamp / 1000) * 1000);
    expect(first[0].amount).toBe(first[1].amount);
    expect(new Set(first.map((row) => transactionExchangeKey(row))).size).toBe(2);
    await db.transactions.bulkPut(first);
    await db.transactions.bulkPut(apiRows().tradeRows.slice(0, 2).map((row, index) => ({ ...row, id: `replay-${index}`, importBatchId: 'gemini-account' })));
    expect(await deduplicateTransactions()).toBe(2);
    expect(await db.transactions.count()).toBe(2);
  });

  it('keeps API native refs deliberately separate from second-resolution CSV formula twins', () => {
    const csv = geminiParser.parse(loadFixtureRows('../../exchangeSync/__fixtures__/gemini/transactionHistory.csv')).transactions;
    const api = [...apiRows().tradeRows.slice(0, 1), ...apiRows().tradeRows.slice(2), ...apiRows().transferRows];
    expect(csv).toHaveLength(5);
    expect(api).toHaveLength(5);
    expect(new Set([...csv, ...api].map((row) => transactionExchangeKey(row))).size).toBe(10);
  });
});
