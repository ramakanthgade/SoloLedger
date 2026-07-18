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
    formatHint: 'CSV export',
    region: 'global',
    steps: [
      'Open Binance on the web and go to Wallet → Transaction History.',
      'Use Export Transaction History for the full ledger (recommended).',
      'Choose the CSV format and generate the report.',
      'Download the CSV and drop it into the next step.'
    ],
    path: ['Wallet', 'Transaction History', 'Export', 'CSV'],
    note: 'The full ledger export covers trades, deposits and withdrawals in one file.'
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
