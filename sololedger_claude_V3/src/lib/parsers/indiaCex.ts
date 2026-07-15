/**
 * Shared factory for India CEX (centralized-exchange) CSV parsers.
 *
 * The Indian exchanges (CoinDCX, CoinSwitch, ZebPay, Mudrex) all export a very
 * similar "transaction history" shape: IST-stamped rows that are either a spot
 * *trade* (pair + side + price + quantity + quote total) or a *deposit /
 * withdrawal* (asset + amount), plus a fee leg and — mandated by India's
 * Section 194S — a 1% TDS leg. Rather than duplicate the mapping logic four
 * times, each exchange parser is a thin wrapper around `makeIndiaCexParser`
 * that supplies only its id/label/source and a cheap `detect` heuristic; the
 * column names are resolved from a shared synonym table so a new Indian CEX
 * can usually be added by writing a one-line `detect`.
 *
 * INR / IST conventions mirrored from the WazirX parsers:
 *  - timestamps are parsed with `safeTimestampIst` (bare "YYYY-MM-DD HH:mm:ss"
 *    is treated as UTC+5:30, not the machine's local zone);
 *  - INR (and USD-pegged stablecoin) quotes yield a `fiatValue`; anything else
 *    is flagged `missing_cost_basis`;
 *  - TDS columns are captured into the structured B3 `tdsAmount` / `tdsAsset` /
 *    `tdsInr` fields (never only stuffed into `notes`).
 *  - `sourceRef` uses `exchangeSourceRef` (content-hash-stable) so re-importing
 *    the same export dedups to the same key.
 *
 * NOTE ON SCHEMAS: the exact vendor header casing was not available when these
 * parsers were written, so the column *synonym* lists below are a sensible
 * superset built from the WazirX export shape + common Indian-CEX conventions
 * (see AUTHORING.md). Correctness of the mapping logic + TDS capture + IST/INR
 * handling was prioritized over guessing exact headers; validate the synonym
 * lists against a real export and extend `DEFAULT_COLUMN_SYNONYMS` as needed.
 */
import type { Transaction, TxType } from '@/types/transaction';
import {
  makeId,
  safeQuantity,
  safeTimestampIst,
  exchangeSourceRef,
  type ExchangeParser,
  type ParseResult
} from './types';
import { headerMap, col, colIncludes } from './headerMap';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';

/** Fiat asset codes that carry their own fiat value 1:1 on a transfer row. */
const FIAT_ASSETS = new Set(['INR', 'USD', 'EUR', 'GBP', 'AED', 'CAD']);

/** Normalize headers the same way `headerMap` keys them. */
export function normHeaders(headers: string[]): string[] {
  return headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/**
 * Column synonyms shared by every Indian CEX parser. Keys are the logical
 * fields; values are the accepted (normalized) header names, most specific
 * first. Add a vendor's real header here once confirmed.
 */
const DEFAULT_COLUMN_SYNONYMS = {
  time: ['date', 'datetime', 'timestamp', 'time', 'dateist', 'dateutc', 'datetimeist'],
  // Row-level type: TRADE / DEPOSIT / WITHDRAWAL, or directly BUY / SELL.
  type: ['type', 'txntype', 'transactiontype', 'ordertype'],
  // Trade side when separate from `type`.
  side: ['side', 'buysell', 'direction', 'tradetype', 'orderside'],
  pair: ['pair', 'market', 'symbol', 'tradingpair', 'coinpair'],
  price: ['price', 'rate', 'tradeprice', 'executionprice'],
  quantity: ['quantity', 'volume', 'qty', 'filledquantity', 'executedquantity'],
  total: [
    'total',
    'totalquote',
    'totalinr',
    'value',
    'valueinr',
    'ordervalue',
    'ordervalueinr',
    'tradevalue',
    'tradeamount',
    'tradeamountinr'
  ],
  // Transfer (deposit/withdrawal) asset + amount.
  asset: ['asset', 'currency', 'coin', 'token'],
  amount: ['amount', 'tokenamount', 'depositwithdrawalamount'],
  fee: ['fee', 'fees', 'feeamount', 'commission', 'feeinr', 'feesinr'],
  feeAsset: ['feecurrency', 'feeasset', 'feecoin', 'commissionasset'],
  tdsAmount: ['tdsamount'],
  tdsAsset: ['tdscurrency', 'tdsasset', 'tdspaidin'],
  tdsInr: ['tdsinr', 'tds', 'tdsininr'],
  txHash: ['transactionhash', 'txhash', 'txid', 'blockchainhash', 'hash', 'referenceid', 'reference'],
  remarks: ['remarks', 'notes', 'description', 'comment']
} as const;

export interface IndiaCexConfig {
  /** Parser id, e.g. `coindcx`. */
  id: string;
  /** Human label shown in import UI. */
  label: string;
  /** `source` tag stamped onto every emitted Transaction. */
  source: string;
  /** Stable `exchangeSourceRef` prefix (usually the exchange slug). */
  refSource: string;
  /** Cheap header heuristic — must be specific enough not to steal WazirX/Binance files. */
  detect: (headers: string[]) => boolean;
}

type Action = 'buy' | 'sell' | 'transfer_in' | 'transfer_out';

/** Classify a row from its type/side cell(s) into a normalized action. */
function classify(typeRaw: string, sideRaw: string): Action | null {
  const t = typeRaw.trim().toLowerCase();
  const s = sideRaw.trim().toLowerCase();
  if (t.includes('deposit') || t === 'credit' || t === 'receive' || t === 'add') return 'transfer_in';
  if (t.includes('withdraw') || t === 'debit' || t === 'send') return 'transfer_out';
  // Otherwise it's a trade — determine buy/sell from the side column, falling
  // back to the type column itself (exchanges that put BUY/SELL in `type`).
  const dir = s || t;
  if (dir.includes('buy') || dir === 'b' || dir === 'long') return 'buy';
  if (dir.includes('sell') || dir === 's' || dir === 'short') return 'sell';
  return null;
}

/**
 * Build an `ExchangeParser` for an India CEX from a small config. All column
 * mapping, IST/INR handling, fee + TDS capture, and dedup-stable refs are
 * shared here so every Indian-exchange parser behaves identically.
 */
export function makeIndiaCexParser(cfg: IndiaCexConfig): ExchangeParser {
  return {
    id: cfg.id,
    label: cfg.label,
    detect: cfg.detect,

    parse(rows: Record<string, string>[]): ParseResult {
      const transactions: Transaction[] = [];
      const warnings: string[] = [];
      let skippedRows = 0;

      if (rows.length === 0) {
        return { transactions, skippedRows: 0, warnings: ['Sheet has no data rows.'] };
      }

      const map = headerMap(Object.keys(rows[0]));
      const S = DEFAULT_COLUMN_SYNONYMS;
      const pick = (keys: readonly string[]) => col(map, ...keys);

      const timeCol = pick(S.time) ?? colIncludes(map, 'date', 'time');
      const typeCol = pick(S.type);
      const sideCol = pick(S.side);
      const pairCol = pick(S.pair);
      const priceCol = pick(S.price);
      const qtyCol = pick(S.quantity);
      const totalCol = pick(S.total);
      const assetCol = pick(S.asset);
      const amountCol = pick(S.amount);
      const feeCol = pick(S.fee);
      const feeAssetCol = pick(S.feeAsset);
      const tdsAmountCol = pick(S.tdsAmount);
      const tdsAssetCol = pick(S.tdsAsset);
      const tdsInrCol = pick(S.tdsInr);
      const txHashCol = pick(S.txHash);
      const remarksCol = pick(S.remarks);

      if (!timeCol || (!typeCol && !sideCol)) {
        return {
          transactions: [],
          skippedRows: rows.length,
          warnings: [`${cfg.label} columns not found (need a date and a type/side column).`]
        };
      }

      for (const row of rows) {
        const typeRaw = typeCol ? row[typeCol] || '' : '';
        const sideRaw = sideCol ? row[sideCol] || '' : '';
        const action = classify(typeRaw, sideRaw);
        const timestamp = safeTimestampIst(row[timeCol]);

        if (!action || !Number.isFinite(timestamp)) {
          skippedRows++;
          continue;
        }

        // Shared TDS capture (B3 structured fields) — INR-denominated by default.
        const rawTdsAmount = tdsAmountCol ? safeQuantity(row[tdsAmountCol]) : 0;
        const rawTdsInr = tdsInrCol ? safeQuantity(row[tdsInrCol]) : 0;
        let tdsAsset = tdsAssetCol ? (row[tdsAssetCol] || '').trim().toUpperCase() : '';
        let tdsAmount = rawTdsAmount;
        let tdsInr = rawTdsInr;
        if (tdsAmount === 0 && tdsInr > 0) {
          // Only an INR-denominated TDS column exists.
          tdsAmount = tdsInr;
          if (!tdsAsset) tdsAsset = 'INR';
        } else if (tdsInr === 0 && tdsAmount > 0 && (!tdsAsset || tdsAsset === 'INR')) {
          // TDS given as an INR amount without a separate INR-value column.
          tdsInr = tdsAmount;
          if (!tdsAsset) tdsAsset = 'INR';
        }
        const hasTds = tdsAmount > 0;

        const feeAmount = feeCol ? safeQuantity(row[feeCol]) : 0;
        const feeAsset = feeAssetCol ? (row[feeAssetCol] || '').trim().toUpperCase() : '';
        const txHash = txHashCol ? (row[txHashCol] || '').trim() : '';
        const remarks = remarksCol ? (row[remarksCol] || '').trim() : '';

        const tdsNote = hasTds
          ? `TDS ${tdsAmount}${tdsAsset ? ' ' + tdsAsset : ''}${tdsInr > 0 && tdsAsset !== 'INR' ? ` (≈₹${tdsInr})` : ''}`
          : '';

        if (action === 'buy' || action === 'sell') {
          const pairRaw = pairCol ? (row[pairCol] || '').trim() : '';
          const { base, quote } = parseTradingPair(pairRaw);
          const qty = qtyCol ? safeQuantity(row[qtyCol]) : 0;
          const price = priceCol ? safeQuantity(row[priceCol]) : 0;
          const total = totalCol ? safeQuantity(row[totalCol]) : 0;

          if (!base || qty === 0) {
            skippedRows++;
            continue;
          }

          const fiatQuote = quoteToFiatCurrency(quote);
          const fiatCurrency = fiatQuote ?? 'INR';
          const counterAmount = total > 0 ? total : price > 0 && qty > 0 ? price * qty : undefined;
          let fiatValue: number | undefined;
          if (fiatQuote) fiatValue = counterAmount;

          const notesParts = [`${cfg.label} · ${pairRaw || base}`];
          if (tdsNote) notesParts.push(tdsNote);
          if (remarks) notesParts.push(remarks);

          transactions.push({
            id: makeId(cfg.id),
            timestamp,
            type: action,
            asset: base,
            amount: qty,
            counterAsset: quote,
            counterAmount,
            fiatCurrency,
            fiatValue: fiatValue && fiatValue > 0 ? fiatValue : undefined,
            feeAmount: feeAmount > 0 ? feeAmount : undefined,
            feeAsset: feeAsset || (feeAmount > 0 ? fiatCurrency : undefined),
            tdsAmount: hasTds ? tdsAmount : undefined,
            tdsAsset: hasTds && tdsAsset ? tdsAsset : undefined,
            tdsInr: hasTds && tdsInr > 0 ? tdsInr : undefined,
            source: cfg.source,
            sourceRef: exchangeSourceRef(cfg.refSource, timestamp, action, base, qty),
            notes: notesParts.join(' · '),
            flags: fiatValue && fiatValue > 0 ? [] : ['missing_cost_basis'],
            isInternalTransfer: false,
            raw: { ...row, _sheetFormat: `${cfg.id}_trades` }
          });
        } else {
          // Deposit / withdrawal.
          const asset = assetCol ? (row[assetCol] || '').trim().toUpperCase() : '';
          const amount = amountCol ? safeQuantity(row[amountCol]) : 0;

          if (!asset || amount === 0) {
            skippedRows++;
            continue;
          }

          const isFiat = FIAT_ASSETS.has(asset);
          const transferTotal = totalCol ? safeQuantity(row[totalCol]) : 0;
          let fiatCurrency = 'INR';
          let fiatValue: number | undefined;
          if (isFiat) {
            fiatCurrency = asset;
            fiatValue = amount;
          } else if (transferTotal > 0) {
            fiatValue = transferTotal;
          }

          const notesParts: string[] = [];
          if (remarks) notesParts.push(remarks);
          if (tdsNote) notesParts.push(tdsNote);
          if (txHash) notesParts.push(`Tx ${txHash.slice(0, 14)}…`);

          transactions.push({
            id: makeId(cfg.id),
            timestamp,
            type: action as TxType,
            asset,
            amount,
            fiatCurrency,
            fiatValue,
            feeAmount: feeAmount > 0 ? feeAmount : undefined,
            feeAsset: feeAmount > 0 ? feeAsset || asset : undefined,
            tdsAmount: hasTds ? tdsAmount : undefined,
            tdsAsset: hasTds && tdsAsset ? tdsAsset : undefined,
            tdsInr: hasTds && tdsInr > 0 ? tdsInr : undefined,
            source: cfg.source,
            sourceRef: exchangeSourceRef(cfg.refSource, timestamp, action, asset, amount),
            notes: notesParts.length > 0 ? notesParts.join(' · ') : undefined,
            flags: ['possible_internal_transfer'],
            isInternalTransfer: false,
            raw: { ...row, _sheetFormat: `${cfg.id}_transfers` }
          });
        }
      }

      if (skippedRows > 0) {
        warnings.push(`${skippedRows} ${cfg.label} row(s) skipped — unrecognized type/side or missing data.`);
      }

      return { transactions, skippedRows, warnings };
    }
  };
}
