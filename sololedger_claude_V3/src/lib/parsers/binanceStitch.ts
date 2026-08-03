import type { Transaction } from '@/types/transaction';
import type { AccountClass } from '@/lib/ledger/derivedPostings';
import { stitchLedger, normalizeLedgerRows, recognizedOps } from './ledgerStitch';
import { binanceLedgerConfig } from './binanceLedgerOps';
import type { LedgerRow, LedgerSourceRowAccounting } from './ledgerStitch';
import type { CsvImportEvidence } from './types';

export type { LedgerRow as BinanceLedgerRow };
export interface BinanceSourceRowAccounting extends LedgerSourceRowAccounting {
  accountClass: AccountClass;
}

function rawColumn(row: Record<string, string>, ...keys: string[]): string {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [
    key.toLowerCase().replace(/[^a-z0-9]/g, ''), String(value ?? '')
  ]));
  for (const key of keys) {
    const value = normalized.get(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (value?.trim()) return value.trim();
  }
  return '';
}

function strictSignedDecimal(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function strictBinanceTimestamp(value: string): number | undefined {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day &&
    date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
    ? timestamp : undefined;
}

function strictBalanceJournalRow(row: Record<string, string>) {
  const account = rawColumn(row, ...(binanceLedgerConfig.columns.account ?? []));
  const accountClass = account ? accountClassOf(account) : 'unknown';
  const asset = rawColumn(row, ...binanceLedgerConfig.columns.coin).toUpperCase();
  const amount = strictSignedDecimal(rawColumn(row, ...binanceLedgerConfig.columns.change));
  const operation = rawColumn(row, ...binanceLedgerConfig.columns.operation);
  const timestamp = strictBinanceTimestamp(rawColumn(row, ...binanceLedgerConfig.columns.time));
  return {
    accountClass, asset, amount,
    valid: accountClass !== 'unknown' && asset !== '' && amount != null && amount !== 0 &&
      operation !== '' && timestamp != null
  };
}

/**
 * Binance Transaction History stitching — now a thin wrapper over the generic
 * ledger-stitching engine (`ledgerStitch.ts`) driven by the declarative
 * Binance operation map (`binanceLedgerOps.ts`). All leg-pairing, trade
 * assembly, and classification logic lives in the engine; this module only
 * preserves the public API the parsers and tests already use.
 */
export function stitchBinanceTransactionHistory(rows: Record<string, string>[]): {
  transactions: Transaction[];
  skippedRows: number;
  warnings: string[];
  balanceSnapshot?: Record<string, number>;
  optionsBalanceUnavailable?: boolean;
  optionsCoverageThrough?: number;
  sourceRowAccounting: BinanceSourceRowAccounting[];
  evidence: CsvImportEvidence;
} {
  // Binance authority and tax rows share one strict parser boundary. The
  // generic stitcher is intentionally permissive for broad exchange support,
  // but exhaustive custody evidence must never inherit prefix-parsed amounts,
  // defaulted account classes, or normalized invalid calendar dates.
  const validatedRows = rows.map((row) => ({ row, journal: strictBalanceJournalRow(row) }));
  const strictRows = validatedRows.filter(({ journal }) => journal.valid).map(({ row }) => row);
  const result = stitchLedger(strictRows, binanceLedgerConfig);
  const normalized = normalizeLedgerRows(strictRows, binanceLedgerConfig);
  const sourceRowAccounting: BinanceSourceRowAccounting[] = result.sourceRowAccounting.map((row) => ({
    ...row,
    accountClass: accountClassOf(row.account)
  }));
  for (const transaction of result.transactions) {
    const classes = [...new Set(sourceRowAccounting
      .filter((row) => row.transactionId === transaction.id)
      .map((row) => row.accountClass))];
    transaction.parserAccountClass = classes.length === 1 ? classes[0] : 'unknown';
  }
  const excludedCount = sourceRowAccounting.filter((row) => row.status === 'excluded').length;
  const failedCount = sourceRowAccounting.filter((row) => row.status === 'failed').length;
  const unrecognizedCount = sourceRowAccounting.filter((row) => row.failureReason === 'unrecognized_operation').length;
  const unconsumedCount = sourceRowAccounting.filter((row) => row.failureReason === 'unconsumed_recognized_row').length;
  const malformedCount = rows.length - normalized.length;
  const coveredAccountClasses = [...new Set(normalized.map((row) => accountClassOf(row.account)))];
  const classes = coveredAccountClasses.length > 0 ? coveredAccountClasses : ['unknown' as const];
  if (malformedCount > 0 && !classes.includes('unknown')) classes.push('unknown');
  const balanceJournalRows = validatedRows.map(({ journal }) => journal);
  const hasUnscopedMalformedRows = balanceJournalRows.some((row) => !row.valid && row.accountClass === 'unknown');
  // Keep the reconstructed journal ending quantities in their exact custody
  // classes. Binance's export does not timestamp an absolute balance, so these
  // deliberately remain non-comparable evidence rather than being promoted to
  // a fabricated current snapshot. Consumers may label a structurally complete
  // class as a reconstructed journal balance while reconciliation stays open.
  const finalBalanceSnapshots = classes.flatMap((accountClass) => {
    if (accountClass === 'options' || accountClass === 'unknown') return [];
    const classRows = balanceJournalRows.filter((row) => row.accountClass === accountClass);
    if (classRows.length === 0) return [];
    const balances: Record<string, number> = {};
    for (const row of classRows) {
      if (!row.valid || row.amount == null) continue;
      balances[row.asset] = (balances[row.asset] ?? 0) + row.amount;
    }
    // Long journals accumulate binary floating-point residue when equal signed
    // rows cancel. Do not surface those sub-nanounit artifacts as holdings.
    for (const asset of Object.keys(balances)) {
      if (Math.abs(balances[asset]) < 1e-9) balances[asset] = 0;
    }
    // Transaction stitching can be partial for a recognized operation while
    // the custody journal remains complete: every normalized signed row still
    // participates in the ending-balance sum. Only malformed rows make the
    // balance reconstruction itself partial.
    return [{
      accountClass,
      balances,
      balanceStatus: !hasUnscopedMalformedRows && classRows.every((row) => row.valid)
        ? 'complete' as const : 'partial' as const
    }];
  });
  const warnings = [...result.warnings];
  if (malformedCount > 0) {
    warnings.push(`${malformedCount} row(s) skipped — invalid account, timestamp, asset, operation, or signed decimal amount.`);
  }
  const completeLegacyBalance = finalBalanceSnapshots.length > 0 &&
    finalBalanceSnapshots.every((snapshot) => snapshot.balanceStatus === 'complete') &&
    balanceJournalRows.every((row) => row.accountClass === 'options' || row.valid);
  return {
    ...result,
    skippedRows: malformedCount,
    warnings,
    balanceSnapshot: completeLegacyBalance ? result.balanceSnapshot : undefined,
    sourceRowAccounting,
    evidence: {
      finalBalanceSnapshots,
      coveredAccountClasses: classes,
      requiredOutcomes: classes.map((accountClass) => {
        const classRows = sourceRowAccounting.filter((row) => row.accountClass === accountClass);
        const classExcluded = classRows.filter((row) => row.status === 'excluded').length;
        const classFailed = classRows.filter((row) => row.status === 'failed').length;
        const classUnrecognized = classRows.filter((row) => row.failureReason === 'unrecognized_operation').length;
        const classUnconsumed = classRows.filter((row) => row.failureReason === 'unconsumed_recognized_row').length;
        const classParsed = classRows.filter((row) => row.status === 'parsed').length;
        const parsedTransactionRows = [...new Set(classRows.flatMap((row) => row.transactionId ?? []))]
          .map((transactionId) => ({
            transactionId,
            sourceRowCount: classRows.filter((row) => row.transactionId === transactionId).length
          }));
        return {
          id: `binance_transaction_history:${accountClass}`,
          accountClass,
          required: true,
          status: accountClass === 'unknown' && malformedCount > 0 ? 'failed' as const
            : accountClass === 'options' ? 'partial' as const
              : classParsed === 0 && classFailed > 0 ? 'failed' as const
              : classFailed > 0 ? 'partial' as const : 'complete' as const,
          reason: accountClass === 'options'
            ? 'Binance Transaction History omits Options premiums and settlements.'
            : accountClass === 'unknown' && malformedCount > 0 ? 'Rows missing required values.'
              : classFailed > 0 ? 'Binance rows were unrecognized or could not be consumed.' : undefined,
          recognizedCount: classParsed + classExcluded,
          parsedCount: classParsed,
          excludedCount: classExcluded,
          skippedCount: accountClass === 'unknown' ? malformedCount : 0,
          failedCount: classFailed,
          exclusionReasons: classExcluded > 0
            ? [{ reason: 'Recognized non-transaction balance or internal-principal rows.', count: classExcluded }]
            : [],
          failureReasons: [
            ...(classUnrecognized > 0 ? [{ reason: 'Unrecognized Binance operation.', count: classUnrecognized }] : []),
            ...(classUnconsumed > 0 ? [{ reason: 'Recognized Binance row was not consumed by stitching.', count: classUnconsumed }] : [])
          ],
          skippedReasons: accountClass === 'unknown' && malformedCount > 0
            ? [{ reason: 'Missing time, coin, operation, or non-zero amount.', count: malformedCount }]
            : [],
          parsedTransactionRows
        };
      }),
      recognizedCount: sourceRowAccounting.filter((row) => row.status !== 'failed').length,
      parsedCount: sourceRowAccounting.filter((row) => row.status === 'parsed').length,
      excludedCount,
      skippedCount: malformedCount,
      failedCount,
      exclusionReasons: excludedCount > 0
        ? [{ reason: 'Recognized non-transaction balance or internal-principal rows.', count: excludedCount }]
        : [],
      skippedReasons: malformedCount > 0
        ? [{ reason: 'Missing time, coin, operation, or non-zero amount.', count: malformedCount }]
        : [],
      failureReasons: [
        ...(unrecognizedCount > 0 ? [{ reason: 'Unrecognized Binance operation.', count: unrecognizedCount }] : []),
        ...(unconsumedCount > 0
          ? [{ reason: 'Recognized Binance row was not consumed by stitching.', count: unconsumedCount }] : [])
      ]
    }
  };
}

function accountClassOf(account: string): AccountClass {
  const value = account.trim().toLowerCase();
  if (value.includes('funding')) return 'funding';
  if (value.includes('margin')) return 'margin';
  if (value.includes('future')) return 'futures';
  if (value.includes('option')) return 'options';
  if (value.includes('spot')) return 'spot';
  return 'unknown';
}

export function normalizeBinanceLedgerRows(rows: Record<string, string>[]): LedgerRow[] {
  return normalizeLedgerRows(rows, binanceLedgerConfig);
}

/** Operation strings the Binance map recognizes (for coverage assertions). */
export function recognizedBinanceOps(): Set<string> {
  return recognizedOps(binanceLedgerConfig.ops);
}
