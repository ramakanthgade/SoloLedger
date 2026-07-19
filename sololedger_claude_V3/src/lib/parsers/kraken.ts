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
 *
 * Ledger `time` is documented as UTC ("YYYY-MM-DD HH:mm:ss[.ffff]") — parsed
 * via `safeEpochTimestamp` so bare strings anchor to UTC, not local time.
 */

import type { Transaction, TxType } from '@/types/transaction';
import { makeId, safeEpochTimestamp, safeNumber, type ExchangeParser } from './types';
import { normalizeHeader } from './tableExtract';
import { rowCol } from './headerMap';

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
  XXBT: 'BTC',
  XETH: 'ETH',
  XDG: 'DOGE',
  XLTC: 'LTC',
  ZUSD: 'USD',
  ZEUR: 'EUR',
  ZCAD: 'CAD',
  ZGBP: 'GBP',
  ZJPY: 'JPY',
  ZAUD: 'AUD',
};

/** Fiat legs that give a stitched trade a real fiat value/currency. */
const FIAT_ASSETS = new Set(['USD', 'EUR', 'CAD', 'GBP', 'JPY', 'AUD']);

function normalizeAsset(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return KRAKEN_ASSET_MAP[upper] ?? upper;
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
  /** Original CSV row, carried so stitched/fallback transactions keep provenance. */
  raw: Record<string, string>;
}

/** Sum same-sign legs (multi-fill groups sharing a refid) into one leg. */
function aggregateLegs(legs: TradeLeg[]): TradeLeg | undefined {
  if (legs.length === 0) return undefined;
  const first = legs[0];
  return {
    ...first,
    amount: legs.reduce((s, l) => s + l.amount, 0),
    fee: legs.reduce((s, l) => s + l.fee, 0),
  };
}

/** Group trade rows by refid and stitch into buy/sell/trade with counterAsset. */
function stitchTrades(legs: TradeLeg[]): { transactions: Transaction[]; skippedRows: number; warnings: string[] } {
  const byRefid = new Map<string, TradeLeg[]>();
  for (const leg of legs) {
    const group = byRefid.get(leg.refid) ?? [];
    group.push(leg);
    byRefid.set(leg.refid, group);
  }

  const txs: Transaction[] = [];
  const warnings: string[] = [];
  let skippedRows = 0;

  for (const [refid, group] of byRefid) {
    // Single-leg trade: treat as transfer (unusual but possible with partial fills)
    if (group.length < 2) {
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
          feeAsset: FIAT_ASSETS.has(leg.asset) ? leg.asset : undefined,
          flags: [],
          isInternalTransfer: false,
          raw: leg.raw,
        });
      }
      continue;
    }

    // Aggregate ALL legs per sign (multi-fill groups can have >2 legs per
    // refid): negative = sent (what you gave), positive = received.
    const sent = aggregateLegs(group.filter((l) => l.amount < 0));
    const received = aggregateLegs(group.filter((l) => l.amount > 0));

    // Malformed group whose legs all move the same direction (broken export):
    // skip it with a warning instead of crashing the whole import.
    if (!sent || !received) {
      skippedRows += group.length;
      warnings.push(
        `Skipped ${group.length} trade leg(s) for refid ${refid} — legs all move in the same direction and cannot be stitched.`
      );
      continue;
    }

    const sentIsFiat = FIAT_ASSETS.has(sent.asset);
    const receivedIsFiat = FIAT_ASSETS.has(received.asset);

    // Fees: sum only when every fee leg is in the same asset — summing
    // mixed-asset fees under one feeAsset would mislabel them.
    const feeByAsset = new Map<string, number>();
    for (const leg of group) {
      if (leg.fee !== 0) feeByAsset.set(leg.asset, (feeByAsset.get(leg.asset) ?? 0) + leg.fee);
    }
    const feeEntries = [...feeByAsset.entries()];
    const feeAmount = feeEntries.length === 1 ? Math.abs(feeEntries[0][1]) : undefined;
    const feeAsset = feeEntries.length === 1 ? feeEntries[0][0] : undefined;

    // Fiat value comes only from a leg that is actually fiat. Crypto-to-crypto
    // trades leave fiatValue undefined (the pricing layer backfills FMV — it
    // only backfills when fiatValue == null) and emit 'trade'; buy/sell are
    // reserved for fiat-vs-crypto.
    let type: TxType;
    let asset: string;
    let amount: number;
    let counterAsset: string;
    let counterAmount: number;
    let fiatCurrency = 'USD';
    let fiatValue: number | undefined;

    if (receivedIsFiat && !sentIsFiat) {
      // Receiving fiat means the crypto leg was sold.
      type = 'sell';
      asset = sent.asset;
      amount = Math.abs(sent.amount);
      counterAsset = received.asset;
      counterAmount = Math.abs(received.amount);
      fiatCurrency = received.asset;
      fiatValue = counterAmount; // fiat proceeds
    } else if (sentIsFiat) {
      // Spending fiat means the received asset was bought (covers fiat→fiat too).
      type = 'buy';
      asset = received.asset;
      amount = Math.abs(received.amount);
      counterAsset = sent.asset;
      counterAmount = Math.abs(sent.amount);
      fiatCurrency = sent.asset;
      fiatValue = counterAmount; // fiat spent
    } else {
      // Crypto-to-crypto — no fiat leg, so no fiat value.
      type = 'trade';
      asset = received.asset;
      amount = Math.abs(received.amount);
      counterAsset = sent.asset;
      counterAmount = Math.abs(sent.amount);
    }

    txs.push({
      id: makeId('kr'),
      timestamp: group[0].timestamp,
      type,
      asset,
      amount,
      counterAsset,
      counterAmount,
      fiatCurrency,
      fiatValue,
      source: 'kraken',
      sourceRef: refid,
      feeAmount,
      feeAsset,
      flags: [],
      isInternalTransfer: false,
      // Stitched from multiple ledger rows — keep every leg's raw row for traceability.
      raw: { stitchedLegs: group.map((l) => l.raw) },
    });
  }

  return { transactions: txs, skippedRows, warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

export const krakenParser: ExchangeParser = {
  id: 'kraken',
  label: 'Kraken',

  detect(headers) {
    const h = headers.map(normalizeHeader);
    // Kraken ledger has: txid, refid, time, type, subtype, asset, amount, fee, balance
    return h.includes('refid') && h.includes('txid') && h.includes('asset') && h.includes('balance');
  },

  parse(rows) {
    const transactions: Transaction[] = [];
    const warnings: string[] = [];
    let skippedRows = 0;
    const tradeLegs: TradeLeg[] = [];

    for (const row of rows) {
      const rawType = rowCol(row, 'type').trim().toLowerCase();
      const rawAsset = rowCol(row, 'asset', 'currency');
      const amountStr = rowCol(row, 'amount');
      const feeStr = rowCol(row, 'fee');
      const tsStr = rowCol(row, 'time', 'timestamp', 'date');
      const refid = rowCol(row, 'refid');

      const timestamp = safeEpochTimestamp(tsStr);
      const amount = safeNumber(amountStr);
      const fee = safeNumber(feeStr);
      const mapped = TYPE_MAP[rawType];

      // Unknown type, or missing asset/time/amount — skip.
      if (!mapped || !rawAsset || !Number.isFinite(timestamp) || amount === 0) {
        skippedRows += 1;
        continue;
      }

      const asset = normalizeAsset(rawAsset);
      const isIncoming = amount > 0;

      // Handle trades separately
      if (mapped === 'trade') {
        tradeLegs.push({ refid, timestamp, asset, amount, fee, raw: row });
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
        sourceRef: refid || rowCol(row, 'txid') || undefined,
        feeAmount: fee !== 0 ? Math.abs(fee) : undefined,
        feeAsset: fee !== 0 ? asset : undefined,
        notes: rowCol(row, 'subtype') || undefined,
        flags: typeForTransfer === 'transfer_in' || typeForTransfer === 'transfer_out'
          ? ['possible_internal_transfer']
          : [],
        isInternalTransfer: false,
        raw: row,
      });
    }

    // Stitch trade legs
    const stitched = stitchTrades(tradeLegs);
    transactions.push(...stitched.transactions);
    skippedRows += stitched.skippedRows;
    warnings.push(...stitched.warnings);

    if (skippedRows > 0) {
      warnings.push(`${skippedRows} row(s) skipped — unrecognized type or missing data.`);
    }

    return { transactions, skippedRows, warnings };
  },
};

export default krakenParser;
