import Papa from 'papaparse';
import { coinbaseParser } from './coinbase';
import { binanceParser } from './binance';
import { binanceSpotParser } from './binanceSpot';
import { wazirxTradesParser } from './wazirxTrades';
import { wazirxDepositsParser } from './wazirxDeposits';
import { wazirxLedgerParser } from './wazirxLedger';
import { hyperliquidTradesParser } from './hyperliquidTrades';
import { hyperliquidDepositsParser } from './hyperliquidDeposits';
import { coindcxParser } from './coindcx';
import { coinswitchParser } from './coinswitch';
import { zebpayParser } from './zebpay';
import { mudrexParser } from './mudrex';
import { krakenParser } from './kraken';
import { kucoinParser } from './kucoin';
import { cryptocomParser } from './cryptocom';
import { bybitParser } from './bybit';
import { okxParser } from './okx';
import { gateioParser } from './gateio';
import { bitfinexParser } from './bitfinex';
import { geminiParser } from './gemini';
import { htxParser } from './htx';
import { coinspotParser } from './coinspot';
import { genericHistoryParser, detectMissingFields } from './genericHistory';
import type { ExchangeParser, MissingField, ParseResult, SheetContext } from './types';
import type { TxType } from '@/types/transaction';
import { extractTableFromMatrix, isUsefulTransactionTable, cleanCell } from './tableExtract';
import { isSpreadsheetFile, readWorkbookSheets } from './workbook';
import type { Transaction } from '@/types/transaction';

/**
 * Parser registry — order matters for detect().
 * Exchange-specific formats first so they win over looser heuristics.
 */
export const PARSERS: ExchangeParser[] = [
  hyperliquidTradesParser,
  hyperliquidDepositsParser,
  wazirxTradesParser,
  wazirxDepositsParser,
  wazirxLedgerParser,
  // India CEX parsers — specific enough to win over the generic spot heuristic.
  coindcxParser,
  coinswitchParser,
  zebpayParser,
  mudrexParser,
  binanceSpotParser,
  coinbaseParser,
  binanceParser,
  krakenParser,
  kucoinParser,
  cryptocomParser,
  bybitParser,
  okxParser,
  gateioParser,
  bitfinexParser,
  geminiParser,
  htxParser,
  coinspotParser,
  // Deterministic loose fallback — MUST be last so specific parsers win.
  genericHistoryParser
];

export interface SheetParseOutcome {
  sheetName: string;
  sheetIndex: number;
  /** True when the sheet was skipped as non-transactional (profile, empty, etc.). */
  skipped: boolean;
  skipReason?: string;
  detectedParser: string | null;
  headers: string[];
  rows: Record<string, string>[];
  transactions: Transaction[];
  skippedRows: number;
  warnings: string[];
  headerScore: number;
  /** Required field(s) a generic parse found missing, for fix-the-file guidance. */
  missingFields?: MissingField[];
  /**
   * True when THIS sheet's rows had their addresses resolved from a single
   * ambiguous "Address" column (assume-To baseline). Kept at sheet granularity
   * so a non-local caller can confirm/flip orientation for only this sheet's
   * rows — a multi-sheet workbook may mix ambiguous and clearly-named sheets.
   */
  addressColumnAmbiguous?: boolean;
}

export interface FileParseOutcome extends ParseResult {
  detectedParser: string | null; // parser id(s), or null if manual mapping needed
  headers: string[];
  rows: Record<string, string>[]; // raw rows for manual mapping fallback
  /** Per-sheet results when a multi-sheet workbook (or single CSV treated as one sheet). */
  sheets: SheetParseOutcome[];
}

/**
 * Scan preamble rows above the header for a report title that implies a
 * transaction type when the sheet has no explicit type column, e.g. Binance
 * "Deposit History" / "Withdrawal History".
 */
function detectSheetContext(matrix: string[][], headerRowIndex: number): SheetContext {
  const limit = Math.max(0, headerRowIndex);
  for (let i = 0; i < limit; i++) {
    for (const cell of matrix[i] ?? []) {
      const text = cleanCell(cell);
      if (!text) continue;
      if (/deposit\s+history/i.test(text)) {
        return { impliedType: 'transfer_in' as TxType, sheetTitle: text };
      }
      if (/withdraw(al)?\s+history/i.test(text)) {
        return { impliedType: 'transfer_out' as TxType, sheetTitle: text };
      }
    }
  }
  return {};
}

function parseSheetMatrix(
  sheetName: string,
  sheetIndex: number,
  matrix: string[][]
): SheetParseOutcome {
  const empty: SheetParseOutcome = {
    sheetName,
    sheetIndex,
    skipped: true,
    skipReason: 'Empty sheet',
    detectedParser: null,
    headers: [],
    rows: [],
    transactions: [],
    skippedRows: 0,
    warnings: [],
    headerScore: -1
  };

  if (!matrix.length || matrix.every((r) => r.every((c) => !c))) {
    return empty;
  }

  const extracted = extractTableFromMatrix(matrix);
  if (!isUsefulTransactionTable(extracted, sheetName)) {
    return {
      ...empty,
      skipReason:
        extracted.rows.length === 0
          ? 'No transaction table detected (profile, menu, or empty sheet)'
          : `Sheet does not look like transaction data (header score ${extracted.headerScore})`,
      headers: extracted.headers,
      rows: extracted.rows,
      headerScore: extracted.headerScore
    };
  }

  const preambleWarning =
    extracted.headerRowIndex > 0
      ? `Ignored ${extracted.headerRowIndex} non-transaction row(s) before the header on “${sheetName}”.`
      : null;

  const ctx = detectSheetContext(matrix, extracted.headerRowIndex);

  const matched = PARSERS.find((p) => p.detect(extracted.headers, ctx));
  if (!matched) {
    // No parser claimed the sheet (the generic parser needs date+asset+amount,
    // so files missing one never reach parse()). Derive which required fields
    // are absent so the UI can render actionable fix-the-file guidance, and
    // flag a skipped preamble as its own fixable issue.
    const missing = detectMissingFields(extracted.headers, ctx);
    if (preambleWarning) missing.unshift('preamble');
    return {
      sheetName,
      sheetIndex,
      skipped: false,
      skipReason: undefined,
      detectedParser: null,
      headers: extracted.headers,
      rows: extracted.rows,
      transactions: [],
      skippedRows: 0,
      warnings: [
        ...(preambleWarning ? [preambleWarning] : []),
        `Could not auto-detect format for sheet “${sheetName}”.`
      ],
      headerScore: extracted.headerScore,
      missingFields: missing.length > 0 ? missing : undefined
    };
  }

  const result = matched.parse(extracted.rows, ctx);
  // Tag raw with sheet name for provenance
  const txs = result.transactions.map((t) => ({
    ...t,
    raw: { ...(t.raw as Record<string, unknown> | undefined), _sheetName: sheetName }
  }));

  return {
    sheetName,
    sheetIndex,
    skipped: false,
    detectedParser: matched.id,
    headers: extracted.headers,
    rows: extracted.rows,
    transactions: txs,
    skippedRows: result.skippedRows,
    warnings: [
      ...(preambleWarning ? [preambleWarning] : []),
      ...result.warnings.map((w) => (w.includes(sheetName) ? w : `[${sheetName}] ${w}`))
    ],
    headerScore: extracted.headerScore,
    missingFields: result.missingFields,
    addressColumnAmbiguous: result.addressColumnAmbiguous
  };
}

function mergeSheetOutcomes(sheets: SheetParseOutcome[], fileLabel: string): FileParseOutcome {
  const useful = sheets.filter((s) => !s.skipped);
  const parsed = useful.filter((s) => s.detectedParser && s.transactions.length > 0);
  // A sheet a parser "claimed" but produced no transactions (e.g. the generic
  // parser matched the column families but the file lacks a Type column) still
  // needs the manual/AI-mapping fallback, so treat any useful-but-empty sheet
  // with rows as unrecognized here.
  const unrecognized = useful.filter((s) => s.transactions.length === 0 && s.rows.length > 0);

  const transactions = parsed.flatMap((s) => s.transactions);
  const skippedRows = sheets.reduce((a, s) => a + s.skippedRows, 0);
  const warnings: string[] = [];

  // Aggregate structured missing-field hints from empty sheets so callers can
  // render actionable fix-the-file guidance instead of a generic dead-end.
  const missingFields =
    transactions.length === 0
      ? [...new Set(unrecognized.flatMap((s) => s.missingFields ?? []))]
      : [];

  const skippedSheets = sheets.filter((s) => s.skipped);
  if (skippedSheets.length > 0) {
    warnings.push(
      `Skipped ${skippedSheets.length} sheet(s) with no importable data: ${skippedSheets
        .map((s) => s.sheetName)
        .join(', ')}.`
    );
  }
  for (const s of sheets) {
    warnings.push(...s.warnings);
  }
  for (const s of parsed) {
    warnings.push(
      `Imported ${s.transactions.length} transaction(s) from “${s.sheetName}” (${s.detectedParser}).`
    );
  }

  const parserIds = [...new Set(parsed.map((s) => s.detectedParser!).filter(Boolean))];
  const detectedParser =
    parserIds.length === 0 ? null : parserIds.length === 1 ? parserIds[0] : parserIds.join('+');

  // Manual-mapping fallback: pick the richest unrecognized sheet
  let headers: string[] = [];
  let rows: Record<string, string>[] = [];
  if (transactions.length === 0 && unrecognized.length > 0) {
    const best = [...unrecognized].sort((a, b) => b.rows.length - a.rows.length || b.headerScore - a.headerScore)[0];
    headers = best.headers;
    rows = best.rows;
    warnings.push(
      `Could not auto-detect “${best.sheetName}” in ${fileLabel}. Map the columns manually below.`
    );
  } else if (transactions.length === 0 && useful.length === 0) {
    warnings.push(
      `Could not find a usable transactions table in ${fileLabel}. Try a different export or map columns manually.`
    );
  } else if (unrecognized.length > 0 && transactions.length > 0) {
    warnings.push(
      `${unrecognized.length} sheet(s) had tabular data but no matching parser: ${unrecognized
        .map((s) => s.sheetName)
        .join(', ')}. Imported recognized sheets only.`
    );
  }

  return {
    transactions,
    skippedRows,
    warnings,
    missingFields: missingFields.length > 0 ? missingFields : undefined,
    // Convenience "any sheet ambiguous" flag for gating; the per-sheet flag on
    // each SheetParseOutcome is authoritative for WHICH rows to orient.
    addressColumnAmbiguous: sheets.some((s) => s.addressColumnAmbiguous),
    detectedParser,
    headers,
    rows,
    sheets
  };
}

/** Parse a single CSV/TXT file (one logical sheet). */
export async function parseCsvFile(file: File): Promise<FileParseOutcome> {
  const text = await file.text();
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy'
  });
  const matrix = parsed.data.map((row) => row.map((c) => cleanCell(String(c ?? ''))));
  const sheet = parseSheetMatrix(file.name || 'CSV', 0, matrix);
  // For single-sheet CSV, don't mark as skipped when useful but unrecognized —
  // keep rows available for manual mapping (isUseful may have filtered profile junk).
  if (sheet.skipped && sheet.rows.length === 0) {
    // Re-extract without usefulness gate so manual mapping still works on weak CSVs
    const extracted = extractTableFromMatrix(matrix);
    if (extracted.headers.length > 0 && extracted.rows.length > 0) {
      const ctx = detectSheetContext(matrix, extracted.headerRowIndex);
      const matched = PARSERS.find((p) => p.detect(extracted.headers, ctx));
      if (matched) {
        const result = matched.parse(extracted.rows, ctx);
        if (result.transactions.length > 0) {
          return {
            ...result,
            detectedParser: matched.id,
            headers: extracted.headers,
            rows: extracted.rows,
            sheets: [
              {
                sheetName: file.name || 'CSV',
                sheetIndex: 0,
                skipped: false,
                detectedParser: matched.id,
                headers: extracted.headers,
                rows: extracted.rows,
                transactions: result.transactions,
                skippedRows: result.skippedRows,
                warnings: result.warnings,
                headerScore: extracted.headerScore,
                addressColumnAmbiguous: result.addressColumnAmbiguous
              }
            ]
          };
        }
        // Parser claimed the sheet but produced no rows — route through the
        // merge path so missingFields + manual/AI fallback are surfaced.
        return mergeSheetOutcomes(
          [
            {
              sheetName: file.name || 'CSV',
              sheetIndex: 0,
              skipped: false,
              detectedParser: null,
              headers: extracted.headers,
              rows: extracted.rows,
              transactions: [],
              skippedRows: result.skippedRows,
              warnings: result.warnings,
              headerScore: extracted.headerScore,
              missingFields: result.missingFields
            }
          ],
          file.name
        );
      }
      return mergeSheetOutcomes(
        [
          {
            sheetName: file.name || 'CSV',
            sheetIndex: 0,
            skipped: false,
            detectedParser: null,
            headers: extracted.headers,
            rows: extracted.rows,
            transactions: [],
            skippedRows: 0,
            warnings: ['Could not auto-detect this file’s format. Map the columns manually below.'],
            headerScore: extracted.headerScore,
            missingFields: (() => {
              const missing = detectMissingFields(extracted.headers, ctx);
              return missing.length > 0 ? missing : undefined;
            })()
          }
        ],
        file.name
      );
    }
  }
  return mergeSheetOutcomes([sheet], file.name);
}

/** Parse a multi-sheet Excel workbook — each sheet independently. */
export async function parseWorkbookFile(file: File): Promise<FileParseOutcome> {
  const workbookSheets = await readWorkbookSheets(file);
  if (workbookSheets.length === 0) {
    return {
      transactions: [],
      skippedRows: 0,
      warnings: ['Workbook has no sheets.'],
      detectedParser: null,
      headers: [],
      rows: [],
      sheets: []
    };
  }
  const outcomes = workbookSheets.map((s) => parseSheetMatrix(s.sheetName, s.sheetIndex, s.matrix));
  return mergeSheetOutcomes(outcomes, file.name);
}

/**
 * Unified entry: CSV/TXT or Excel (.xlsx / .xls).
 * Excel workbooks are scanned sheet-by-sheet; only sheets with importable
 * transaction tables are parsed. Results are merged into one outcome.
 */
export async function parseImportFile(file: File): Promise<FileParseOutcome> {
  if (isSpreadsheetFile(file)) {
    return parseWorkbookFile(file);
  }
  return parseCsvFile(file);
}

export { coinbaseParser, binanceParser, binanceSpotParser };
export { wazirxTradesParser, wazirxDepositsParser, wazirxLedgerParser };
export { hyperliquidTradesParser, hyperliquidDepositsParser };
export { coindcxParser, coinswitchParser, zebpayParser, mudrexParser };
export { krakenParser, kucoinParser, cryptocomParser, bybitParser, okxParser };
export { gateioParser, bitfinexParser, geminiParser, htxParser, coinspotParser };
export { isSpreadsheetFile, isCsvLikeFile } from './workbook';
export * from './types';
export * from './generic';
