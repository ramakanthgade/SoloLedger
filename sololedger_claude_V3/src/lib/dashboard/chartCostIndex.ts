import { resolveSolanaMintAddress } from '@/lib/assets/solanaMints';
import { canonicalWalletSourceRefKey } from '@/lib/ledger/chainNamespace';
import { isDcaEscrowDeposit, isDcaFillTrade, buildPortfolioDcaContext } from '@/lib/portfolio/portfolioHoldings';
import { collapseSolTxRows, isNativeSolAsset, isSolRentRefund } from '@/lib/portfolio/solBalance';
import { transactionSourceKey } from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';

interface CostHolding { amount: number; cost: number }
export interface CostSample { t: number; cost: number }

const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';
const INTERNAL_OUT_TYPES = new Set<Transaction['type']>(['transfer_out', 'sell', 'gift_sent']);
const INCOMING_TYPES = new Set<Transaction['type']>(['buy', 'transfer_in', 'income', 'gift_received']);
const OUTGOING_TYPES = new Set<Transaction['type']>(['sell', 'transfer_out', 'gift_sent', 'fee']);

function mayBeNativeSolAsset(asset?: string | null): boolean {
  if (!asset) return false;
  const first = asset[0];
  return first === 'S' || first === 's' || first === 'W' || first === 'w' ||
    asset === WRAPPED_SOL_MINT || asset !== asset.trim()
      ? isNativeSolAsset(asset)
      : false;
}

function key(asset: string, chain?: string, contract?: string): string {
  const mint = contract ?? (chain === 'solana' ? resolveSolanaMintAddress(asset) : undefined);
  return mint ? `${chain ?? 'x'}:mint:${mint.toLowerCase()}` : `${chain ?? 'x'}:${asset.toUpperCase()}`;
}

/**
 * Samples the display portfolio's average-cost overlay in one chronological
 * pass. This is deliberately a custody/display index: no postings enter the
 * tax engine and no tax lots or disposals are created here.
 */
export function buildCustodyCostSamples(
  transactions: readonly Transaction[],
  sampleTimes: readonly number[]
): CostSample[] {
  if (sampleTimes.length === 0) return [];
  const compare = (left: Transaction, right: Transaction) => {
    const time = left.timestamp - right.timestamp;
    if (time) return time;
    const rank = (transaction: Transaction) => transaction.type === 'trade' ? 0 : transaction.type === 'fee' ? 2 : 1;
    return rank(left) - rank(right);
  };
  let filtered: Transaction[] | undefined;
  let previousVisible: Transaction | undefined;
  let alreadyOrdered = true;
  let mayContainDca = false;
  let mayContainSourceRefs = false;
  let mayContainSol = false;
  for (let index = 0; index < transactions.length; index++) {
    const transaction = transactions[index];
    if (transaction.isSpam) {
      if (!filtered) filtered = transactions.slice(0, index) as Transaction[];
      continue;
    }
    if (filtered) filtered.push(transaction);
    if (previousVisible && compare(previousVisible, transaction) > 0) alreadyOrdered = false;
    previousVisible = transaction;
    if (!mayContainDca && (
      transaction.notes?.toLowerCase().includes('dca') ||
      (transaction.source.startsWith('rpc:') && transaction.counterpartyAddress != null)
    )) mayContainDca = true;
    if (!mayContainSourceRefs && transaction.sourceRef && transaction.walletAddress) {
      mayContainSourceRefs = true;
    }
    if (!mayContainSol && (
      mayBeNativeSolAsset(transaction.asset) || mayBeNativeSolAsset(transaction.counterAsset) ||
      mayBeNativeSolAsset(transaction.feeAsset)
    )) mayContainSol = true;
  }
  const visible: readonly Transaction[] = filtered ?? transactions;
  // DCA detection is intentionally richer than ordinary chart projection.
  // Skip it for ledgers with no possible DCA evidence (the overwhelmingly
  // common path); classified rows and RPC vault candidates still use the exact
  // legacy detector.
  const dca = mayContainDca
    ? buildPortfolioDcaContext(filtered ?? [...transactions])
    : { internalDepositIds: new Set<string>(), dcaFillIds: new Set<string>() };
  const ordered = alreadyOrdered ? visible : [...visible].sort(compare);
  const solOrdered = mayContainSol
    ? collapseSolTxRows([...visible]).sort((left, right) => left.timestamp - right.timestamp)
    : [];
  const holdings = new Map<string, CostHolding>();
  const simpleHoldingKeys = new Map<string, string>();
  const qualifiedHoldingKeys = new Map<string, Map<string, string>>();
  const sourceKeys = new Set<string>();
  const tradeLegs = new Set<string>();
  let total = 0;
  let cursor = 0;
  let solCursor = 0;
  let solAcquisitionCursor = 0;
  let solAmount = 0;
  let solAcquisitionCost = 0;
  const appliedSolKeys = new Set<string>();

  const holdingKey = (asset: string, chain?: string, contract?: string) => {
    if (!chain && !contract) {
      const cached = simpleHoldingKeys.get(asset);
      if (cached) return cached;
      const created = key(asset);
      simpleHoldingKeys.set(asset, created);
      return created;
    }
    let byQualifier = qualifiedHoldingKeys.get(chain ?? 'x');
    if (!byQualifier) {
      byQualifier = new Map();
      qualifiedHoldingKeys.set(chain ?? 'x', byQualifier);
    }
    const cacheKey = contract ? `contract:${contract}` : `asset:${asset}`;
    const cached = byQualifier.get(cacheKey);
    if (cached) return cached;
    const created = key(asset, chain, contract);
    byQualifier.set(cacheKey, created);
    return created;
  };

  if (mayContainSourceRefs) {
    for (const transaction of visible) {
      if (transaction.type !== 'trade' || !transaction.counterAsset || !transaction.sourceRef || !transaction.walletAddress) continue;
      const ref = canonicalWalletSourceRefKey(transaction.chain, transaction.walletAddress, transaction.sourceRef);
      if (!ref) continue;
      tradeLegs.add(`${ref}|${transaction.asset.toUpperCase()}`);
      tradeLegs.add(`${ref}|${transaction.counterAsset.toUpperCase()}`);
    }
  }

  const upsert = (
    transaction: Transaction, asset: string, amount: number, sign: 1 | -1,
    costAdd: number, chain?: string, contract?: string
  ) => {
    const balanceKey = holdingKey(asset, chain, contract);
    const holding = holdings.get(balanceKey) ?? { amount: 0, cost: 0 };
    const before = holding.cost;
    if (transaction.category?.startsWith('options_')) {
      holding.amount += sign * amount;
      holding.cost += sign * costAdd;
    } else if (sign > 0) {
      holding.amount += amount;
      holding.cost += costAdd;
    } else if (holding.amount > 1e-9) {
      const quantity = Math.min(amount, holding.amount);
      holding.cost -= holding.cost * (quantity / holding.amount);
      holding.amount -= quantity;
    }
    holdings.set(balanceKey, holding);
    total += holding.cost - before;
  };

  const apply = (transaction: Transaction) => {
    if (mayContainSol && isNativeSolAsset(transaction.asset) && transaction.type !== 'trade') return;
    const sourceKey = mayContainSourceRefs ? transactionSourceKey(transaction) : null;
    if (sourceKey) {
      if (sourceKeys.has(sourceKey)) return;
      sourceKeys.add(sourceKey);
    }
    const ref = mayContainSourceRefs
      ? canonicalWalletSourceRefKey(transaction.chain, transaction.walletAddress, transaction.sourceRef)
      : null;
    if (ref && ['transfer_in', 'transfer_out', 'income'].includes(transaction.type) &&
        tradeLegs.has(`${ref}|${transaction.asset.toUpperCase()}`)) return;
    if (transaction.isInternalTransfer && INTERNAL_OUT_TYPES.has(transaction.type) &&
        !isDcaEscrowDeposit(transaction, dca.internalDepositIds)) return;

    if (transaction.type === 'trade' && transaction.counterAsset && transaction.counterAmount) {
      if (isDcaFillTrade(transaction, dca.dcaFillIds)) {
        if (!isNativeSolAsset(transaction.counterAsset)) {
          upsert(transaction, transaction.counterAsset, transaction.counterAmount, 1,
            transaction.fiatValue ?? 0, transaction.chain,
            transaction.chain === 'solana' ? resolveSolanaMintAddress(transaction.counterAsset) : undefined);
        }
        return;
      }
      if (!mayContainSol || !isNativeSolAsset(transaction.asset)) {
        upsert(transaction, transaction.asset, transaction.amount, -1, 0, transaction.chain, transaction.contractAddress);
      }
      if (!mayContainSol || !isNativeSolAsset(transaction.counterAsset)) {
        upsert(transaction, transaction.counterAsset, transaction.counterAmount, 1,
          transaction.fiatValue ?? 0, transaction.chain,
          transaction.chain === 'solana' ? resolveSolanaMintAddress(transaction.counterAsset) : undefined);
      }
      if (transaction.feeAmount && (!mayContainSol || !isNativeSolAsset(transaction.feeAsset ?? transaction.asset))) {
        const asset = transaction.feeAsset ?? transaction.asset;
        upsert(transaction, asset, transaction.feeAmount, -1, 0, transaction.chain,
          transaction.chain === 'solana' && transaction.feeAsset ? resolveSolanaMintAddress(asset) : undefined);
      }
      return;
    }

    if ((transaction.type === 'buy' || transaction.type === 'sell') && transaction.counterAsset && transaction.counterAmount) {
      const buy = transaction.type === 'buy';
      if (!mayContainSol || !isNativeSolAsset(transaction.asset)) {
        upsert(transaction, transaction.asset, transaction.amount, buy ? 1 : -1,
          buy ? transaction.fiatValue ?? 0 : 0, transaction.chain, transaction.contractAddress);
      }
      if (!mayContainSol || !isNativeSolAsset(transaction.counterAsset)) {
        upsert(transaction, transaction.counterAsset, transaction.counterAmount, buy ? -1 : 1,
          buy ? 0 : transaction.fiatValue ?? 0, transaction.chain,
          transaction.chain === 'solana' ? resolveSolanaMintAddress(transaction.counterAsset) : undefined);
      }
      if (transaction.feeAmount) {
        const feeAsset = transaction.feeAsset ?? transaction.asset;
        if (!mayContainSol || !isNativeSolAsset(feeAsset)) {
          upsert(transaction, feeAsset, transaction.feeAmount, -1, 0, transaction.chain);
        }
      }
      return;
    }

    const sign = INCOMING_TYPES.has(transaction.type) ? 1
      : OUTGOING_TYPES.has(transaction.type) ? -1 : 0;
    if (!sign) return;
    // Native SOL's legacy display cost is cumulative acquisition fiat while it
    // is held. Model that as the same overlay; representative SOL equivalence
    // tests cover buys, trades and fees.
    const cost = transaction.category?.startsWith('options_')
      ? transaction.fiatValue ?? 0 : sign > 0 ? transaction.fiatValue ?? 0 : 0;
    upsert(transaction, transaction.asset, transaction.amount, sign as 1 | -1,
      cost, transaction.chain, transaction.contractAddress);
    if (transaction.feeAmount && transaction.type !== 'trade') {
      const feeAsset = transaction.feeAsset ?? transaction.asset;
      if (!isNativeSolAsset(feeAsset)) {
        upsert(transaction, feeAsset, transaction.feeAmount, -1, 0, transaction.chain);
      }
    }
  };

  const applySol = (transaction: Transaction) => {
    const touchesSolTrade = transaction.type === 'trade' && (
      (isNativeSolAsset(transaction.asset) && transaction.amount >= 0.001) ||
      (isNativeSolAsset(transaction.counterAsset) && (transaction.counterAmount ?? 0) >= 0.001)
    );
    if (!isNativeSolAsset(transaction.asset) && !touchesSolTrade) return;
    const sourceKey = transactionSourceKey(transaction);
    const dedupKey = sourceKey ? `${sourceKey}|${transaction.type}` : null;
    if (dedupKey) {
      if (appliedSolKeys.has(dedupKey)) return;
      appliedSolKeys.add(dedupKey);
    }
    if (transaction.isInternalTransfer && INTERNAL_OUT_TYPES.has(transaction.type)) return;
    if (transaction.type === 'fee') {
      solAmount += isSolRentRefund(transaction) ? transaction.amount : -transaction.amount;
      return;
    }
    if (transaction.type === 'trade') {
      if (isNativeSolAsset(transaction.asset)) solAmount -= transaction.amount;
      if (isNativeSolAsset(transaction.counterAsset) && (transaction.counterAmount ?? 0) > 0) {
        solAmount += transaction.counterAmount!;
      }
      if (isNativeSolAsset(transaction.feeAsset) && transaction.feeAmount) {
        solAmount -= transaction.feeAmount;
      }
      return;
    }
    if (INCOMING_TYPES.has(transaction.type)) {
      solAmount += transaction.amount;
    } else if (INTERNAL_OUT_TYPES.has(transaction.type)) {
      solAmount -= transaction.amount;
    }
    if (isNativeSolAsset(transaction.feeAsset) && transaction.feeAmount) {
      solAmount -= transaction.feeAmount;
    }
  };

  return sampleTimes.map((sampleTime) => {
    while (cursor < ordered.length && ordered[cursor].timestamp <= sampleTime) apply(ordered[cursor++]);
    while (solCursor < solOrdered.length && solOrdered[solCursor].timestamp <= sampleTime) {
      applySol(solOrdered[solCursor++]);
    }
    while (mayContainSol && solAcquisitionCursor < ordered.length && ordered[solAcquisitionCursor].timestamp <= sampleTime) {
      const transaction = ordered[solAcquisitionCursor++];
      if ((transaction.fiatValue ?? 0) <= 0) continue;
      if ((isNativeSolAsset(transaction.asset) && transaction.type === 'buy') ||
          (transaction.type === 'trade' && isNativeSolAsset(transaction.counterAsset))) {
        solAcquisitionCost += transaction.fiatValue ?? 0;
      }
    }
    return { t: sampleTime, cost: total + (Math.abs(solAmount) > 1e-9 ? solAcquisitionCost : 0) };
  });
}
