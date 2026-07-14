/**
 * Hyperliquid deposits & withdrawals CSV.
 *
 * Columns:
 *   time, action, source, destination, accountValueChange, fee
 *
 * Example:
 *   07/06/2026 - 00:26:56,deposit,arbitrum,trading,1989.8 USDC,0.2 USDC
 *
 * Mapping:
 *   deposit  → transfer_in  USDC (amount = accountValueChange; already net of fee)
 *   withdraw → transfer_out USDC
 *   Fee is recorded in notes only (accountValueChange is the net HL balance change).
 */
import type { Transaction, TxType } from '@/types/transaction';
import {
  makeId,
  exchangeSourceRef,
  type ExchangeParser
} from './types';
import { headerMap, col, colIncludes } from './headerMap';
import { parseHyperliquidTime, parseHyperliquidNumber } from './hyperliquidTrades';

function norms(headers: string[]): string[] {
  return headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

function mapAction(raw: string): TxType | null {
  const a = raw.trim().toLowerCase();
  if (!a) return null;
  if (a.includes('deposit') || a === 'credit') return 'transfer_in';
  if (a.includes('withdraw') || a === 'debit') return 'transfer_out';
  return null;
}

export const hyperliquidDepositsParser: ExchangeParser = {
  id: 'hyperliquid_deposits',
  label: 'Hyperliquid Deposits & Withdrawals',

  detect(headers) {
    const h = norms(headers);
    const hasTime = h.includes('time') || h.some((x) => x.includes('time'));
    const hasAction = h.includes('action');
    const hasChange =
      h.includes('accountvaluechange') || h.some((x) => x.includes('accountvalue'));
    const hasSource = h.includes('source');
    const hasDest = h.includes('destination');
    return hasTime && hasAction && hasChange && (hasSource || hasDest);
  },

  parse(rows) {
    const transactions: Transaction[] = [];
    const warnings: string[] = [];
    let skippedRows = 0;

    if (rows.length === 0) {
      return { transactions, skippedRows: 0, warnings: ['Sheet has no data rows.'] };
    }

    const map = headerMap(Object.keys(rows[0]));
    const timeCol = col(map, 'time', 'timestamp', 'date') ?? colIncludes(map, 'time');
    const actionCol = col(map, 'action', 'type', 'transaction');
    const changeCol =
      col(map, 'accountvaluechange', 'amount', 'value') ??
      colIncludes(map, 'accountvaluechange', 'accountvalue');
    const feeCol = col(map, 'fee');
    const sourceCol = col(map, 'source');
    const destCol = col(map, 'destination');

    if (!timeCol || !actionCol || !changeCol) {
      return {
        transactions: [],
        skippedRows: rows.length,
        warnings: ['Hyperliquid deposit columns not found (need time, action, accountValueChange).']
      };
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const mapped = mapAction(row[actionCol] || '');
      const timestamp = parseHyperliquidTime(row[timeCol]);
      const amount = parseHyperliquidNumber(row[changeCol]);
      const fee = feeCol ? parseHyperliquidNumber(row[feeCol]) : 0;
      const source = sourceCol ? (row[sourceCol] || '').trim() : '';
      const dest = destCol ? (row[destCol] || '').trim() : '';

      if (!mapped || !Number.isFinite(timestamp) || amount === 0) {
        skippedRows++;
        continue;
      }

      // Detect asset from the change cell (default USDC)
      const changeRaw = String(row[changeCol] || '').trim();
      const assetMatch = changeRaw.toUpperCase().match(/([A-Z]{2,10})\s*$/);
      const asset = assetMatch?.[1] ?? 'USDC';

      const notesParts = [
        mapped === 'transfer_in' ? 'HL deposit' : 'HL withdraw',
        source && dest ? `${source} → ${dest}` : source || dest,
        fee > 0 ? `fee ${fee} ${asset}` : ''
      ].filter(Boolean);

      transactions.push({
        id: makeId('hldep'),
        timestamp,
        type: mapped,
        asset,
        amount,
        fiatCurrency: 'USD',
        fiatValue: amount,
        source: 'hyperliquid_deposits',
        sourceRef: exchangeSourceRef('hyperliquid', timestamp, mapped, asset, amount),
        notes: notesParts.join(' · '),
        flags: ['possible_internal_transfer'],
        isInternalTransfer: false,
        category: 'perp_collateral',
        raw: row
      });
    }

    if (skippedRows > 0) {
      warnings.push(`${skippedRows} Hyperliquid deposit/withdrawal row(s) skipped.`);
    }

    return { transactions, skippedRows, warnings };
  }
};
