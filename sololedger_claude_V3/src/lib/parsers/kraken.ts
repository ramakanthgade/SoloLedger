/**
 * kraken.ts
 * =========
 * Kraken Ledger CSV export parser.
 *
 * Kraken's most comprehensive export is "Ledger History" (Settings → Export → Ledger).
 * It contains ALL transaction types: trades, deposits, withdrawals, staking rewards,
 * transfers, and spot conversions — everything in one file.
 *
 * Export path: Kraken → Settings → Export → Ledger → Generate
 *
 * Expected CSV headers (as of 2026):
 * txid, refid, time, type, subtype, asset, amount, fee, balance
 *
 * The "type" column values:
 * deposit → transfer_in
 * withdrawal → transfer_out
 * trade → buy/sell (paired by refid)
 * staking → income
 * receive → transfer_in (internal deposit)
 * spend → transfer_out (internal withdrawal)
 * transfer → transfer_in/transfer_out (determined by amount sign)
 *
 * Trades appear as TWO rows sharing the same refid:
 * Row 1: type=trade, asset=XBT, amount=-0.1 (leg sold)
 * Row 2: type=trade, asset=USD, amount=+5000 (leg received)
 * Stitch them together like binanceStitch does.
 */

import type { Transaction, TxType } from '@/types/transaction';
import { makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

const TYPE_MAP: Record<string, TxType> = {
  deposit: 'transfer_in',
  withdrawal: 'transfer_out',
  staking: 'income',
  receive: 'transfer_in',
  spend: 'transfer_out',
  transfer: 'transfer_out', // direction determined by amount sign below
  trade: 'trade', // special handling — stitched by refid
};

/** Kraken asset codes that need mapping. Kraken uses old-style codes. */
const KRAKEN_ASSET_MAP: Record<string, string> = {
  XBT: 'BTC',
  XETH: 'ETH',
  XXBT: 'BTC',
  XRP: 'XRP',
  XLTC: 'LTC',
  XDG: 'DOGE',
  XTZ: 'XTZ',
  XLM: 'XLM',
  ZUSD: 'USD',
  ZEUR: 'EUR',
  ZCAD: 'CAD',
  ZGBP: 'GBP',
  ZJPY: 'JPY',
  ZAUD: 'AUD',
  USDT: 'USDT',
  USDC: 'USDC',
  DAI: 'DAI',
  KFEE: 'KFEE',
  SOL: 'SOL',
  DOT: 'DOT',
  ADA: 'ADA',
  MATIC: 'MATIC',
};

function normalizeAsset(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return KRAKEN_ASSET_MAP[upper] ?? upper;
}

function col(row: Record<string, string>, ...keys: string[]): string {
  const lower = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), v])
  );
  for (const k of keys) {
    const hit = lower[k.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (hit != null && hit !== '') return hit;
  }
  return '';
}

function parseTimestamp(value: string): number {
  const numeric = Number(value);
  if (value.trim() && Number.isFinite(numeric)) {
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  return safeTimestamp(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Trade stitching
// ─────────────────────────────────────────────────────────────────────────────

interface TradeLeg {
  refid: string;
  timestamp: number;
  asset: string;
  amount: number;
  fee: number;
}

/** Group trade rows by refid and stitch into buy/sell with counterAsset. */
function stitchTrades(legs: TradeLeg[]): Transaction[] {
  const byRefid = new Map<string, TradeLeg[]>();
  for (const leg of legs) {
    const group = byRefid.get(leg.refid) ?? [];
    group.push(leg);
    byRefid.set(leg.refid, group);
  }

  const txs: Transaction[] = [];
  for (const [, group] of byRefid) {
    if (group.length < 2) {
      // Single-leg trade: treat as transfer (unusual but possible with partial fills)
      // Push each leg as transfer_out (negative amount) or transfer_in (positive)
      for (const leg of group) {
        txs.push({
          id: makeId('kr'),
          timestamp: leg.timestamp,
          type: leg.amount < 0 ? 'transfer_out' : 'transfer_in',
          asset: leg.asset,
          amount: Math.abs(leg.amount),
          fiatCurrency: 'USD',
          source: 'kraken',
          sourceRef: leg.refid,
          feeAmount: Math.abs(leg.fee),
          feeAsset: leg.asset === 'USD' || leg.asset === 'EUR' ? leg.asset : undefined,
          flags: [],
          isInternalTransfer: false,
        });
      }
      continue;
    }

    // Sort by amount: negative = sent (what you gave), positive = received (what you got)
    const sent = group.find((l) => l.amount < 0);
    const received = group.find((l) => l.amount > 0);

    if (!sent && !received) continue; // shouldn't happen

    const base = group[0];
    const fiatAssets = new Set(['USD', 'EUR', 'CAD', 'GBP', 'JPY', 'AUD']);
    // Receiving fiat means the crypto leg was sold; spending fiat means the
    // received crypto was bought. For crypto-to-crypto trades, model the
    // received leg as the acquired asset.
    const isBuy = sent != null && (fiatAssets.has(sent.asset) || !fiatAssets.has(received?.asset ?? ''));

    txs.push({
      id: makeId('kr'),
      timestamp: base.timestamp,
      type: isBuy ? 'buy' : 'sell',
      asset: isBuy ? received!.asset : sent!.asset,
      amount: isBuy ? Math.abs(received!.amount) : Math.abs(sent!.amount),
      counterAsset: isBuy ? sent!.asset : received!.asset,
      counterAmount: isBuy ? Math.abs(sent!.amount) : Math.abs(received!.amount),
      fiatCurrency: 'USD',
      fiatValue: isBuy
        ? Math.abs(sent!.amount) // fiat spent = counter amount
        : Math.abs(received!.amount), // fiat received = counter amount
      source: 'kraken',
      sourceRef: base.refid,
      feeAmount: Math.abs(group.reduce((s, l) => s + l.fee, 0)),
      feeAsset: group.find((l) => l.fee > 0)?.asset,
      flags: [],
      isInternalTransfer: false,
    });
  }

  return txs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

export const krakenParser: ExchangeParser = {
  id: 'kraken',
  label: 'Kraken',

  detect(headers) {
    const h = headers.map((x) => x.toLowerCase());
    // Kraken ledger has: txid, refid, time, type, subtype, asset, amount, fee, balance
    return h.includes('refid') && h.includes('txid') && h.includes('asset') && h.includes('balance');
  },

  parse(rows) {
    const transactions: Transaction[] = [];
    const warnings: string[] = [];
    let skippedRows = 0;
    const tradeLegs: TradeLeg[] = [];

    for (const row of rows) {
      const rawType = col(row, 'type').trim().toLowerCase();
      const rawAsset = col(row, 'asset', 'currency');
      const amountStr = col(row, 'amount');
      const feeStr = col(row, 'fee');
      const tsStr = col(row, 'time', 'timestamp', 'date');
      const refid = col(row, 'refid');

      const timestamp = parseTimestamp(tsStr);
      const amount = safeNumber(amountStr);
      const fee = safeNumber(feeStr);

      if (!rawType || !rawAsset || !Number.isFinite(timestamp) || amount === 0) {
        skippedRows += 1;
        continue;
      }

      const asset = normalizeAsset(rawAsset);
      const mapped = TYPE_MAP[rawType];
      const isIncoming = amount > 0;

      if (!mapped) {
        // Unknown type — skip silently
        skippedRows += 1;
        continue;
      }

      // Handle trades separately
      if (mapped === 'trade') {
        tradeLegs.push({ refid, timestamp, asset, amount, fee });
        continue;
      }

      // Handle transfers — direction from amount sign
      const typeForTransfer = rawType === 'transfer'
        ? (isIncoming ? 'transfer_in' : 'transfer_out')
        : mapped;

      transactions.push({
        id: makeId('kr'),
        timestamp,
        type: typeForTransfer,
        asset,
        amount: Math.abs(amount),
        fiatCurrency: 'USD',
        fiatValue: undefined,
        source: 'kraken',
        sourceRef: refid || col(row, 'txid') || undefined,
        feeAmount: fee !== 0 ? Math.abs(fee) : undefined,
        feeAsset: fee !== 0 ? asset : undefined,
        notes: col(row, 'subtype') || undefined,
        flags: typeForTransfer === 'transfer_in' || typeForTransfer === 'transfer_out'
          ? ['possible_internal_transfer']
          : [],
        isInternalTransfer: false,
        raw: row,
      });
    }

    // Stitch trade legs
    const tradeTxs = stitchTrades(tradeLegs);
    transactions.push(...tradeTxs);

    if (skippedRows > 0) {
      warnings.push(`${skippedRows} row(s) skipped — unrecognized type or missing data.`);
    }

    return { transactions, skippedRows, warnings };
  },
};

export default krakenParser;
