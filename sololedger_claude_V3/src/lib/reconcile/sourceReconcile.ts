import type { Transaction } from '@/types/transaction';
import type { ExchangeBalanceRow } from '@/lib/storage/db';

/**
 * RECONCILIATION ENGINE (Phase 2) — pure, testable, no ccxt/db runtime imports.
 *
 * For each exchange connection, per asset, compares:
 *   - authorityQty: what the exchange SAYS you hold (ExchangeBalanceRow.amount
 *     from fetchBalance — the truth anchor persisted in Phase 1), and
 *   - ledgerQty: what the imported transaction ledger IMPLIES for THIS
 *     connection's rows only (importBatchId === connectionId).
 *
 * The GAP between them is the completeness diagnostic the user demanded:
 *   - ledger UNDER authority → in-side history missing (buys never discovered,
 *     deposits not imported)
 *   - ledger OVER authority → ledger records holdings the source no longer has
 *     (un-netted withdrawals to not-yet-imported wallets, deposit-address phantoms)
 *
 * Ledger sign convention mirrors buildPortfolioHoldings:
 *   + buy, transfer_in, income, gift_received
 *   - sell, transfer_out, gift_sent, fee
 *   trade: -asset/+counterAsset; internal transfers net to zero (skipped).
 */

export type ReconStatus = 'reconciled' | 'ledger_under' | 'ledger_over' | 'no_authority';

export interface SourceAssetRecon {
  asset: string;
  /** What the source's authority says (exchange balance). */
  authorityQty: number;
  /** What the ledger implies for THIS source's rows only. */
  ledgerQty: number;
  /** authorityQty − ledgerQty. 0 ⇒ fully reconciled. */
  delta: number;
  status: ReconStatus;
}

export interface SourceReconResult {
  connectionId: string;
  exchange: string;
  assets: SourceAssetRecon[]; // sorted by |delta| desc
  reconciledCount: number;
  divergentCount: number;
  /** assets with authority balance the ledger can't explain (missing history). */
  unexplainedCount: number;
  /** true when the connection has no balance rows yet (first sync pre-v10). */
  hasAuthority: boolean;
}

/** Per-asset dust threshold so $0.00000046 dust doesn't page anyone. */
function epsilon(authorityQty: number): number {
  // Absolute dust floor: anything under ~1e-6 of an asset is negligible
  // (sub-cent for any realistic price). Plus a relative term so large balances
  // tolerate proportionally tiny reconstruction error.
  return Math.max(1e-6, Math.abs(authorityQty) * 1e-6);
}

/**
 * Ledger-implied net quantity per asset for a set of transactions (already
 * filtered to one connection). Mirrors buildPortfolioHoldings sign rules,
 * simplified: skips internal transfers (net zero) and spam.
 */
export function ledgerImpliedQty(txs: Transaction[]): Map<string, number> {
  const map = new Map<string, number>();
  const add = (asset: string | undefined, delta: number) => {
    if (!asset) return;
    const a = asset.toUpperCase();
    map.set(a, (map.get(a) ?? 0) + delta);
  };

  for (const t of txs) {
    if (t.isSpam) continue;
    // Internal transfers net to zero across own wallets — exclude both legs.
    if (t.isInternalTransfer) continue;

    if (t.type === 'trade' && t.counterAsset && t.counterAmount != null) {
      add(t.asset, -Math.abs(t.amount));
      add(t.counterAsset, Math.abs(t.counterAmount));
    } else if (t.type === 'buy') {
      add(t.asset, Math.abs(t.amount));
      if (t.counterAsset && t.counterAmount != null) add(t.counterAsset, -Math.abs(t.counterAmount));
    } else if (t.type === 'sell') {
      add(t.asset, -Math.abs(t.amount));
      if (t.counterAsset && t.counterAmount != null) add(t.counterAsset, Math.abs(t.counterAmount));
    } else if (t.type === 'transfer_in' || t.type === 'income' || t.type === 'gift_received') {
      add(t.asset, Math.abs(t.amount));
    } else if (t.type === 'transfer_out' || t.type === 'gift_sent' || t.type === 'fee') {
      add(t.asset, -Math.abs(t.amount));
    }
    // Explicit fee leg (fee charged in a separate asset).
    if (t.feeAmount && t.feeAmount > 0) add(t.feeAsset ?? t.asset, -Math.abs(t.feeAmount));
  }
  return map;
}

/**
 * Reconcile one connection: authority balances vs ledger-implied quantities.
 * `balanceRows` = the connection's ExchangeBalanceRow set (may be empty).
 * `connectionTxs` = transactions with importBatchId === connectionId.
 */
export function reconcileSource(
  connectionId: string,
  exchange: string,
  balanceRows: ExchangeBalanceRow[],
  connectionTxs: Transaction[]
): SourceReconResult {
  const hasAuthority = balanceRows.length > 0;
  const authority = new Map<string, number>();
  for (const b of balanceRows) authority.set(b.asset.toUpperCase(), b.amount);

  const ledger = ledgerImpliedQty(connectionTxs);

  const assets = new Set<string>([...authority.keys(), ...ledger.keys()]);
  const recons: SourceAssetRecon[] = [];
  let reconciledCount = 0;
  let divergentCount = 0;
  let unexplainedCount = 0;

  for (const asset of assets) {
    const authorityQty = authority.get(asset) ?? 0;
    const ledgerQty = ledger.get(asset) ?? 0;
    const delta = authorityQty - ledgerQty;

    let status: ReconStatus;
    if (!hasAuthority) {
      status = 'no_authority';
    } else if (Math.abs(delta) <= epsilon(authorityQty)) {
      status = 'reconciled';
    } else if (authorityQty > ledgerQty) {
      status = 'ledger_under'; // ledger missing in-side history
    } else {
      status = 'ledger_over'; // ledger records holdings source no longer has
    }

    if (status === 'reconciled') reconciledCount++;
    else if (status === 'ledger_under' || status === 'ledger_over') {
      divergentCount++;
      if (authorityQty > 0 && status === 'ledger_under') unexplainedCount++;
    }

    recons.push({ asset, authorityQty, ledgerQty, delta, status });
  }

  // Sort by |delta| desc so the biggest gaps surface first.
  recons.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  return {
    connectionId,
    exchange,
    assets: recons,
    reconciledCount,
    divergentCount,
    unexplainedCount,
    hasAuthority
  };
}
