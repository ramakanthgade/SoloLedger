/**
 * Import-source catalog for the guided ConnectionWizard (Task T3).
 *
 * India CEXs are featured first (matching `aurora-guided-import.html`), then
 * global exchanges. Each entry carries the step-by-step CSV/XLSX export
 * instructions shown in wizard step 2 — copy is written for a first-time
 * filer and references the India Financial Year (Apr–Mar) where relevant.
 *
 * These are guidance only; the actual parsing is unchanged and still runs
 * through the auto-detect parser registry (`@/lib/parsers`).
 */
export interface ImportSource {
  id: string;
  label: string;
  /** Two-letter monogram for the Aurora logo tile. */
  monogram: string;
  /** Short format hint shown under the name in the picker. */
  formatHint: string;
  region: 'india' | 'global';
  /** Ordered, plain-language export steps. */
  steps: string[];
  /** Breadcrumb path of the export location (e.g. Profile › Reports). */
  path: string[];
  /** Reassuring one-liner about what the export contains. */
  note?: string;
}

/**
 * Restrained guidance for parser-backed formats whose vendor export path has
 * not been verified. The parser contract is real; the UI deliberately avoids
 * inventing menu paths, date-range coverage, or vendor-specific guarantees.
 */
function schemaCompatibleCsvSource(config: {
  id: string;
  label: string;
  monogram: string;
  reportType: string;
  expectedColumns: string;
  formatHint?: string;
  coverageNote?: string;
}): ImportSource {
  const { id, label, monogram, reportType, expectedColumns, formatHint, coverageNote } = config;
  return {
    id,
    label,
    monogram,
    formatHint: formatHint ?? `${reportType} CSV · schema-compatible beta`,
    region: 'global',
    steps: [
      `Export the ${reportType} report from ${label} as CSV. The exact vendor menu path has not been verified.`,
      `Use the schema-compatible format with these expected columns: ${expectedColumns}.`,
      'Drop the CSV into the next step; SoloLedger will verify its columns before importing.'
    ],
    path: [reportType, 'CSV', 'Schema-compatible beta'],
    note:
      coverageNote ??
      `Supports this ${label} report schema, not every export the exchange may offer. Review the import preview before saving.`
  };
}

export const IMPORT_SOURCES: ImportSource[] = [
  {
    id: 'coindcx',
    label: 'CoinDCX',
    monogram: 'DC',
    formatHint: 'CSV · TDS included',
    region: 'india',
    steps: [
      'Open CoinDCX and go to Profile → Reports.',
      'Choose the Trade & TDS report for this Financial Year (Apr–Mar).',
      'Set the format to CSV and tap Download.',
      'Come back here and drop that file into the next step.'
    ],
    path: ['Profile', 'Reports', 'Trade & TDS', 'CSV'],
    note: 'The CoinDCX trade report already includes the 1% TDS withheld on each transfer.'
  },
  {
    id: 'coinswitch',
    label: 'CoinSwitch',
    monogram: 'CS',
    formatHint: 'CSV export',
    region: 'india',
    steps: [
      'Open the CoinSwitch app and go to Profile → Reports & Statements.',
      'Select Transaction / TDS statement and pick the Financial Year (Apr–Mar).',
      'Request the report — CoinSwitch emails a CSV to your registered address.',
      'Download the CSV and drop it into the next step.'
    ],
    path: ['Profile', 'Reports & Statements', 'TDS statement', 'CSV'],
    note: 'CoinSwitch delivers the statement by email — check your inbox after requesting it.'
  },
  {
    id: 'zebpay',
    label: 'ZebPay',
    monogram: 'ZP',
    formatHint: 'CSV / XLSX',
    region: 'india',
    steps: [
      'Open ZebPay and go to Profile → Reports.',
      'Choose the Trade / TDS statement for the Financial Year (Apr–Mar).',
      'Export as CSV or XLSX.',
      'Download the file and drop it into the next step.'
    ],
    path: ['Profile', 'Reports', 'Trade statement', 'CSV / XLSX'],
    note: 'Either CSV or the Excel (.xlsx) export works — the parser reads both.'
  },
  {
    id: 'wazirx',
    label: 'WazirX',
    monogram: 'WX',
    formatHint: 'XLSX ledger',
    region: 'india',
    steps: [
      'Log in to WazirX on the web and open Funds → Transaction History.',
      'Use Download / Export to generate the Trade report (.xlsx).',
      'Also export Deposits & Withdrawals if you want transfers included.',
      'Drop the .xlsx workbook into the next step — all sheets are scanned automatically.'
    ],
    path: ['Funds', 'Transaction History', 'Export', 'XLSX'],
    note: 'Trades, deposits and withdrawals import automatically; profile sheets are skipped.'
  },
  {
    id: 'mudrex',
    label: 'Mudrex',
    monogram: 'MX',
    formatHint: 'CSV export',
    region: 'india',
    steps: [
      'Open Mudrex and go to Profile → Reports / Statements.',
      'Select the Transaction / TDS report for the Financial Year (Apr–Mar).',
      'Export it as CSV.',
      'Download the CSV and drop it into the next step.'
    ],
    path: ['Profile', 'Reports', 'Transaction report', 'CSV'],
    note: 'The Mudrex report captures buys, sells and the 1% TDS on transfers.'
  },
  {
    id: 'binance',
    label: 'Binance',
    monogram: 'BN',
    formatHint: 'CSV · multiple files OK',
    region: 'global',
    steps: [
      'Open Binance on the web and go to Orders → Spot Orders → Trade History, and export that report as CSV.',
      'Then open Wallet → Transaction History and export the Deposit & Withdrawal History report as CSV.',
      'Download the CSV files and drop them together into the next step — each file is detected automatically.'
    ],
    path: ['Orders / Wallet', 'Trade History', 'Deposit & Withdrawal History', 'CSV'],
    note: 'Trade History plus Deposit & Withdrawal History covers everything. Prefer one file? The full-ledger "Transaction History" export still works on its own.'
  },
  {
    id: 'coinbase',
    label: 'Coinbase',
    monogram: 'CB',
    formatHint: 'CSV export',
    region: 'global',
    steps: [
      'Open Coinbase and go to Settings → Reports (or Statements).',
      'Generate a custom report for your Transaction history.',
      'Choose the CSV format for the full date range.',
      'Download the CSV and drop it into the next step.'
    ],
    path: ['Settings', 'Reports', 'Transaction history', 'CSV'],
    note: 'Use the transaction history export, not the tax-only summary, for a complete ledger.'
  },
  schemaCompatibleCsvSource({
    id: 'kraken',
    label: 'Kraken',
    monogram: 'KR',
    reportType: 'Ledger History',
    expectedColumns: 'txid, refid, time, type, subtype, asset, amount, fee, balance',
    formatHint: 'Ledger History CSV · schema-compatible beta',
    coverageNote: 'Use Kraken Ledger History, not a trades-only export. The ledger schema supports trades, transfers and staking rows.'
  }),
  schemaCompatibleCsvSource({
    id: 'kucoin',
    label: 'KuCoin',
    monogram: 'KC',
    reportType: 'trade/order history',
    expectedColumns: 'time, tradeId, symbol, side, price, size, funds, fee, feeCurrency'
  }),
  schemaCompatibleCsvSource({
    id: 'cryptocom',
    label: 'Crypto.com',
    monogram: 'CC',
    reportType: 'transaction history',
    expectedColumns: 'Timestamp (UTC), Transaction Kind, Transaction Description, Currency, Amount, Native Amount, Native Currency, Transaction Hash',
    coverageNote: 'The transaction-history schema supports deposits, withdrawals, purchases, sales, exchanges and supported reward kinds.'
  }),
  schemaCompatibleCsvSource({
    id: 'bybit',
    label: 'Bybit',
    monogram: 'BY',
    reportType: 'trade/order history',
    expectedColumns: 'Time, Symbol, Side, Volume, Price, Total, Fee, Fee Currency, Order ID',
    coverageNote: 'This parser covers buy and sell fills in the matching order-history schema; it does not claim deposit or withdrawal coverage.'
  }),
  schemaCompatibleCsvSource({
    id: 'okx',
    label: 'OKX',
    monogram: 'OK',
    reportType: 'fills/order history',
    expectedColumns: 'time, type, pair, side, fillSz, fillPx, fee, feeCcy, ordId'
  }),
  schemaCompatibleCsvSource({
    id: 'gateio',
    label: 'Gate.io',
    monogram: 'GT',
    reportType: 'trade history',
    expectedColumns: 'ID, Time, Pair, Type, Amount, Fee, Fee Currency, Total'
  }),
  schemaCompatibleCsvSource({
    id: 'bitfinex',
    label: 'Bitfinex',
    monogram: 'BF',
    reportType: 'trade history',
    expectedColumns: '#, Date, Pair, Amount, Price, Fee, Fee Currency'
  }),
  schemaCompatibleCsvSource({
    id: 'gemini',
    label: 'Gemini',
    monogram: 'GM',
    reportType: 'transaction history',
    expectedColumns: 'Date, Time (UTC), Type, Symbol, Quantity, Price, Fee, Total'
  }),
  schemaCompatibleCsvSource({
    id: 'htx',
    label: 'HTX',
    monogram: 'HX',
    reportType: 'order history',
    expectedColumns: 'time, id, symbol, type, amount, price, filled, fee, fee-asset, order-id'
  }),
  schemaCompatibleCsvSource({
    id: 'coinspot',
    label: 'CoinSpot',
    monogram: 'CS',
    reportType: 'transaction history',
    expectedColumns: 'Date, Action, Coin, Amount, Rate, AUD, AUD Fee',
    coverageNote: 'The matching CoinSpot schema supports buys, sells, deposits, withdrawals, sends and receives with AUD values.'
  }),
  {
    id: 'hyperliquid',
    label: 'Hyperliquid',
    monogram: 'HL',
    formatHint: 'Two CSV reports · schema-compatible beta',
    region: 'global',
    steps: [
      'Export the Hyperliquid Trade History CSV for perpetual fills, fees and closed PnL.',
      'Separately export the Deposits / Withdrawals CSV for collateral movements.',
      'Trade History expects time, coin, dir, px, sz and closedPnl; Deposits / Withdrawals expects time, action, accountValueChange and source or destination.',
      'Drop both files together for complete supported derivative and collateral history; each file is detected independently.'
    ],
    path: ['Trade History CSV', 'Deposits / Withdrawals CSV', 'Schema-compatible beta'],
    note: 'Trade History alone does not include collateral deposits and withdrawals. Import both supported files for complete derivative/collateral coverage.'
  },
  {
    id: 'other',
    label: 'Other / any exchange',
    monogram: 'OT',
    formatHint: 'Any CSV / Excel',
    region: 'global',
    steps: [
      'In your exchange, open the reports/statements section.',
      'Export your Trade History as CSV or Excel.',
      'Also export your Deposits & Withdrawals history if available.',
      'Drop the file(s) into the next step — we read the columns automatically.'
    ],
    path: ['Reports', 'Statements', 'CSV / XLSX'],
    note: "Works with most CSV/Excel exports; if a file can't be read we'll tell you exactly what to fix."
  }
];

export function getImportSource(id: string | null): ImportSource | undefined {
  if (!id) return undefined;
  return IMPORT_SOURCES.find((s) => s.id === id);
}
