/**
 * Reconciliation engine (Phase 2) unit tests — grounded in the real-backup
 * patterns from docs/reconciliation-engine-design.md §6:
 *   - UNI / ROSE ledger-implied balances match the exchange to the wei → reconciled
 *   - BTC / USDT diverge (phantoms / un-netted withdrawals) → ledger_over / ledger_under
 *   - no balance rows yet → no_authority
 */
import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import type { ExchangeBalanceRow } from '@/lib/storage/db';
import { derivePostings } from '@/lib/ledger/derivedPostings';
import type { AuthoritySelection } from './authoritySelection';
import {
  compareReconSeverity,
  coverageStatusFromEvidence,
  deriveReconPresentation,
  ledgerImpliedQty,
  reconcileDerivedPostings,
  reconcileSource,
  type ReconSeverity,
  type ReconciliationResult
} from './sourceReconcile';

const CONN = 'conn-binance-1';

function bal(asset: string, amount: number): ExchangeBalanceRow {
  return {
    id: `${CONN}:${asset}`,
    connectionId: CONN,
    exchange: 'binance',
    asset,
    amount,
    asOf: 1700000000000,
    source: 'exchange_api'
  };
}

function makeTxFactory() {
  let seq = 0;
  return (partial: Partial<Transaction> & Pick<Transaction, 'type' | 'asset' | 'amount'>): Transaction => ({
    id: `t${++seq}`,
    timestamp: 1700000000000 + seq,
    fiatCurrency: 'USD',
    source: 'binance',
    flags: [],
    isInternalTransfer: false,
    importBatchId: CONN,
    ...partial
  });
}

const tx = makeTxFactory();

describe('ledgerImpliedQty', () => {
  it('nets buys, sells, transfers, income, fees per asset', () => {
    const qty = ledgerImpliedQty([
      tx({ type: 'buy', asset: 'BTC', amount: 1 }),
      tx({ type: 'buy', asset: 'BTC', amount: 0.5 }),
      tx({ type: 'sell', asset: 'BTC', amount: 0.25 }),
      tx({ type: 'transfer_in', asset: 'ETH', amount: 10 }),
      tx({ type: 'transfer_out', asset: 'ETH', amount: 3 }),
      tx({ type: 'income', asset: 'UNI', amount: 120 })
    ]);
    expect(qty.get('BTC')).toBeCloseTo(1.25);
    expect(qty.get('ETH')).toBeCloseTo(7);
    expect(qty.get('UNI')).toBeCloseTo(120);
  });

  it('trade swaps -asset/+counterAsset', () => {
    const qty = ledgerImpliedQty([
      tx({ type: 'trade', asset: 'ETH', amount: 1, counterAsset: 'BTC', counterAmount: 0.05 })
    ]);
    expect(qty.get('ETH')).toBeCloseTo(-1);
    expect(qty.get('BTC')).toBeCloseTo(0.05);
  });

  it('internal transfers net to zero (excluded)', () => {
    const qty = ledgerImpliedQty([
      tx({ type: 'transfer_out', asset: 'USDT', amount: 5000, isInternalTransfer: true }),
      tx({ type: 'transfer_in', asset: 'USDT', amount: 5000, isInternalTransfer: true })
    ]);
    expect(qty.get('USDT') ?? 0).toBeCloseTo(0);
  });

  it('retains signed custody for a one-sided legacy internal transfer', () => {
    const qty = ledgerImpliedQty([
      tx({ type: 'transfer_out', asset: 'USDT', amount: 5000, isInternalTransfer: true })
    ]);
    expect(qty.get('USDT')).toBe(-5000);
  });

  it('skips reciprocal confirmed pairs only when both legs are in this scope', () => {
    const outgoing = tx({ id: 'out', type: 'transfer_out', asset: 'USDT', amount: 5_000,
      isInternalTransfer: true, linkedTransferId: 'in', internalTransferDecision: 'confirmed' });
    const incoming = tx({ id: 'in', type: 'transfer_in', asset: 'USDT', amount: 5_000,
      isInternalTransfer: true, linkedTransferId: 'out', internalTransferDecision: 'confirmed' });
    expect(ledgerImpliedQty([outgoing, incoming]).get('USDT')).toBeUndefined();
    expect(ledgerImpliedQty([outgoing]).get('USDT')).toBe(-5_000);
    expect(ledgerImpliedQty([incoming]).get('USDT')).toBe(5_000);
  });
});

function selectedAuthority(asOf: number, quantity = 2): AuthoritySelection {
  return {
    authorityStatus: 'current',
    selectedSnapshot: {
      snapshotId: 'snapshot-1', generation: 7, scopeId: `exchange:${CONN}`,
      authorityKind: 'api', authorityClass: 'exchange_balance', accountClass: 'spot',
      coveredAccountClasses: ['spot'], asOf, capturedAt: asOf, sourceIdentityId: CONN,
      endpointProof: {
        authorityKind: 'api', provider: 'binance', operation: 'fetchBalance', parametersClass: 'spot',
        requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true
      }, status: 'complete'
    },
    selectedAssets: [{
      id: 'asset-1', snapshotId: 'snapshot-1', generation: 7, scopeId: `exchange:${CONN}`,
      accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', quantity
    }],
    diagnostics: []
  };
}

function reconResult(partial: Partial<ReconciliationResult> = {}): ReconciliationResult {
  return {
    scopeId: `exchange:${CONN}`, accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
    balanceStatus: 'reconciled', authorityStatus: 'current', coverageStatus: 'complete',
    scopeStatus: 'resolved', postingEvidenceCount: 1, authorityEvidenceCount: 1, ...partial
  };
}

describe('four-axis custody reconciliation', () => {
  it('uses only postings at or before the selected coherent cutoff', () => {
    const postings = derivePostings([
      tx({ id: 'before', timestamp: 99, type: 'transfer_in', asset: 'BTC', amount: 1, source: 'binance_api' }),
      tx({ id: 'equal', timestamp: 100, type: 'transfer_in', asset: 'BTC', amount: 1, source: 'binance_api' }),
      tx({ id: 'after', timestamp: 101, type: 'transfer_in', asset: 'BTC', amount: 20, source: 'binance_api' })
    ], { exchangeConnections: [{ id: CONN, exchange: 'binance' }] });
    const result = reconcileDerivedPostings({
      scopeId: `exchange:${CONN}`, accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
      postings, authority: selectedAuthority(100), coverage: { status: 'complete' }, scopeStatus: 'resolved'
    });
    expect(result).toMatchObject({
      balanceStatus: 'reconciled', authorityStatus: 'current', coverageStatus: 'complete',
      scopeStatus: 'resolved', ledgerQuantity: 2, authorityQuantity: 2, delta: 0,
      selectedSnapshotId: 'snapshot-1', selectedGeneration: 7, postingEvidenceCount: 2
    });
  });

  it('treats the latest applicable opening as an absolute reset before later movements', () => {
    const postings = derivePostings([
      tx({ id: 'historical', timestamp: 100, type: 'transfer_in', asset: 'BTC', amount: 10, source: 'binance_api' }),
      tx({ id: 'after-opening', timestamp: 600, type: 'transfer_in', asset: 'BTC', amount: 1, source: 'binance_api' })
    ], {
      exchangeConnections: [{ id: CONN, exchange: 'binance' }],
      openingBalances: [{
        id: 'opening-1', logicalKey: 'opening-1', scopeId: `exchange:${CONN}`,
        accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 5,
        effectiveAt: 500, provenance: 'user_confirmed', createdAt: 1, updatedAt: 1
      }]
    });
    const result = reconcileDerivedPostings({
      scopeId: `exchange:${CONN}`, accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
      postings, authority: selectedAuthority(700, 6), coverage: { status: 'complete' }, scopeStatus: 'resolved'
    });

    expect(result).toMatchObject({
      balanceStatus: 'reconciled', ledgerQuantity: 6, authorityQuantity: 6, delta: 0,
      postingEvidenceCount: 2
    });
  });

  it('counts only selected reset evidence and movements participating through authority asOf', () => {
    const postings = derivePostings([
      tx({ id: 'pre-opening', timestamp: 100, type: 'transfer_in', asset: 'BTC', amount: 10, source: 'binance_api' }),
      tx({ id: 'included', timestamp: 600, type: 'transfer_in', asset: 'BTC', amount: 1, source: 'binance_api' }),
      tx({ id: 'post-authority', timestamp: 800, type: 'transfer_in', asset: 'BTC', amount: 20, source: 'binance_api' })
    ], {
      exchangeConnections: [{ id: CONN, exchange: 'binance' }],
      openingBalances: [
        {
          id: 'older-opening', logicalKey: 'older-opening', scopeId: `exchange:${CONN}`,
          accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 4,
          effectiveAt: 300, provenance: 'user_confirmed', createdAt: 1, updatedAt: 1
        },
        {
          id: 'selected-opening', logicalKey: 'selected-opening', scopeId: `exchange:${CONN}`,
          accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 5,
          effectiveAt: 500, provenance: 'user_confirmed', createdAt: 1, updatedAt: 1
        }
      ]
    });
    const result = reconcileDerivedPostings({
      scopeId: `exchange:${CONN}`, accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
      postings, authority: selectedAuthority(700, 6), coverage: { status: 'complete' }, scopeStatus: 'resolved'
    });

    expect(result).toMatchObject({ ledgerQuantity: 6, postingEvidenceCount: 2 });
  });

  it('does not produce quantities or delta for missing/non-comparable authority or unresolved scope', () => {
    for (const partial of [
      { authorityStatus: 'missing' as const, selectedSnapshot: undefined },
      { authorityStatus: 'non_comparable' as const, selectedSnapshot: undefined }
    ]) {
      const result = reconcileDerivedPostings({
        scopeId: `exchange:${CONN}`, accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC', postings: [],
        authority: { ...selectedAuthority(100), ...partial, selectedAssets: [] },
        coverage: { status: 'unknown' }, scopeStatus: 'resolved'
      });
      expect(result.balanceStatus).toBe('not_compared');
      expect(result).not.toHaveProperty('delta');
    }
  });

  it('infers an absent asset as zero only from exhaustive balance proof', () => {
    const postings = derivePostings([
      tx({ id: 'btc', timestamp: 100, type: 'transfer_in', asset: 'BTC', amount: 2, source: 'binance_api' })
    ], { exchangeConnections: [{ id: CONN, exchange: 'binance' }] });
    const exhaustive = selectedAuthority(100);
    exhaustive.selectedAssets = [];
    const confirmedZero = reconcileDerivedPostings({
      scopeId: `exchange:${CONN}`, accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
      postings, authority: exhaustive, coverage: { status: 'complete' }, scopeStatus: 'resolved'
    });
    expect(confirmedZero).toMatchObject({
      authorityStatus: 'current', balanceStatus: 'ledger_over', authorityQuantity: 0,
      ledgerQuantity: 2, delta: -2
    });

    const nonExhaustive = selectedAuthority(100);
    nonExhaustive.selectedSnapshot = {
      ...nonExhaustive.selectedSnapshot!,
      endpointProof: { ...nonExhaustive.selectedSnapshot!.endpointProof, exhaustiveBalances: false }
    };
    nonExhaustive.selectedAssets = [{
      id: 'eth-only', snapshotId: 'snapshot-1', generation: 7, scopeId: `exchange:${CONN}`,
      accountClass: 'spot', assetKey: 'asset:ETH', asset: 'ETH', quantity: 3
    }];
    const absentUnknown = reconcileDerivedPostings({
      scopeId: `exchange:${CONN}`, accountClass: 'spot', assetKey: 'asset:BTC', asset: 'BTC',
      postings, authority: nonExhaustive, coverage: { status: 'complete' }, scopeStatus: 'resolved'
    });
    expect(absentUnknown).toMatchObject({
      authorityStatus: 'non_comparable', balanceStatus: 'not_compared'
    });
    expect(absentUnknown).not.toHaveProperty('authorityQuantity');
    expect(absentUnknown).not.toHaveProperty('delta');
  });

  it('requires opening balance only from complete bounded evidence and approved conditions', () => {
    const bounds = { provenHistoryStart: 10, authorityAsOf: 100 };
    for (const status of ['partial', 'unknown', 'failed'] as const) {
      expect(coverageStatusFromEvidence({
        status, ...bounds, firstMovement: { effectiveAt: 10, signedQuantity: -1 }
      })).toBe(status);
    }
    expect(coverageStatusFromEvidence({
      status: 'complete', ...bounds, firstMovement: { effectiveAt: 10, signedQuantity: 1 }
    })).toBe('complete');
    expect(coverageStatusFromEvidence({
      status: 'complete', ...bounds, firstMovement: { effectiveAt: 10, signedQuantity: -1 }
    })).toBe('opening_balance_required');
    expect(coverageStatusFromEvidence({
      status: 'complete', ...bounds, minimumPrefixQuantity: -0.0000001, negativeTolerance: 0.000001
    })).toBe('complete');
    expect(coverageStatusFromEvidence({
      status: 'complete', ...bounds, minimumPrefixQuantity: -0.01, negativeTolerance: 0.000001
    })).toBe('opening_balance_required');
    expect(coverageStatusFromEvidence({
      status: 'complete', ...bounds, declaredOpeningSnapshot: { effectiveAt: 10, quantity: 0 }
    })).toBe('complete');
    expect(coverageStatusFromEvidence({
      status: 'complete', ...bounds, declaredOpeningSnapshot: { effectiveAt: 10, quantity: 5 }
    })).toBe('opening_balance_required');
    expect(coverageStatusFromEvidence({
      status: 'complete', ...bounds, declaredOpeningSnapshot: { effectiveAt: 20, quantity: 5 },
      earliestExplainingAcquisitionAt: 20
    })).toBe('complete');
    expect(coverageStatusFromEvidence({
      status: 'complete', ...bounds, declaredOpeningSnapshot: { effectiveAt: 20, quantity: 5 },
      earliestExplainingAcquisitionAt: 19
    })).toBe('complete');
    expect(coverageStatusFromEvidence({
      status: 'complete', ...bounds, declaredOpeningSnapshot: { effectiveAt: 20, quantity: 5 },
      earliestExplainingAcquisitionAt: 21
    })).toBe('opening_balance_required');
    expect(coverageStatusFromEvidence({
      status: 'complete', ...bounds, firstMovement: { effectiveAt: 10, signedQuantity: -1 },
      hasEvidenceBackedOpeningBalance: true
    })).toBe('complete');
  });

  it.each([
    [{ authorityStatus: 'stale', balanceStatus: 'ledger_under' }, 'inspect_evidence_history', 'warning'],
    [{ coverageStatus: 'partial', balanceStatus: 'reconciled' }, 'complete_source_history', 'warning'],
    [{ authorityStatus: 'missing', coverageStatus: 'unknown', balanceStatus: 'not_compared' }, 'add_timestamped_authority', 'warning'],
    [{ authorityStatus: 'non_comparable', coverageStatus: 'complete', balanceStatus: 'not_compared' }, 'capture_coherent_authority', 'blocked'],
    [{ scopeStatus: 'source_deleted', authorityStatus: 'stale', balanceStatus: 'not_compared' }, 'reconnect_source', 'blocked'],
    [{ coverageStatus: 'failed', balanceStatus: 'ledger_over' }, 'retry_source_operation', 'error'],
    [{ coverageStatus: 'opening_balance_required', authorityStatus: 'missing', balanceStatus: 'not_compared' }, 'add_timestamped_authority', 'warning']
  ] as const)('applies deterministic status precedence for %o', (partial, remediation, severity) => {
    expect(deriveReconPresentation(reconResult(partial))).toMatchObject({
      primaryRemediation: remediation, severity
    });
  });

  it('orders every severity explicitly and breaks same-severity findings deterministically', () => {
    expect((['clean', 'info', 'warning', 'error', 'blocked'] as ReconSeverity[])
      .sort(compareReconSeverity)).toEqual([
      'blocked', 'error', 'warning', 'info', 'clean'
    ]);
    expect(deriveReconPresentation(reconResult({
      authorityStatus: 'missing', coverageStatus: 'failed', balanceStatus: 'not_compared'
    }))).toEqual({
      severity: 'error',
      primaryRemediation: 'retry_source_operation',
      secondaryRemediations: ['add_timestamped_authority']
    });
  });
});

describe('reconcileSource', () => {
  it('keeps a one-sided legacy internal row signed for custody reconciliation', () => {
    const internalOut = tx({
      type: 'transfer_out', asset: 'BTC', amount: 2, isInternalTransfer: true
    });
    expect(reconcileSource(CONN, 'binance', [bal('BTC', 0)], [internalOut]).assets[0])
      .toMatchObject({ ledgerQty: -2, authorityQty: 0, delta: 2, status: 'ledger_under' });
  });
  it('marks exact matches reconciled (UNI/ROSE case)', () => {
    const balances = [bal('UNI', 120.001444), bal('ROSE', 11454.8)];
    const txs = [
      tx({ type: 'income', asset: 'UNI', amount: 120.001444 }),
      tx({ type: 'transfer_in', asset: 'ROSE', amount: 11454.8 })
    ];
    const r = reconcileSource(CONN, 'binance', balances, txs);
    expect(r.hasAuthority).toBe(true);
    expect(r.reconciledCount).toBe(2);
    expect(r.divergentCount).toBe(0);
    for (const a of r.assets) expect(a.status).toBe('reconciled');
  });

  it('ledger OVER authority → ledger_over (BTC phantom / un-netted withdrawal)', () => {
    // Exchange holds ~0 BTC but ledger implies +9.17 (withdrawal destination not imported).
    const balances = [bal('BTC', 0.0000049)];
    const txs = [tx({ type: 'buy', asset: 'BTC', amount: 9.17 })];
    const r = reconcileSource(CONN, 'binance', balances, txs);
    const btc = r.assets.find((a) => a.asset === 'BTC')!;
    expect(btc.status).toBe('ledger_over');
    expect(btc.delta).toBeCloseTo(0.0000049 - 9.17);
    expect(r.divergentCount).toBe(1);
  });

  it('ledger UNDER authority → ledger_under + unexplained (ETH missing in-side history)', () => {
    // Exchange holds 329 ETH but ledger shows none (buys never discovered).
    const balances = [bal('ETH', 329)];
    const r = reconcileSource(CONN, 'binance', balances, []);
    const eth = r.assets.find((a) => a.asset === 'ETH')!;
    expect(eth.status).toBe('ledger_under');
    expect(eth.delta).toBeCloseTo(329);
    expect(r.unexplainedCount).toBe(1);
  });

  it('dust within epsilon → reconciled (USDT $0.00000046 dust)', () => {
    const balances = [bal('USDT', 0.00000046)];
    const r = reconcileSource(CONN, 'binance', balances, []);
    expect(r.assets.find((a) => a.asset === 'USDT')!.status).toBe('reconciled');
  });

  it('no balance rows → no_authority for all ledger assets', () => {
    const txs = [tx({ type: 'buy', asset: 'BTC', amount: 1 })];
    const r = reconcileSource(CONN, 'binance', [], txs);
    expect(r.hasAuthority).toBe(false);
    expect(r.assets.find((a) => a.asset === 'BTC')!.status).toBe('no_authority');
  });

  it('sorts assets by |delta| descending (biggest gap first)', () => {
    const balances = [bal('BTC', 0), bal('ETH', 0), bal('UNI', 120)];
    const txs = [
      tx({ type: 'buy', asset: 'BTC', amount: 9 }),
      tx({ type: 'buy', asset: 'ETH', amount: 2 }),
      tx({ type: 'income', asset: 'UNI', amount: 120 })
    ];
    const r = reconcileSource(CONN, 'binance', balances, txs);
    expect(Math.abs(r.assets[0].delta)).toBeGreaterThanOrEqual(Math.abs(r.assets[1].delta));
    expect(r.assets[0].asset).toBe('BTC'); // biggest gap first
  });
});
