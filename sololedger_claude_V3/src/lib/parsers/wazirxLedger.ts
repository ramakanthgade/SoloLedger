/**
 * Income/Expense ledger sheets (WazirX "Spot Account Ledger" and similar).
 *
 * Columns: Date, Asset, Income, Expense, Fee Amount, Balance, Reason, Remarks
 *
 * Trade rows are multi-leg at the same timestamp:
 *   TRADE SUB  = asset spent/sold
 *   TRADE PLUS = asset received
 *   TRADE TDS* = tax withheld (absorbed into fee notes; not a separate disposal)
 *
 * PortfolioReBalance groups → crypto↔crypto trades into the PLUS asset.
 * FeeTokenDeduction → fee; Withdraw → transfer_out; *Distribution/Reward → income.
 */
import type { Transaction, FlagReason } from '@/types/transaction';
import {
  makeId,
  safeQuantity,
  safeTimestampIst,
  exchangeSourceRef,
  type ExchangeParser,
  type ParseResult
} from './types';
import { headerMap, col, colIncludes } from './headerMap';
import { quoteToFiatCurrency } from './pairUtils';

interface LedgerLeg {
  asset: string;
  income: number;
  expense: number;
  feeAmount: number;
  reason: string;
  remarks: string;
  raw: Record<string, string>;
}

function norms(headers: string[]): string[] {
  return headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function isFiat(asset: string): boolean {
  return Boolean(quoteToFiatCurrency(asset) && ['INR', 'USD', 'EUR', 'GBP', 'AUD'].includes(asset));
}

function isStable(asset: string): boolean {
  return ['USDT', 'USDC', 'BUSD', 'TUSD', 'DAI', 'FDUSD'].includes(asset);
}

export const wazirxLedgerParser: ExchangeParser = {
  id: 'wazirx_ledger',
  label: 'Spot Account Ledger',

  detect(headers) {
    const h = norms(headers);
    const hasDate = h.some((x) => x.includes('date'));
    const hasAsset = h.includes('asset') || h.includes('coin');
    const hasIncome = h.includes('income');
    const hasExpense = h.includes('expense');
    const hasReason = h.includes('reason') || h.includes('remarks');
    return hasDate && hasAsset && hasIncome && hasExpense && hasReason;
  },

  parse(rows) {
    return stitchIncomeExpenseLedger(rows);
  }
};

export function stitchIncomeExpenseLedger(rows: Record<string, string>[]): ParseResult {
  const transactions: Transaction[] = [];
  const warnings: string[] = [];
  let skippedRows = 0;

  if (rows.length === 0) {
    return { transactions, skippedRows: 0, warnings: ['Sheet has no data rows.'] };
  }

  const map = headerMap(Object.keys(rows[0]));
  const timeCol = col(map, 'date', 'datetime', 'timestamp', 'time') ?? colIncludes(map, 'date');
  const assetCol = col(map, 'asset', 'coin', 'currency');
  const incomeCol = col(map, 'income', 'credit', 'in');
  const expenseCol = col(map, 'expense', 'debit', 'out');
  const feeCol = col(map, 'feeamount', 'fee');
  const reasonCol = col(map, 'reason', 'operation', 'type');
  const remarksCol = col(map, 'remarks', 'notes', 'description', 'comment');

  if (!timeCol || !assetCol || !incomeCol || !expenseCol) {
    return {
      transactions: [],
      skippedRows: rows.length,
      warnings: ['Ledger columns not found (need Date, Asset, Income, Expense).']
    };
  }

  // Group by timestamp
  const groups = new Map<number, LedgerLeg[]>();
  for (const row of rows) {
    const timestamp = safeTimestampIst(row[timeCol]);
    const asset = (row[assetCol] || '').trim().toUpperCase();
    if (!asset || !Number.isFinite(timestamp)) {
      skippedRows++;
      continue;
    }
    const leg: LedgerLeg = {
      asset,
      income: safeQuantity(row[incomeCol]),
      expense: safeQuantity(row[expenseCol]),
      feeAmount: feeCol ? safeQuantity(row[feeCol]) : 0,
      reason: reasonCol ? (row[reasonCol] || '').trim() : '',
      remarks: remarksCol ? (row[remarksCol] || '').trim() : '',
      raw: row
    };
    if (leg.income === 0 && leg.expense === 0 && leg.feeAmount === 0) {
      skippedRows++;
      continue;
    }
    const list = groups.get(timestamp) ?? [];
    list.push(leg);
    groups.set(timestamp, list);
  }

  for (const [timestamp, legs] of groups) {
    const reasonLower = (legs[0]?.reason || '').toLowerCase();
    const allTrade = legs.every((l) => l.reason.toLowerCase() === 'trade');
    const allRebalance = legs.every((l) =>
      l.reason.toLowerCase().includes('rebalance')
    );
    const allFee = legs.every(
      (l) =>
        l.reason.toLowerCase().includes('fee') ||
        l.remarks.toUpperCase().includes('FEE')
    );

    if (allTrade || (reasonLower === 'trade' && legs.some((l) => l.reason.toLowerCase() === 'trade'))) {
      const tradeLegs = legs.filter((l) => l.reason.toLowerCase() === 'trade');
      const otherLegs = legs.filter((l) => l.reason.toLowerCase() !== 'trade');
      stitchTradeGroup(timestamp, tradeLegs, transactions);
      for (const leg of otherLegs) {
        emitSimpleLeg(timestamp, leg, transactions);
      }
      continue;
    }

    if (allRebalance) {
      stitchRebalanceGroup(timestamp, legs, transactions);
      continue;
    }

    if (allFee || legs.every((l) => l.reason.toLowerCase().includes('feetoken'))) {
      for (const leg of legs) {
        emitFeeLeg(timestamp, leg, transactions);
      }
      continue;
    }

    // Mixed / simple rows — emit individually
    for (const leg of legs) {
      emitSimpleLeg(timestamp, leg, transactions);
    }
  }

  if (skippedRows > 0) {
    warnings.push(`${skippedRows} ledger row(s) skipped (empty or invalid).`);
  }

  return { transactions, skippedRows, warnings };
}

function remarkKind(remarks: string): 'plus' | 'sub' | 'tds' | 'other' {
  const r = remarks.toUpperCase();
  if (r.includes('TDS')) return 'tds';
  if (r.includes('PLUS')) return 'plus';
  if (r.includes('SUB')) return 'sub';
  return 'other';
}

function stitchTradeGroup(
  timestamp: number,
  legs: LedgerLeg[],
  out: Transaction[]
): void {
  const plus = legs.filter((l) => remarkKind(l.remarks) === 'plus' && l.income > 0);
  const sub = legs.filter((l) => remarkKind(l.remarks) === 'sub' && l.expense > 0);
  const tds = legs.filter((l) => remarkKind(l.remarks) === 'tds');

  if (plus.length === 0 || sub.length === 0) {
    // Fallback: treat income as received, expense as spent
    const received = legs.filter((l) => l.income > 0);
    const spent = legs.filter((l) => l.expense > 0 && remarkKind(l.remarks) !== 'tds');
    if (received.length === 0 || spent.length === 0) {
      for (const leg of legs) emitSimpleLeg(timestamp, leg, out);
      return;
    }
    emitTradeFromLegs(timestamp, spent, received, tds, out);
    return;
  }

  emitTradeFromLegs(timestamp, sub, plus, tds, out);
}

function emitTradeFromLegs(
  timestamp: number,
  spent: LedgerLeg[],
  received: LedgerLeg[],
  tds: LedgerLeg[],
  out: Transaction[]
): void {
  // Pair primary spent ↔ primary received (largest amounts)
  const primarySpent = [...spent].sort((a, b) => b.expense - a.expense)[0];
  const primaryReceived = [...received].sort((a, b) => b.income - a.income)[0];
  if (!primarySpent || !primaryReceived) return;

  const tdsNote =
    tds.length > 0
      ? tds.map((t) => `TDS ${t.expense || t.income} ${t.asset}`).join(', ')
      : '';

  const spentIsFiat = isFiat(primarySpent.asset);
  const recvIsFiat = isFiat(primaryReceived.asset);
  const spentIsStable = isStable(primarySpent.asset);
  const recvIsStable = isStable(primaryReceived.asset);

  let type: Transaction['type'] = 'trade';
  let asset = primaryReceived.asset;
  let amount = primaryReceived.income;
  let counterAsset = primarySpent.asset;
  let counterAmount = primarySpent.expense;
  let fiatCurrency = 'INR';
  let fiatValue: number | undefined;
  let flags: FlagReason[] = [];

  if (spentIsFiat && !recvIsFiat) {
    // Bought crypto with fiat
    type = 'buy';
    asset = primaryReceived.asset;
    amount = primaryReceived.income;
    counterAsset = primarySpent.asset;
    counterAmount = primarySpent.expense;
    fiatCurrency = primarySpent.asset;
    fiatValue = primarySpent.expense;
  } else if (recvIsFiat && !spentIsFiat) {
    // Sold crypto for fiat
    type = 'sell';
    asset = primarySpent.asset;
    amount = primarySpent.expense;
    counterAsset = primaryReceived.asset;
    counterAmount = primaryReceived.income;
    fiatCurrency = primaryReceived.asset;
    fiatValue = primaryReceived.income;
  } else if (spentIsStable && !recvIsStable && !recvIsFiat) {
    type = 'buy';
    asset = primaryReceived.asset;
    amount = primaryReceived.income;
    counterAsset = primarySpent.asset;
    counterAmount = primarySpent.expense;
    fiatCurrency = quoteToFiatCurrency(primarySpent.asset) ?? 'USD';
    fiatValue = primarySpent.expense;
    flags = [];
  } else if (recvIsStable && !spentIsStable && !spentIsFiat) {
    type = 'sell';
    asset = primarySpent.asset;
    amount = primarySpent.expense;
    counterAsset = primaryReceived.asset;
    counterAmount = primaryReceived.income;
    fiatCurrency = quoteToFiatCurrency(primaryReceived.asset) ?? 'USD';
    fiatValue = primaryReceived.income;
  } else {
    type = 'trade';
    asset = primaryReceived.asset;
    amount = primaryReceived.income;
    counterAsset = primarySpent.asset;
    counterAmount = primarySpent.expense;
    flags = ['missing_cost_basis'];
  }

  // Extra spent/received legs beyond the primary pair → additional trades
  out.push({
    id: makeId('wxled'),
    timestamp,
    type,
    asset,
    amount,
    counterAsset,
    counterAmount,
    fiatCurrency,
    fiatValue,
    source: 'wazirx_ledger',
    sourceRef: exchangeSourceRef('wazirx', timestamp, type, asset, amount),
    notes: [primarySpent.remarks, primaryReceived.remarks, tdsNote].filter(Boolean).join(' · ') || undefined,
    flags,
    isInternalTransfer: false,
    raw: { spent: primarySpent.raw, received: primaryReceived.raw, tds: tds.map((t) => t.raw) }
  });

  // Remaining spent legs paired against same received (rare) — emit as separate disposals
  for (const extra of spent.slice(1)) {
    if (extra.expense <= 0) continue;
    out.push({
      id: makeId('wxled'),
      timestamp,
      type: isFiat(extra.asset) ? 'other' : 'sell',
      asset: extra.asset,
      amount: extra.expense,
      fiatCurrency: isFiat(extra.asset) ? extra.asset : 'INR',
      fiatValue: isFiat(extra.asset) ? extra.expense : undefined,
      source: 'wazirx_ledger',
      sourceRef: exchangeSourceRef('wazirx', timestamp, 'sell', extra.asset, extra.expense),
      notes: extra.remarks || 'Extra trade leg',
      flags: isFiat(extra.asset) ? [] : ['missing_cost_basis'],
      isInternalTransfer: false,
      raw: extra.raw
    });
  }
}

function stitchRebalanceGroup(
  timestamp: number,
  legs: LedgerLeg[],
  out: Transaction[]
): void {
  const plus = legs.filter((l) => l.income > 0);
  const sub = legs.filter((l) => l.expense > 0);
  if (plus.length === 0 || sub.length === 0) {
    for (const leg of legs) emitSimpleLeg(timestamp, leg, out);
    return;
  }
  const primaryPlus = [...plus].sort((a, b) => b.income - a.income)[0];
  const totalSub = sub.reduce((a, b) => a + b.expense, 0);
  if (totalSub <= 0) {
    for (const leg of legs) emitSimpleLeg(timestamp, leg, out);
    return;
  }
  for (const s of sub) {
    if (s.expense <= 0) continue;
    const share = (s.expense / totalSub) * primaryPlus.income;
    out.push({
      id: makeId('wxled'),
      timestamp,
      type: 'trade',
      asset: primaryPlus.asset,
      amount: share,
      counterAsset: s.asset,
      counterAmount: s.expense,
      fiatCurrency: quoteToFiatCurrency(primaryPlus.asset) ?? 'USD',
      source: 'wazirx_ledger',
      sourceRef: exchangeSourceRef('wazirx', timestamp, 'trade', s.asset, s.expense),
      notes: `Portfolio rebalance → ${primaryPlus.asset}`,
      flags: ['missing_cost_basis'],
      isInternalTransfer: false,
      category: 'rebalance',
      raw: { from: s.raw, to: primaryPlus.raw }
    });
  }
}

function emitFeeLeg(timestamp: number, leg: LedgerLeg, out: Transaction[]): void {
  const amount = leg.expense || leg.feeAmount || leg.income;
  if (amount <= 0) return;
  out.push({
    id: makeId('wxled'),
    timestamp,
    type: 'fee',
    asset: leg.asset,
    amount,
    feeAmount: amount,
    feeAsset: leg.asset,
    fiatCurrency: quoteToFiatCurrency(leg.asset) ?? (isFiat(leg.asset) ? leg.asset : 'INR'),
    fiatValue: isFiat(leg.asset) ? amount : undefined,
    source: 'wazirx_ledger',
    sourceRef: exchangeSourceRef('wazirx', timestamp, 'fee', leg.asset, amount),
    notes: leg.remarks || leg.reason,
    flags: [],
    isInternalTransfer: false,
    raw: leg.raw
  });
}

function emitSimpleLeg(timestamp: number, leg: LedgerLeg, out: Transaction[]): void {
  const reason = leg.reason.toLowerCase();
  const remarks = leg.remarks.toUpperCase();

  if (reason.includes('fee') || remarks.includes('FEE CHARGE')) {
    emitFeeLeg(timestamp, leg, out);
    return;
  }

  if (reason.includes('withdraw')) {
    const amount = leg.expense || leg.income;
    if (amount <= 0) return;
    out.push({
      id: makeId('wxled'),
      timestamp,
      type: 'transfer_out',
      asset: leg.asset,
      amount,
      feeAmount: leg.feeAmount > 0 ? leg.feeAmount : undefined,
      feeAsset: leg.feeAmount > 0 ? leg.asset : undefined,
      fiatCurrency: isFiat(leg.asset) ? leg.asset : 'INR',
      fiatValue: isFiat(leg.asset) ? amount : undefined,
      source: 'wazirx_ledger',
      sourceRef: exchangeSourceRef('wazirx', timestamp, 'transfer_out', leg.asset, amount),
      notes: leg.remarks || leg.reason,
      flags: ['possible_internal_transfer'],
      isInternalTransfer: false,
      raw: leg.raw
    });
    return;
  }

  if (reason.includes('deposit')) {
    const amount = leg.income || leg.expense;
    if (amount <= 0) return;
    out.push({
      id: makeId('wxled'),
      timestamp,
      type: 'transfer_in',
      asset: leg.asset,
      amount,
      fiatCurrency: isFiat(leg.asset) ? leg.asset : 'INR',
      fiatValue: isFiat(leg.asset) ? amount : undefined,
      source: 'wazirx_ledger',
      sourceRef: exchangeSourceRef('wazirx', timestamp, 'transfer_in', leg.asset, amount),
      notes: leg.remarks || leg.reason,
      flags: ['possible_internal_transfer'],
      isInternalTransfer: false,
      raw: leg.raw
    });
    return;
  }

  if (
    reason.includes('distribution') ||
    reason.includes('reward') ||
    reason.includes('airdrop') ||
    reason.includes('referral') ||
    remarks.includes('TOKEN ADD')
  ) {
    const amount = leg.income || leg.expense;
    if (amount <= 0) return;
    out.push({
      id: makeId('wxled'),
      timestamp,
      type: 'income',
      asset: leg.asset,
      amount,
      fiatCurrency: quoteToFiatCurrency(leg.asset) ?? 'INR',
      source: 'wazirx_ledger',
      sourceRef: exchangeSourceRef('wazirx', timestamp, 'income', leg.asset, amount),
      notes: leg.remarks || leg.reason,
      flags: ['missing_cost_basis'],
      isInternalTransfer: false,
      raw: leg.raw
    });
    return;
  }

  // Generic: income → transfer_in / income; expense → transfer_out
  if (leg.income > 0) {
    out.push({
      id: makeId('wxled'),
      timestamp,
      type: 'transfer_in',
      asset: leg.asset,
      amount: leg.income,
      fiatCurrency: isFiat(leg.asset) ? leg.asset : 'INR',
      fiatValue: isFiat(leg.asset) ? leg.income : undefined,
      source: 'wazirx_ledger',
      sourceRef: exchangeSourceRef('wazirx', timestamp, 'transfer_in', leg.asset, leg.income),
      notes: `${leg.reason} ${leg.remarks}`.trim(),
      flags: ['possible_internal_transfer'],
      isInternalTransfer: false,
      raw: leg.raw
    });
  }
  if (leg.expense > 0) {
    out.push({
      id: makeId('wxled'),
      timestamp,
      type: 'transfer_out',
      asset: leg.asset,
      amount: leg.expense,
      feeAmount: leg.feeAmount > 0 ? leg.feeAmount : undefined,
      fiatCurrency: isFiat(leg.asset) ? leg.asset : 'INR',
      fiatValue: isFiat(leg.asset) ? leg.expense : undefined,
      source: 'wazirx_ledger',
      sourceRef: exchangeSourceRef('wazirx', timestamp, 'transfer_out', leg.asset, leg.expense),
      notes: `${leg.reason} ${leg.remarks}`.trim(),
      flags: ['possible_internal_transfer'],
      isInternalTransfer: false,
      raw: leg.raw
    });
  }
}
