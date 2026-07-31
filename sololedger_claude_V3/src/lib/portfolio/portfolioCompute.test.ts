import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import type { CsvImportRow } from '@/lib/storage/db';
import { buildPortfolioHoldings, pairedInternalTransferIds } from './portfolioCompute';

function tx(over: Partial<Transaction>): Transaction {
  return {
    id: over.id ?? crypto.randomUUID(),
    timestamp: over.timestamp ?? Date.UTC(2024, 0, 1),
    type: over.type ?? 'transfer_in',
    asset: over.asset ?? 'USDT',
    amount: over.amount ?? 1,
    fiatCurrency: 'USD',
    source: over.source ?? 'manual',
    flags: [],
    isInternalTransfer: false,
    ...over
  };
}

describe('buildPortfolioHoldings custody conservation', () => {
  it('a paired same-batch internal transfer does not change aggregate holdings', () => {
    const rows = [
      tx({ id: 'deposit', amount: 100 }),
      tx({
        id: 'spot-out', type: 'transfer_out', amount: 40, isInternalTransfer: true,
        source: 'binance', importBatchId: 'csv-1', notes: 'Transfer Between Spot and Funding'
      }),
      tx({
        id: 'funding-in', type: 'transfer_in', amount: 40, isInternalTransfer: true,
        source: 'binance', importBatchId: 'csv-1', timestamp: Date.UTC(2024, 0, 1) + 1_000,
        notes: 'Transfer Between Spot and Funding'
      })
    ];
    expect(buildPortfolioHoldings(rows)).toContainEqual(
      expect.objectContaining({ asset: 'USDT', amount: 100 })
    );
  });

  it('does not pair equal internal rows from different import batches', () => {
    const rows = [
      tx({
        id: 'out', type: 'transfer_out', amount: 40, isInternalTransfer: true,
        source: 'binance', importBatchId: 'csv-1', notes: 'Transfer Between Spot and Funding'
      }),
      tx({
        id: 'in', type: 'transfer_in', amount: 40, isInternalTransfer: true,
        source: 'binance', importBatchId: 'csv-2', timestamp: Date.UTC(2024, 0, 1) + 1_000,
        notes: 'Transfer Between Spot and Funding'
      })
    ];
    expect(pairedInternalTransferIds(rows)).toEqual(new Set());
  });

  it('keeps the existing one-sided internal-out custody behavior', () => {
    const holdings = buildPortfolioHoldings([
      tx({ id: 'deposit', amount: 100 }),
      tx({ id: 'own-wallet-out', type: 'transfer_out', amount: 40, isInternalTransfer: true })
    ]);
    expect(holdings).toContainEqual(expect.objectContaining({ asset: 'USDT', amount: 100 }));
  });

  it('requires opposite raw accounts when provenance is available', () => {
    const rows = [
      tx({ id: 'out', type: 'transfer_out', isInternalTransfer: true, source: 'binance', importBatchId: 'b', raw: { Account: 'Spot' } }),
      tx({ id: 'in', type: 'transfer_in', isInternalTransfer: true, source: 'binance', importBatchId: 'b', raw: { Account: 'Spot' } })
    ];
    expect(pairedInternalTransferIds(rows)).toEqual(new Set());
  });

  it('applies a Binance journal snapshot alongside unrelated wallet rows, including SOL once', () => {
    const batch: CsvImportRow = {
      id: 'b', fileName: 'binance.csv', parserId: 'binance', importedAt: 1, txCount: 2,
      balanceSnapshot: { USDT: 5, SOL: 2 }
    };
    const holdings = buildPortfolioHoldings([
      tx({ id: 'binance-usdt', source: 'binance', importBatchId: 'b', amount: 100 }),
      tx({ id: 'binance-sol', source: 'binance', importBatchId: 'b', asset: 'SOL', amount: 10 }),
      tx({ id: 'wallet-usdt', source: 'rpc:ethereum', chain: 'ethereum', asset: 'USDT', amount: 3 })
    ], [batch]);
    expect(holdings.find((h) => h.asset === 'USDT' && !h.chain)?.amount).toBe(5);
    expect(holdings.find((h) => h.asset === 'USDT' && h.chain === 'ethereum')?.amount).toBe(3);
    expect(holdings.filter((h) => h.asset === 'SOL')).toHaveLength(1);
    expect(holdings.find((h) => h.asset === 'SOL')?.amount).toBe(2);
  });

  it('applies a buy fee in its fee asset exactly once', () => {
    const holdings = buildPortfolioHoldings([
      tx({ id: 'cash', amount: 100 }),
      tx({
        id: 'buy', type: 'buy', asset: 'BTC', amount: 1,
        counterAsset: 'USDT', counterAmount: 50, feeAsset: 'USDT', feeAmount: 2
      })
    ]);
    expect(holdings.find((h) => h.asset === 'USDT')?.amount).toBe(48);
    expect(holdings.find((h) => h.asset === 'BTC')?.amount).toBe(1);
  });
});
