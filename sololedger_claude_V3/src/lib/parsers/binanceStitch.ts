import type { Transaction } from '@/types/transaction';
import { stitchLedger, normalizeLedgerRows, recognizedOps } from './ledgerStitch';
import { binanceLedgerConfig } from './binanceLedgerOps';
import type { LedgerRow } from './ledgerStitch';

export type { LedgerRow as BinanceLedgerRow };

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
} {
  return stitchLedger(rows, binanceLedgerConfig);
}

export function normalizeBinanceLedgerRows(rows: Record<string, string>[]): LedgerRow[] {
  return normalizeLedgerRows(rows, binanceLedgerConfig);
}

/** Operation strings the Binance map recognizes (for coverage assertions). */
export function recognizedBinanceOps(): Set<string> {
  return recognizedOps(binanceLedgerConfig.ops);
}
