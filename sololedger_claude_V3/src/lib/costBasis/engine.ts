import type { Transaction, Lot, Disposal, TxType, FlagReason } from '@/types/transaction';
import type { CostBasisStrategy } from './strategy';
import { fifoStrategy } from './fifo';
import { lifoStrategy } from './lifo';
import { hifoStrategy } from './hifo';
import { specIdStrategy } from './specId';
import { makeId } from '@/lib/parsers/types';
import { isDerivativeTransaction } from '@/lib/tax/derivatives';
import { D, add, sub, mul, div, toNumber, isPositive, isDust } from './decimal';

export type CostBasisMethod = 'FIFO' | 'LIFO' | 'HIFO' | 'SpecID';

export const STRATEGIES: Record<CostBasisMethod, CostBasisStrategy> = {
  FIFO: fifoStrategy,
  LIFO: lifoStrategy,
  HIFO: hifoStrategy,
  SpecID: specIdStrategy
};

const ACQUISITION_TYPES: TxType[] = ['buy', 'income', 'gift_received', 'nft_mint', 'nft_buy'];
const DISPOSAL_TYPES: TxType[] = ['sell', 'gift_sent', 'nft_sell'];

/**
 * How trading/network fees affect cost basis. Jurisdiction-aware: the engine
 * only ever applies the policy it is handed — it does not decide the policy.
 * - `add_to_basis`: a fee denominated in the reporting fiat currency is added
 *    to an acquisition's cost basis (US/CA-style).
 * - `exclude`: fees never touch cost basis (India — VDA allows only cost of
 *    acquisition, no incidental expenses). This is the default for IN.
 */
export type FeePolicy = 'add_to_basis' | 'exclude';

/**
 * A `trade` (asset-for-asset swap) is really two legs: a disposal of `asset`
 * and an acquisition of `counterAsset`. We split it into two synthetic
 * transactions up front so the rest of the engine only ever deals with
 * single-asset acquisitions/disposals. Both legs share the same fiat value —
 * the fair market value of the swap at execution — and are tagged back to
 * the original transaction id for traceability.
 *
 * When the acquisition leg cannot be opened because the swap has no usable
 * `counterAmount` (missing or zero), we surface it as a shortfall/flag on the
 * counter asset instead of silently dropping value.
 */
interface ExpandResult {
  transactions: Transaction[];
  droppedTradeLegs: { transactionId: string; asset: string; reason: FlagReason }[];
}

function expandTrades(transactions: Transaction[]): ExpandResult {
  const expanded: Transaction[] = [];
  const droppedTradeLegs: ExpandResult['droppedTradeLegs'] = [];

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
    if (tx.counterAsset && tx.counterAmount && isPositive(Math.abs(tx.counterAmount))) {
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
    } else if (tx.counterAsset) {
      // The user swapped into `counterAsset` but we have no (or zero) amount for
      // that leg — we can't open a lot, so record it on the counter asset so a
      // later disposal of that asset isn't silently unmatched.
      droppedTradeLegs.push({
        transactionId: tx.id,
        asset: tx.counterAsset,
        reason: 'missing_cost_basis'
      });
    }
  }

  return { transactions: expanded, droppedTradeLegs };
}

export interface EngineOptions {
  method: CostBasisMethod;
  /** For SpecID: user's chosen lot order per disposal transaction id. */
  specIdHints?: Record<string, string[]>;
  /**
   * Jurisdiction-aware fee handling. The caller decides this from the active
   * jurisdiction; the engine just applies it. Defaults to `exclude` (India).
   */
  feePolicy?: FeePolicy;
}

export interface DisposalCandidateLot {
  lotId: string;
  acquiredAt: number;
  amountAvailable: number;
  costBasisPerUnit: number;
}

/** An acquisition/leg the engine could not turn into a lot, surfaced for review. */
export interface EngineFlag {
  transactionId: string;
  asset: string;
  reason: FlagReason;
}

export interface EngineResult {
  lots: Lot[];
  disposals: Disposal[];
  /** Disposals that couldn't be fully matched to cost basis (insufficient lots). */
  shortfalls: { transactionId: string; asset: string; unmatchedAmount: number }[];
  /**
   * Acquisitions rejected for invalid data (non-finite fiat value, non-positive
   * amount) and trade acquisition legs dropped for a missing/zero counter
   * amount — flagged instead of creating a zero/negative lot.
   */
  flags: EngineFlag[];
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
 * Fee added to an acquisition's cost basis under the given policy. Only a fee
 * denominated in the reporting fiat currency can be valued without a price
 * lookup, so any crypto-denominated fee is left out (the engine never guesses
 * an FX rate). Returns 0 under the `exclude` policy.
 */
function feeForBasis(tx: Transaction, feePolicy: FeePolicy) {
  if (feePolicy !== 'add_to_basis') return D(0);
  if (tx.feeAmount == null || !Number.isFinite(tx.feeAmount)) return D(0);
  if (!tx.feeAsset || tx.feeAsset.toUpperCase() !== tx.fiatCurrency.toUpperCase()) return D(0);
  return D(Math.abs(tx.feeAmount));
}

/**
 * Ranks two transactions sharing the same timestamp so ordering is fully
 * deterministic: acquisitions are processed before disposals (so a same-second
 * buy is available to a same-second sell), then ties break by id.
 */
function sameTimestampRank(tx: Transaction): number {
  return ACQUISITION_TYPES.includes(tx.type) ? 0 : 1;
}

/**
 * Walks a chronologically-sorted transaction list per asset, opening a Lot
 * for every acquisition and matching every disposal against open lots using
 * the chosen strategy. Pure function — no I/O, fully testable, and cheap
 * enough to re-run on every edit for datasets in the tens of thousands of
 * rows (single pass per asset, O(n log n) for the sort).
 */
export function calculateCostBasis(rawTransactions: Transaction[], options: EngineOptions): EngineResult {
  const { transactions, droppedTradeLegs } = expandTrades(rawTransactions);
  const strategy = STRATEGIES[options.method];
  const feePolicy: FeePolicy = options.feePolicy ?? 'exclude';
  const lots: Lot[] = [];
  const disposals: Disposal[] = [];
  const shortfalls: EngineResult['shortfalls'] = [];
  const flags: EngineFlag[] = [...droppedTradeLegs];
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
    const sorted = [...assetTxs].sort(
      (a, b) =>
        a.timestamp - b.timestamp ||
        sameTimestampRank(a) - sameTimestampRank(b) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    const openLots: Lot[] = [];

    for (const tx of sorted) {
      if (ACQUISITION_TYPES.includes(tx.type)) {
        // Derivative PnL credited as `income` is cash-settled business/CG income —
        // not a spot USDC lot acquisition (would pollute FIFO for real USDC buys).
        if (tx.type === 'income' && isDerivativeTransaction(tx)) {
          continue;
        }

        // Validate the acquisition: a lot needs a positive quantity and a finite
        // fiat cost basis. Reject anything else with a flag rather than opening a
        // zero/negative lot that would silently distort later disposals.
        const rawFiat = tx.fiatValue ?? 0;
        if (!Number.isFinite(tx.amount) || !isPositive(tx.amount) || !Number.isFinite(rawFiat)) {
          flags.push({ transactionId: originalTxId(tx.id), asset, reason: 'missing_cost_basis' });
          continue;
        }

        const costBasisTotal = add(Math.abs(rawFiat), feeForBasis(tx, feePolicy));
        const amount = D(tx.amount);
        const lot: Lot = {
          id: makeId('lot'),
          asset,
          acquiredAt: tx.timestamp,
          amountRemaining: toNumber(amount),
          amountOriginal: toNumber(amount),
          costBasisPerUnit: toNumber(div(costBasisTotal, amount)),
          costBasisTotal: toNumber(costBasisTotal),
          sourceTxId: originalTxId(tx.id),
          acquisitionType: tx.type as Lot['acquisitionType']
        };
        openLots.push(lot);
        lots.push(lot);
      }

      if (DISPOSAL_TYPES.includes(tx.type)) {
        const origId = originalTxId(tx.id);

        disposalCandidates[origId] = openLots
          .filter((l) => isPositive(l.amountRemaining))
          .sort((a, b) => a.acquiredAt - b.acquiredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((l) => ({
            lotId: l.id,
            acquiredAt: l.acquiredAt,
            amountAvailable: l.amountRemaining,
            costBasisPerUnit: l.costBasisPerUnit
          }));

        const selections = strategy.selectLots(openLots, tx.amount, {
          preferredLotIds: options.specIdHints?.[origId]
        });

        const matchedAmount = selections.reduce((s, sel) => add(s, sel.amount), D(0));
        const unmatched = sub(tx.amount, matchedAmount);
        if (isPositive(unmatched)) {
          shortfalls.push({ transactionId: origId, asset, unmatchedAmount: toNumber(unmatched) });
        }

        let costBasis = D(0);
        const lotConsumption = selections.map((sel) => {
          const lot = openLots.find((l) => l.id === sel.lotId)!;
          const consumedCost = mul(lot.costBasisPerUnit, sel.amount);
          // Clamp the remaining quantity at 0 — it must never go negative, and a
          // dust residual left by float noise collapses to exactly 0.
          const remainingAfter = sub(lot.amountRemaining, sel.amount);
          lot.amountRemaining = isDust(remainingAfter) ? 0 : Math.max(0, toNumber(remainingAfter));
          costBasis = add(costBasis, consumedCost);
          return { lotId: lot.id, amount: sel.amount, costBasis: toNumber(consumedCost) };
        });

        const proceeds = Math.abs(tx.fiatValue ?? 0);
        const earliestLotDate = lotConsumption.length
          ? Math.min(...lotConsumption.map((lc) => openLots.find((l) => l.id === lc.lotId)!.acquiredAt))
          : tx.timestamp;
        const holdingPeriodDays = Math.max(0, Math.round((tx.timestamp - earliestLotDate) / 86_400_000));

        const costBasisNum = toNumber(costBasis);
        disposals.push({
          id: makeId('disp'),
          asset,
          disposedAt: tx.timestamp,
          amount: tx.amount,
          proceeds,
          costBasis: costBasisNum,
          gain: toNumber(sub(proceeds, costBasis)),
          holdingPeriodDays,
          lotConsumption,
          sourceTxId: origId,
          method: options.method
        });
      }
    }
  }

  return { lots, disposals, shortfalls, flags, disposalCandidates };
}
