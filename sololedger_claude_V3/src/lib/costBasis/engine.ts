import type { Transaction, Lot, Disposal, TxType } from '@/types/transaction';
import type { CostBasisStrategy } from './strategy';
import { fifoStrategy } from './fifo';
import { specIdStrategy } from './specId';
import { makeId } from '@/lib/parsers/types';
import { isDerivativeTransaction } from '@/lib/tax/derivatives';

export const STRATEGIES: Record<'FIFO' | 'SpecID', CostBasisStrategy> = {
  FIFO: fifoStrategy,
  SpecID: specIdStrategy
};

const ACQUISITION_TYPES: TxType[] = ['buy', 'income', 'gift_received', 'nft_mint'];
const DISPOSAL_TYPES: TxType[] = ['sell', 'gift_sent', 'nft_sell'];

/**
 * A `trade` (asset-for-asset swap) is really two legs: a disposal of `asset`
 * and an acquisition of `counterAsset`. We split it into two synthetic
 * transactions up front so the rest of the engine only ever deals with
 * single-asset acquisitions/disposals. Both legs share the same fiat value —
 * the fair market value of the swap at execution — and are tagged back to
 * the original transaction id for traceability.
 */
function expandTrades(transactions: Transaction[]): Transaction[] {
  const expanded: Transaction[] = [];
  for (const tx of transactions) {
    if (tx.type !== 'trade') {
      expanded.push(tx);
      continue;
    }
    const fmv = Math.abs(tx.fiatValue ?? 0);
    expanded.push({
      ...tx,
      id: `${tx.id}__disposal`,
      type: 'sell',
      sourceRef: tx.sourceRef ?? tx.id,
      raw: undefined
    });
    if (tx.counterAsset && tx.counterAmount) {
      expanded.push({
        ...tx,
        id: `${tx.id}__acquisition`,
        type: 'buy',
        asset: tx.counterAsset,
        amount: tx.counterAmount,
        fiatValue: fmv,
        counterAsset: tx.asset,
        counterAmount: tx.amount,
        sourceRef: tx.sourceRef ?? tx.id,
        raw: undefined
      });
    }
  }
  return expanded;
}

export interface EngineOptions {
  method: 'FIFO' | 'SpecID';
  /** For SpecID: user's chosen lot order per disposal transaction id. */
  specIdHints?: Record<string, string[]>;
}

export interface DisposalCandidateLot {
  lotId: string;
  acquiredAt: number;
  amountAvailable: number;
  costBasisPerUnit: number;
}

export interface EngineResult {
  lots: Lot[];
  disposals: Disposal[];
  /** Disposals that couldn't be fully matched to cost basis (insufficient lots). */
  shortfalls: { transactionId: string; asset: string; unmatchedAmount: number }[];
  /**
   * For every disposal, the pool of open lots available at that moment,
   * captured before the strategy consumes them. Used by the Specific ID
   * lot-picker UI regardless of which method actually ran — so a user can
   * preview "what lots could I choose" even while looking at a FIFO result.
   * Keyed by the original (pre-trade-expansion) transaction id.
   */
  disposalCandidates: Record<string, DisposalCandidateLot[]>;
}

function originalTxId(id: string): string {
  return id.replace(/__disposal$|__acquisition$/, '');
}

/**
 * Walks a chronologically-sorted transaction list per asset, opening a Lot
 * for every acquisition and matching every disposal against open lots using
 * the chosen strategy. Pure function — no I/O, fully testable, and cheap
 * enough to re-run on every edit for datasets in the tens of thousands of
 * rows (single pass per asset, O(n log n) for the sort).
 */
export function calculateCostBasis(rawTransactions: Transaction[], options: EngineOptions): EngineResult {
  const transactions = expandTrades(rawTransactions);
  const strategy = STRATEGIES[options.method];
  const lots: Lot[] = [];
  const disposals: Disposal[] = [];
  const shortfalls: EngineResult['shortfalls'] = [];
  const disposalCandidates: EngineResult['disposalCandidates'] = {};

  const byAsset = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    if (tx.isInternalTransfer || tx.isSpam || tx.type === 'transfer_in' || tx.type === 'transfer_out' || tx.type === 'fee') {
      continue; // non-taxable or excluded
    }
    if (!byAsset.has(tx.asset)) byAsset.set(tx.asset, []);
    byAsset.get(tx.asset)!.push(tx);
  }

  for (const [asset, assetTxs] of byAsset) {
    const sorted = [...assetTxs].sort((a, b) => a.timestamp - b.timestamp);
    const openLots: Lot[] = [];

    for (const tx of sorted) {
      if (ACQUISITION_TYPES.includes(tx.type)) {
        // Derivative PnL credited as `income` is cash-settled business/CG income —
        // not a spot USDC lot acquisition (would pollute FIFO for real USDC buys).
        if (tx.type === 'income' && isDerivativeTransaction(tx)) {
          continue;
        }
        const costBasisTotal = Math.abs(tx.fiatValue ?? 0);
        const lot: Lot = {
          id: makeId('lot'),
          asset,
          acquiredAt: tx.timestamp,
          amountRemaining: tx.amount,
          amountOriginal: tx.amount,
          costBasisPerUnit: tx.amount > 0 ? costBasisTotal / tx.amount : 0,
          costBasisTotal,
          sourceTxId: originalTxId(tx.id),
          acquisitionType: tx.type as Lot['acquisitionType']
        };
        openLots.push(lot);
        lots.push(lot);
      }

      if (DISPOSAL_TYPES.includes(tx.type)) {
        const origId = originalTxId(tx.id);

        disposalCandidates[origId] = openLots
          .filter((l) => l.amountRemaining > 1e-12)
          .sort((a, b) => a.acquiredAt - b.acquiredAt)
          .map((l) => ({
            lotId: l.id,
            acquiredAt: l.acquiredAt,
            amountAvailable: l.amountRemaining,
            costBasisPerUnit: l.costBasisPerUnit
          }));

        const selections = strategy.selectLots(openLots, tx.amount, {
          preferredLotIds: options.specIdHints?.[origId]
        });

        const matchedAmount = selections.reduce((s, sel) => s + sel.amount, 0);
        if (matchedAmount < tx.amount - 1e-9) {
          shortfalls.push({ transactionId: origId, asset, unmatchedAmount: tx.amount - matchedAmount });
        }

        let costBasis = 0;
        const lotConsumption = selections.map((sel) => {
          const lot = openLots.find((l) => l.id === sel.lotId)!;
          const consumedCost = lot.costBasisPerUnit * sel.amount;
          lot.amountRemaining -= sel.amount;
          costBasis += consumedCost;
          return { lotId: lot.id, amount: sel.amount, costBasis: consumedCost };
        });

        const proceeds = Math.abs(tx.fiatValue ?? 0);
        const earliestLotDate = lotConsumption.length
          ? Math.min(...lotConsumption.map((lc) => openLots.find((l) => l.id === lc.lotId)!.acquiredAt))
          : tx.timestamp;
        const holdingPeriodDays = Math.max(0, Math.round((tx.timestamp - earliestLotDate) / 86_400_000));

        disposals.push({
          id: makeId('disp'),
          asset,
          disposedAt: tx.timestamp,
          amount: tx.amount,
          proceeds,
          costBasis,
          gain: proceeds - costBasis,
          holdingPeriodDays,
          lotConsumption,
          sourceTxId: origId,
          method: options.method
        });
      }
    }
  }

  return { lots, disposals, shortfalls, disposalCandidates };
}
