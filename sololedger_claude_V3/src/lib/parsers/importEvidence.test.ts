import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { assertValidSourceCoverageRow } from '@/lib/reconcile/sourceCoverage';

import { buildCsvImportEvidenceGeneration } from './importEvidence';
import { stitchBinanceTransactionHistory } from './binanceStitch';

beforeEach(() => vi.clearAllMocks());

describe('CSV structured evidence persistence', () => {
  it('keeps post-dedup counts unknown without exact transaction-to-source-row mappings', async () => {
    const rows = buildCsvImportEvidenceGeneration({
      sourceIdentityId: 'hash-1', parserId: 'binance', parsedBeforeDedup: 5, savedAfterDedup: 3,
      evidence: {
        coveredAccountClasses: ['spot'],
        requiredOutcomes: [{ id: 'history', accountClass: 'spot', required: true, status: 'complete' }],
        recognizedCount: 6, parsedCount: 5, excludedCount: 1, skippedCount: 0, failedCount: 0,
        exclusionReasons: [{ reason: 'Principal-only row.', count: 1 }],
        skippedReasons: [], failureReasons: []
      },
      completedAt: 100, generation: 3
    });

    expect(rows.snapshots).toEqual([]);
    expect(rows.coverage).toEqual([expect.objectContaining({
      generation: 3,
      status: 'unknown',
      recognizedCount: 6,
      parsedCount: undefined,
      dedupedCount: undefined,
      excludedCount: 1,
      authorityAsOf: undefined,
      warnings: expect.arrayContaining([expect.stringContaining('exact transaction-to-source-row mappings')])
    })]);
  });

  it('persists class-scoped authority only for an explicit source snapshot as-of', async () => {
    const transaction = savedTransaction('options-1', 'options');
    const rows = buildCsvImportEvidenceGeneration({
      sourceIdentityId: 'hash-2', parserId: 'binance_options', parsedBeforeDedup: 2, savedAfterDedup: 2,
      savedTransactions: [transaction],
      evidence: {
        declaredHistory: { completeHistory: true },
        finalBalanceSnapshots: [{ asOf: 50, accountClass: 'options', balances: { USDT: 75 } }],
        coveredAccountClasses: ['options'],
        requiredOutcomes: [{
          id: 'options', accountClass: 'options', required: true, status: 'complete', parsedCount: 2,
          parsedTransactionRows: [{ transactionId: transaction.id, sourceRowCount: 2 }]
        }],
        recognizedCount: 2, parsedCount: 2, excludedCount: 0, skippedCount: 0, failedCount: 0,
        exclusionReasons: [], skippedReasons: [], failureReasons: []
      },
      completedAt: 100, generation: 3
    });

    expect(rows.snapshots).toEqual([
      expect.objectContaining({
        authorityKind: 'csv', authorityClass: 'journal_final_balance',
        accountClass: 'options', coveredAccountClasses: ['options'], asOf: 50,
        capturedAt: 100, status: 'complete'
      })
    ]);
    expect(rows.assets).toEqual([expect.objectContaining({ asset: 'USDT', assetKey: 'asset:USDT', quantity: 75 })]);
    expect(rows.coverage).toEqual([expect.objectContaining({
      status: 'complete', authorityAsOf: 50
    })]);
  });

  it('treats deduplicated rows as accounted work rather than partial coverage', () => {
    const survivors = [
      savedTransaction('survivor-1', 'spot'),
      savedTransaction('survivor-2', 'spot'),
      savedTransaction('survivor-3', 'spot')
    ];
    const rows = buildCsvImportEvidenceGeneration({
      sourceIdentityId: 'hash-dedup', parserId: 'binance', parsedBeforeDedup: 5, savedAfterDedup: 3,
      savedTransactions: survivors,
      evidence: {
        declaredHistory: { completeHistory: true },
        coveredAccountClasses: ['spot'],
        requiredOutcomes: [{
          id: 'history', accountClass: 'spot', required: true, status: 'complete',
          recognizedCount: 6, parsedCount: 5, excludedCount: 1, skippedCount: 0, failedCount: 0,
          exclusionReasons: [{ reason: 'Principal-only row.', count: 1 }],
          parsedTransactionRows: [
            ...survivors.map((transaction) => ({ transactionId: transaction.id, sourceRowCount: 1 })),
            { transactionId: 'deduped-1', sourceRowCount: 1 },
            { transactionId: 'deduped-2', sourceRowCount: 1 }
          ]
        }],
        recognizedCount: 6, parsedCount: 5, excludedCount: 1, skippedCount: 0, failedCount: 0,
        exclusionReasons: [{ reason: 'Principal-only row.', count: 1 }],
        skippedReasons: [], failureReasons: []
      },
      completedAt: 100, generation: 1
    });

    expect(rows.coverage[0]).toMatchObject({
      status: 'complete', recognizedCount: 6, parsedCount: 3, dedupedCount: 2,
      excludedCount: 1, exclusionReasons: ['Principal-only row.']
    });
  });

  it('builds one exact coverage row per stitched account class using consumed source rows', () => {
    const parsed = stitchBinanceTransactionHistory([
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Funding', Operation: 'Transaction Buy', Coin: 'BTC', Change: '0.1' },
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Funding', Operation: 'Transaction Spend', Coin: 'USDT', Change: '-5000' },
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Funding', Operation: 'Transaction Fee', Coin: 'BTC', Change: '-0.001' },
      { UTC_Time: '2025-01-01 00:01:00', Account: 'Margin', Operation: 'Transaction Buy', Coin: 'ETH', Change: '2' },
      { UTC_Time: '2025-01-01 00:01:00', Account: 'Margin', Operation: 'Transaction Spend', Coin: 'USDT', Change: '-4000' },
      { UTC_Time: '2025-01-01 00:01:00', Account: 'Margin', Operation: 'Transaction Fee', Coin: 'ETH', Change: '-0.002' }
    ]);
    const rows = buildCsvImportEvidenceGeneration({
      sourceIdentityId: 'multi', parserId: 'binance', parsedBeforeDedup: 2,
      savedAfterDedup: 2, savedTransactions: parsed.transactions,
      evidence: { ...parsed.evidence, declaredHistory: { completeHistory: true } },
      completedAt: 100, generation: 1
    });

    expect(rows.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scopeId: 'file:multi:funding', accountClasses: ['funding'],
        recognizedCount: 3, parsedCount: 3, dedupedCount: 0, status: 'complete'
      }),
      expect.objectContaining({
        scopeId: 'file:multi:margin', accountClasses: ['margin'],
        recognizedCount: 3, parsedCount: 3, dedupedCount: 0, status: 'complete'
      })
    ]));
    expect(new Set(rows.coverage.map((row) => row.evidenceId)).size).toBe(2);
  });

  it('rejects two same-class final snapshots before persistence', () => {
    expect(() => buildCsvImportEvidenceGeneration({
      sourceIdentityId: 'duplicate-sheets', parserId: 'binance', parsedBeforeDedup: 0,
      savedAfterDedup: 0, savedTransactions: [], completedAt: 100, generation: 1,
      evidence: {
        declaredHistory: { completeHistory: true }, coveredAccountClasses: ['spot'],
        finalBalanceSnapshots: [
          { accountClass: 'spot', balances: { BTC: 1 } },
          { accountClass: 'spot', balances: { ETH: 2 } }
        ],
        requiredOutcomes: [], recognizedCount: 0, parsedCount: 0, excludedCount: 0,
        skippedCount: 0, failedCount: 0, exclusionReasons: [], skippedReasons: [], failureReasons: []
      }
    })).toThrow('multiple final balance snapshots for one account class');
  });

  it('does not claim complete coverage or authority for a snapshot-only class without an outcome', () => {
    const rows = buildCsvImportEvidenceGeneration({
      sourceIdentityId: 'snapshot-only', parserId: 'binance', parsedBeforeDedup: 0,
      savedAfterDedup: 0, savedTransactions: [], completedAt: 100, generation: 1,
      evidence: {
        declaredHistory: { completeHistory: true }, coveredAccountClasses: ['unknown'],
        finalBalanceSnapshots: [{ accountClass: 'unknown', balances: { BTC: 1 } }],
        requiredOutcomes: [], recognizedCount: 0, parsedCount: 0, excludedCount: 0,
        skippedCount: 0, failedCount: 0, exclusionReasons: [], skippedReasons: [], failureReasons: []
      }
    });

    expect(rows.snapshots[0].status).toBe('partial');
    expect(rows.coverage[0]).toMatchObject({ status: 'partial', endpointOutcomes: [] });
    expect(() => assertValidSourceCoverageRow(rows.coverage[0])).not.toThrow();
  });
});

function savedTransaction(id: string, parserAccountClass: Transaction['parserAccountClass']): Transaction {
  return {
    id, timestamp: 1, type: 'transfer_in', asset: 'BTC', amount: 1, fiatCurrency: 'USD',
    source: 'binance', parserAccountClass, flags: [], isInternalTransfer: false
  };
}
