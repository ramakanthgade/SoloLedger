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
import { ledgerImpliedQty, reconcileSource } from './sourceReconcile';

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

let seq = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, 'type' | 'asset' | 'amount'>): Transaction {
  return {
    id: `t${++seq}`,
    timestamp: 1700000000000 + seq,
    fiatCurrency: 'USD',
    source: 'binance',
    flags: [],
    isInternalTransfer: false,
    importBatchId: CONN,
    ...partial
  };
}

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
});

describe('reconcileSource', () => {
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
