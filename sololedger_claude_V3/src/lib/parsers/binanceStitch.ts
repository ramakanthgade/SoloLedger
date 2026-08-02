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
  const result = stitchLedger(rows, binanceLedgerConfig);
  const normalized = normalizeLedgerRows(rows, binanceLedgerConfig);
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
  return {
    ...result,
    sourceRowAccounting,
    evidence: {
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
