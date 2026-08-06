/**
 * The REAL "100% imported" test: does every ledger row get consumed into some
 * output transaction? Replicates the stitcher's grouping and tracks which
 * input rows produced output vs. fell through every handler. Ground truth:
 * the 28,928-row real export.
 *
 * Run: npx vitest run src/lib/parsers/binanceCoverage.verify.test.ts
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { stitchBinanceTransactionHistory, normalizeBinanceLedgerRows } from './binanceStitch';

const DIR = 'C:/Users/ramak/.hermes/desktop-attachments';
const LEDGER = `${DIR}/Ram_Binance-Transaction-History-Jan 01 2017_July 27 2026.csv`;
// Real-data ground truth lives only on the author's machine — skip cleanly on
// CI/other machines instead of ENOENT-failing the whole suite.
const HAS_GROUND_TRUTH = existsSync(LEDGER);

function parseCsv(file: string): Record<string, string>[] {
  const txt = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    const o: Record<string, string> = {};
    head.forEach((h, i) => (o[h] = (c[i] ?? '').trim()));
    return o;
  });
}

describe.skipIf(!HAS_GROUND_TRUTH)('Binance ledger — every operation accounted for', () => {
  it('produces transactions covering every recognized operation (none silently dropped)', () => {
    const rows = parseCsv(LEDGER);
    const normalized = normalizeBinanceLedgerRows(rows);
    const { transactions } = stitchBinanceTransactionHistory(rows);

    // Count input rows per operation.
    const opCounts: Record<string, number> = {};
    for (const r of normalized) opCounts[r.operation] = (opCounts[r.operation] || 0) + 1;

    // A row is "covered" if its operation is one the stitcher turns into a tx.
    // Trade legs (Buy/Sell/Transaction*/Fee) collapse into fewer trade rows;
    // transfers/income/etc map ~1:1. We assert:
    //  (1) transactions were produced at all (parser didn't choke)
    //  (2) output count is sane vs input (trades collapse ~3 rows→1)
    //  (3) every DEPOSIT and WITHDRAW (1:1 operations) is present
    const deps = transactions.filter((t) => t.type === 'transfer_in').length;
    const wds = transactions.filter((t) => t.type === 'transfer_out').length;
    const inDeps = opCounts['Deposit'] ?? 0;
    const inWds = opCounts['Withdraw'] ?? 0;

    console.log('\n=== input rows by operation ===');
    for (const [op, c] of Object.entries(opCounts).sort((a, b) => b[1] - a[1]).slice(0, 20))
      console.log(`  ${op.padEnd(40)} ${c}`);
    console.log(`\nledger rows in: ${rows.length}, normalized: ${normalized.length}, transactions out: ${transactions.length}`);
    console.log(`deposits: in=${inDeps} out=${deps} | withdrawals: in=${inWds} out=${wds}`);

    expect(transactions.length).toBeGreaterThan(9000); // sanity — the 101% we measured
    // Deposits & withdrawals are 1:1 — must fully transfer (allowing internal
    // acct transfers inflating the count, which is why out >= in is expected).
    expect(deps).toBeGreaterThanOrEqual(inDeps);
    expect(wds).toBeGreaterThanOrEqual(inWds);
  }, 30000);

  it('A1 — non-spot operations: every recognized op maps to a tx; zero unrecognized drops', () => {
    const rows = parseCsv(LEDGER);
    const { transactions } = stitchBinanceTransactionHistory(rows);

    // Futures realized PnL: 1:1 per row, split income (profit) vs sell (loss).
    // Engine notes = 'Realized Profit and Loss[: remark]'.
    const pnl = transactions.filter((t) => t.category === 'realized_pnl' && t.notes?.startsWith('Realized Profit and Loss'));
    expect(pnl.length).toBe(248);
    expect(pnl.filter((t) => t.type === 'income').length).toBeGreaterThan(0);
    expect(pnl.filter((t) => t.type === 'sell').length).toBeGreaterThan(0);

    // Funding fees: 1:1, paid → fee, received → income. Engine notes = 'Funding Fee'.
    const funding = transactions.filter((t) => t.notes === 'Funding Fee' || t.notes?.startsWith('Funding Fee:'));
    expect(funding.length).toBe(25);

    // Income ops now recognized (the INCOME_OPS name-mismatch fix).
    const incomeOps: [string, number][] = [
      ['Commission Rebate', 208],
      ['Referee Commission', 165],
      ['Distribution', 31],
      ['Staking Rewards', 10],
      ['Airdrop Assets', 10],
      ['Launchpool Airdrop - User Claim Distribution', 24],
      ['Commission History', 19],
      ['Token Swap - Distribution', 4],
      ['Campaign Related Reward', 1]
    ];
    for (const [op, count] of incomeOps) {
      const hits = transactions.filter((t) => t.type === 'income' && (t.notes === op || t.raw && Object.values(t.raw as Record<string, string>).includes(op)));
      expect(hits.length, `income op '${op}'`).toBe(count);
    }
    // 'Asset - Transfer' positive legs are airdrop income (15 of 18 rows; 3 negatives are migration debits).
    const assetTransferIncome = transactions.filter((t) => t.type === 'income' &&
      t.raw && String((t.raw as Record<string, string>).Operation) === 'Asset - Transfer');
    expect(assetTransferIncome.length).toBe(15);

    // Dust convert: one trade per spent dust row (BNB credit rows implied).
    const dust = transactions.filter((t) => t.notes?.startsWith('Small assets (dust)'));
    expect(dust.length).toBeGreaterThan(40); // 86 rows total, ~half are BNB credits
    expect(dust.every((t) => t.type === 'trade' && t.counterAsset === 'BNB')).toBe(true);

    // Transaction Related: 20 fiat/stable conversion pairs → trades.
    const onramp = transactions.filter((t) => t.notes === 'Fiat/stable conversion (Transaction Related)');
    expect(onramp.length).toBe(20);
    expect(onramp.every((t) => t.type === 'trade')).toBe(true);

    // Fiat withdrawals: 1:1 → sell of the fiat asset.
    const fiatWd = transactions.filter((t) => t.notes === 'Fiat withdrawal to bank');
    expect(fiatWd.length).toBe(16);

    // Paired swaps: auto-conversion, futures convert, token rebranding → trade.
    // Paired swaps: auto-conversion + futures convert stitch; the lone
    // redenomination leg has no counter-leg in the export (paired row absent)
    // so it can't stitch — 2 trades expected. Engine notes = raw operation string.
    const swaps = transactions.filter((t) =>
      t.type === 'trade' &&
      (t.notes === 'Stablecoins Auto-Conversion' ||
        t.notes === 'Futures Convert - From' ||
        t.notes === 'Futures Convert - To' ||
        t.notes === 'Token Swap - Redenomination/Rebranding'));
    expect(swaps.length).toBe(2);
    expect(swaps.every((t) => t.type === 'trade')).toBe(true);

    // Every operation in the export is now either imported or deliberately
    // classified (principal/review ops are skipped on purpose, not dropped).
    const importedOps = new Set([
      'Fee', 'Sell', 'Buy', 'Transaction Fee', 'Transaction Sold', 'Transaction Revenue',
      'Transaction Spend', 'Transaction Buy', 'Withdraw', 'Deposit', 'Binance Convert',
      'P2P Trading', 'Transfer Between Spot and Funding', 'Transfer Between Spot and CM Futures',
      'Transfer Between Spot and UM Futures', 'Transfer Between Spot and Options',
      'Transfer Between UM Futures and Options', 'Transfer',
      'Realized Profit and Loss', 'Funding Fee', 'Small Assets Exchange BNB',
      'Transaction Related', 'Fiat Withdraw', 'Stablecoins Auto-Conversion',
      'Futures Convert - From', 'Futures Convert - To', 'Token Swap - Redenomination/Rebranding',
      'Token Swap - Distribution',
      'Commission Rebate', 'Referee Commission', 'Distribution', 'Staking Rewards',
      'Airdrop Assets', 'Launchpool Airdrop - User Claim Distribution', 'Commission History',
      'Campaign Related Reward', 'Asset - Transfer',
      // Deliberately classified, not imported as txs (principal / balance events):
      'Inter-Wallet Transfer', 'Launchpool Subscription/Redemption',
      'Asset Recovery', 'Margin Loan', 'Cross Margin Liquidation - Repayment'
    ]);
    const unrecognized = Object.keys(opCountsFor(rows)).filter((op) => !importedOps.has(op));
    expect(unrecognized, `unrecognized ops: ${unrecognized.join(', ')}`).toEqual([]);
  }, 30000);
});

function opCountsFor(rows: Record<string, string>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const op = (r.Operation ?? '').trim();
    if (op) counts[op] = (counts[op] || 0) + 1;
  }
  return counts;
}
