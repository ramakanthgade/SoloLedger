/**
 * Deterministic generic history parser (no API key required).
 *
 * A permissive, last-resort registry parser that reads common exchange
 * spreadsheet shapes by column *family* rather than an exact known layout:
 *   - a date/time column   (Time / Date / Timestamp)
 *   - an asset/coin column (Coin / Asset / Symbol / Token / Currency)
 *   - an amount column     (Amount / Quantity / Qty / Volume)
 *
 * It is registered LAST in the `PARSERS` registry so every exchange-specific
 * parser wins first; only files no specific parser claims reach this one.
 *
 * IMPLIED TYPE: "all deposits" / "all withdrawals" exports (e.g. Binance
 * "Deposit History") have NO type column — the type is implied by the report
 * title. `parseSheetMatrix` scans the preamble for that title and passes an
 * `impliedType` via `SheetContext`; this parser synthesizes a constant type
 * column so the existing `parseWithMapping` type-mapping path is reused as-is.
 */
import type { TxType } from '@/types/transaction';
import type { ExchangeParser, MissingField, ParseResult, SheetContext } from './types';
import { headerMap, col, colIncludes } from './headerMap';
import {
  DEFAULT_TYPE_VALUE_MAP,
  parseWithMapping,
  type ColumnMapping
} from './generic';

/** Synthetic column key used to carry an implied (title-derived) type. */
const IMPLIED_TYPE_COL = '__impliedType';

interface HeaderAnalysis {
  dateCol?: string;
  assetCol?: string;
  amountCol?: string;
  typeCol?: string;
  totalCol?: string;
  priceCol?: string;
  feeAmountCol?: string;
  feeAssetCol?: string;
  notesCol?: string;
}

/** Resolve the recognized column families from a header set. */
function analyzeHeaders(headers: string[]): HeaderAnalysis {
  const map = headerMap(headers);
  return {
    dateCol:
      col(map, 'time', 'date', 'timestamp', 'datetime', 'dateutc') ??
      colIncludes(map, 'time', 'date', 'timestamp'),
    assetCol:
      col(map, 'coin', 'asset', 'symbol', 'token', 'currency') ??
      colIncludes(map, 'coin', 'asset', 'symbol', 'token', 'currency'),
    amountCol:
      col(map, 'amount', 'quantity', 'qty', 'volume', 'executedqty') ??
      colIncludes(map, 'amount', 'quantity', 'qty', 'volume'),
    typeCol:
      col(map, 'type', 'side', 'operation', 'transaction', 'transactiontype', 'tradetype', 'direction', 'action') ??
      colIncludes(map, 'type', 'side', 'operation', 'direction'),
    totalCol: col(map, 'total', 'totalvalue', 'quoteqty', 'subtotal') ?? colIncludes(map, 'total', 'subtotal'),
    priceCol: col(map, 'price', 'priceperunit', 'unitprice') ?? colIncludes(map, 'price'),
    feeAmountCol: col(map, 'fee', 'feeamount', 'fees') ?? colIncludes(map, 'fee'),
    feeAssetCol: col(map, 'feeasset', 'feecurrency', 'feecoin'),
    notesCol: col(map, 'notes', 'remarks', 'reason', 'description')
  };
}

/**
 * Which required import families are absent for this header set + context.
 * `type` is considered satisfied by either an explicit type column OR an
 * implied type from the report title. Drives the graduated fix-the-file copy.
 */
export function detectMissingFields(headers: string[], ctx?: SheetContext): MissingField[] {
  const a = analyzeHeaders(headers);
  const missing: MissingField[] = [];
  if (!a.dateCol) missing.push('timestamp');
  if (!a.assetCol) missing.push('asset');
  if (!a.amountCol) missing.push('amount');
  if (!a.typeCol && !ctx?.impliedType) missing.push('type');
  return missing;
}

/** True when a date, asset, and amount family are all present. */
function hasCoreFamilies(headers: string[]): boolean {
  const a = analyzeHeaders(headers);
  return Boolean(a.dateCol && a.assetCol && a.amountCol);
}

export const genericHistoryParser: ExchangeParser = {
  id: 'generic_history',
  label: 'Generic history (auto-mapped)',

  detect(headers) {
    // Loose column-family check. Kept permissive but requires all three core
    // families so it doesn't hijack unrelated sheets. Registered LAST so any
    // specific exchange parser still wins.
    return hasCoreFamilies(headers);
  },

  parse(rows, ctx): ParseResult {
    if (rows.length === 0) {
      return { transactions: [], skippedRows: 0, warnings: ['Sheet has no data rows.'] };
    }

    const headers = Object.keys(rows[0]);
    const a = analyzeHeaders(headers);

    // Required families absent → surface which ones so callers can render
    // actionable fix-the-file guidance instead of a generic dead-end. Reuse the
    // shared derivation (which also treats an implied type as satisfying `type`).
    const missing = detectMissingFields(headers, ctx);
    const missingCore = missing.filter((f) => f !== 'type');
    if (missingCore.length > 0) {
      return {
        transactions: [],
        skippedRows: rows.length,
        warnings: [
          `Could not auto-map required column(s): ${missingCore.join(', ')}.`
        ],
        missingFields: missingCore
      };
    }

    // Type resolution: explicit type column, else implied from the report title.
    const hasTypeColumn = Boolean(a.typeCol);
    const impliedType = ctx?.impliedType;
    if (!hasTypeColumn && !impliedType) {
      return {
        transactions: [],
        skippedRows: rows.length,
        warnings: [
          'No transaction Type column found and the sheet title did not imply one (e.g. "Deposit History").'
        ],
        missingFields: ['type']
      };
    }

    let workRows = rows;
    let typeCol = a.typeCol as string;
    let typeValueMap: Record<string, TxType> = DEFAULT_TYPE_VALUE_MAP;

    if (!hasTypeColumn && impliedType) {
      // Synthesize a constant type column so parseWithMapping's type path is
      // reused verbatim. Uses the TxType label as both the cell value and key.
      workRows = rows.map((r) => ({ ...r, [IMPLIED_TYPE_COL]: impliedType }));
      typeCol = IMPLIED_TYPE_COL;
      typeValueMap = { [impliedType]: impliedType };
    }

    const mapping: ColumnMapping = {
      timestamp: a.dateCol as string,
      type: typeCol,
      asset: a.assetCol as string,
      amount: a.amountCol as string,
      totalValue: a.totalCol,
      pricePerUnit: a.priceCol,
      feeAmount: a.feeAmountCol,
      feeAsset: a.feeAssetCol,
      notes: a.notesCol,
      typeValueMap,
      // Plain coin/asset columns are single tickers, not trading pairs.
      assetIsTradingPair: false
    };

    const result = parseWithMapping(workRows, mapping);

    // When nothing parsed and there was an explicit type column, the likely
    // cause is unrecognized type values — report `type` so the UI can guide.
    if (result.transactions.length === 0 && hasTypeColumn) {
      return { ...result, missingFields: ['type'] };
    }

    // Surface the report title that drove the implied type, so the user can
    // confirm we inferred it correctly (e.g. "Deposit History" → transfer_in).
    if (!hasTypeColumn && impliedType && result.transactions.length > 0) {
      const titleNote = ctx?.sheetTitle
        ? `“${ctx.sheetTitle}”`
        : 'the report title';
      return {
        ...result,
        warnings: [
          `No Type column — inferred ${impliedType} for every row from ${titleNote}.`,
          ...result.warnings
        ]
      };
    }

    return result;
  }
};
