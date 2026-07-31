import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';
import type { CsvImportRow } from '@/lib/storage/db';
import { stitchBinanceTransactionHistory } from './binanceStitch';

const CANDIDATES = [
  process.env.BINANCE_LEDGER_CSV,
  '/code/.uploaded_artifacts/1338.csv',
  'C:/Users/ramak/.hermes/desktop-attachments/Ram_Binance-Transaction-History-Jan 01 2017_July 27 2026.csv'
].filter(Boolean) as string[];
const LEDGER = CANDIDATES.find((path) => existsSync(path));

function parseCsv(file: string): Record<string, string>[] {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const headers = lines[0].split(',').map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(headers.map((header, index) => [header, (cells[index] ?? '').trim()]));
  });
}

describe.skipIf(!LEDGER)('REAL Binance CSV holdings authority', () => {
  it('removes phantom holdings while preserving exact non-Options source quantities', () => {
    const rows = parseCsv(LEDGER!);
    const result = stitchBinanceTransactionHistory(rows);
    expect(result.optionsBalanceUnavailable).toBe(true);
    expect(result.warnings.join(' ')).toContain('current balance entry for Options');

    const batch: CsvImportRow = {
      id: 'real-binance', fileName: LEDGER!, parserId: 'binance', importedAt: 1,
      txCount: result.transactions.length, balanceSnapshot: result.balanceSnapshot,
      optionsBalanceUnavailable: result.optionsBalanceUnavailable
    };
    const transactions = result.transactions.map((tx) => ({ ...tx, importBatchId: batch.id }));
    const holdings = buildPortfolioHoldings(transactions, [batch]);
    const amount = (asset: string) => holdings.find((h) => h.asset === asset)?.amount ?? 0;

    expect(Math.abs(amount('USDT'))).toBeLessThan(1e-6);
    expect(amount('BUSD')).toBe(0);
    expect(amount('SOL')).toBeCloseTo(result.balanceSnapshot?.SOL ?? 0, 8);
    expect(amount('UNI')).toBeCloseTo(120.001444, 8);
    expect(amount('ROSE')).toBeCloseTo(11454.8, 8);
    expect(amount('RCN')).toBeCloseTo(7992, 8);
    expect(amount('XPR')).toBeCloseTo(73.90555935, 8);
    expect(amount('BNB')).toBeCloseTo(0.18313113, 8);
    expect(amount('USDC')).toBeCloseTo(0.01385116, 8);
    expect(amount('BTC')).toBeCloseTo(0.00000049, 12);
  }, 30000);
});
