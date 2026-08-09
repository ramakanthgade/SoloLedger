import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearAllData,
  db,
  deduplicateTransactions,
  transactionExchangeKey,
  DEFAULT_SETTINGS
} from '@/lib/storage/db';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import { resolveTaxPolicy } from '@/lib/taxonomy/taxPolicy';
import type { Transaction } from '@/types/transaction';
import { normalizeTrade, normalizeTransfer } from './normalize';
import { bitvavoTransferPageEvidence, paginateBitvavoTransfers } from './engine';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = <T,>(file: string): T =>
  (JSON.parse(readFileSync(join(HERE, '__fixtures__', 'bitvavo', file), 'utf8')) as { response: T }).response;
const market: UnifiedMarket = {
  id: 'BTC-EUR', symbol: 'BTC/EUR', base: 'BTC', quote: 'EUR', spot: true, active: true
};
type CcxtBitvavo = {
  parseTrade(row: unknown, market: UnifiedMarket): UnifiedTrade;
  parseTransactions(
    rows: unknown[], currency?: unknown, since?: number, limit?: number, params?: Record<string, unknown>
  ): UnifiedTransfer[];
};
let bitvavo: CcxtBitvavo;

beforeAll(async () => {
  const ccxt = await import('ccxt') as unknown as { bitvavo: new (config: object) => CcxtBitvavo };
  bitvavo = new ccxt.bitvavo({});
});
beforeEach(async () => clearAllData());

function apiRows(): Transaction[] {
  const trades = fixture<unknown[]>('trades.json').map((raw) => bitvavo.parseTrade(raw, market));
  const transfers = [
    ...bitvavo.parseTransactions(fixture<unknown[]>('deposits.json'), undefined, undefined, undefined, { type: 'deposit' }),
    ...bitvavo.parseTransactions(fixture<unknown[]>('withdrawals.json'), undefined, undefined, undefined, { type: 'withdrawal' })
  ];
  return [
    ...trades.map((trade) => normalizeTrade('bitvavo', trade, market)),
    ...transfers.map((transfer) => normalizeTransfer('bitvavo', transfer))
  ].filter((row): row is Transaction => row != null);
}

describe('Bitvavo pinned parser, tax posting and scoped replay identity', () => {
  it('matches newest-first native pages to ascending CCXT rows and rejects identity collisions', async () => {
    const rawDeposits = fixture<unknown[]>('deposits.json');
    const rawWithdrawals = fixture<unknown[]>('withdrawals.json');
    const deposits = bitvavo.parseTransactions(rawDeposits, undefined, undefined, undefined, { type: 'deposit' });
    const withdrawals = bitvavo.parseTransactions(rawWithdrawals, undefined, undefined, undefined, { type: 'withdrawal' });
    expect(rawDeposits.map((row) => (row as { timestamp: number }).timestamp)).toEqual(
      [...rawDeposits].map((row) => (row as { timestamp: number }).timestamp).sort((a, b) => b - a)
    );
    expect(deposits.map((row) => row.timestamp)).toEqual(
      [...deposits].map((row) => row.timestamp).sort((a, b) => (a ?? 0) - (b ?? 0))
    );
    expect(bitvavoTransferPageEvidence(deposits, rawDeposits, 'deposit').rawValid).toBe(true);
    expect(bitvavoTransferPageEvidence(withdrawals, rawWithdrawals, 'withdrawal').rawValid).toBe(true);

    const result = await paginateBitvavoTransfers({
      endpoint: 'deposit', since: 0, now: 1,
      fetchPage: async () => bitvavoTransferPageEvidence(deposits, rawDeposits, 'deposit')
    });
    expect(result).toMatchObject({ partial: false, maxTs: 1, termination: 'exhausted' });
    expect(result.rows).toHaveLength(3);

    expect(bitvavoTransferPageEvidence(
      [...deposits, deposits[0]], [...rawDeposits, rawDeposits[rawDeposits.length - 1]], 'deposit'
    ).rawValid).toBe(false);
  });

  it('parses fixture transport shapes and imports only settled economics', () => {
    const rows = apiRows();
    expect(rows.map((row) => row.type)).toEqual(['buy', 'sell', 'transfer_in', 'transfer_in', 'transfer_out']);
    expect(rows[0]).toMatchObject({
      source: 'bitvavo_api', sourceRef: '11111111-1111-4111-8111-111111111111',
      asset: 'BTC', amount: 0.01, fiatCurrency: 'EUR', fiatValue: 500,
      feeAmount: 1.25, feeAsset: 'EUR', raw: { exchangeSyncKind: 'trade' }
    });
    expect(rows[2].sourceRef).toBe(
      'bitvavo:0x5167b473fd37811f9ef22364c3d54726a859ef9d98934b3a1e11d7baa8d2c2e2:deposit:1785887990000:BTC:0.02'
    );
    expect(rows[3]).toMatchObject({
      asset: 'EUR', amount: 1250.5,
      sourceRef: 'bitvavo:fiat:["deposit",1785887992000,"EUR",1250.5,0,"completed","NL00BANK0123456789"]'
    });
    expect(rows[4]).toMatchObject({ raw: { exchangeSyncKind: 'withdrawal', transferType: 'withdrawal' } });
  });

  it('posts buys, sells and transfers with existing tax/ledger semantics', () => {
    const rows = apiRows().map((row) => ({ ...row, importBatchId: 'bitvavo-account' }));
    for (const trade of rows.filter((row) => row.type === 'buy' || row.type === 'sell')) {
      expect(resolveTaxPolicy({ kind: 'transaction', transaction: trade, settings: DEFAULT_SETTINGS }).treatment)
        .not.toBe('requires_review');
    }
    const postings = derivePostings(rows, {
      exchangeConnections: [{ id: 'bitvavo-account', exchange: 'bitvavo' }]
    });
    expect(postings.filter((posting) => posting.asset === 'BTC').map((posting) => posting.signedQuantity))
      .toEqual(expect.arrayContaining([0.01, -0.004, 0.02, -0.003]));
    expect(postings.some((posting) => posting.asset === 'EUR' && posting.signedQuantity === 1250.5)).toBe(true);
  });

  it('scopes native/composite refs by connection and immutable endpoint kind', async () => {
    const [trade, , deposit] = apiRows();
    const a = { ...trade, id: 'a', importBatchId: 'account-a' };
    const replay = { ...trade, id: 'replay', importBatchId: 'account-a' };
    const other = { ...trade, id: 'other', importBatchId: 'account-b' };
    expect(transactionExchangeKey(a)).toBe(
      'ex-api:account-a:bitvavo:trade:11111111-1111-4111-8111-111111111111'
    );
    expect(transactionExchangeKey(other)).not.toBe(transactionExchangeKey(a));
    expect(transactionExchangeKey({ ...deposit, importBatchId: 'account-a' })).toContain(':bitvavo:deposit:');
    await db.transactions.bulkPut([a, replay, other]);
    expect(await deduplicateTransactions()).toBe(1);
    expect(await db.transactions.count()).toBe(2);
  });
});
