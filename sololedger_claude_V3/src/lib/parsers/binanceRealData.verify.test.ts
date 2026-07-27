/**
 * AD-HOC verification: run the REAL 28,928-row Binance Transaction History CSV
 * through the production stitchBinanceTransactionHistory parser, and validate
 * the output against the Trade History + Deposit + Withdrawal CSV ground truth.
 *
 * Answers: does the existing full-ledger stitcher correctly ingest the real
 * export, and how does its trade/transfer output compare to the clean files?
 *
 * Run: npx vitest run src/lib/parsers/binanceRealData.verify.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { stitchBinanceTransactionHistory } from './binanceStitch';

const DIR = 'C:/Users/ramak/.hermes/desktop-attachments';
const LEDGER = `${DIR}/Ram_Binance-Transaction-History-Jan 01 2017_July 27 2026.csv`;
const TRADES = `${DIR}/Ram_Binance-Spot-Trade-History-Jan 01 2017_July 27 2026.csv`;
const DEPS = `${DIR}/Ram_Binance-Deposit-History-Jan 01 2017_July 27 2026.csv`;
const WDS = `${DIR}/Ram_Binance-Withdraw-History-Jan 01 2017_July 27 2026.csv`;

function parseCsv(file: string): Record<string, string>[] {
  const txt = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    const o: Record<string, string> = {};
    head.forEach((h, i) => (o[h] = (c[i] ?? '').trim()));
    return o;
  });
}

describe('REAL Binance Transaction History through the production stitcher', () => {
  it('ingests the full 28,928-row ledger and reports coverage vs ground truth', () => {
    const ledgerRows = parseCsv(LEDGER);
    const { transactions, skippedRows, warnings } = stitchBinanceTransactionHistory(ledgerRows);

    // Ground truth counts
    const tradeCount = parseCsv(TRADES).length;      // 9289
    const depCount = parseCsv(DEPS).length;          // 225
    const wdCount = parseCsv(WDS).length;            // 277

    const buys = transactions.filter((t) => t.type === 'buy').length;
    const sells = transactions.filter((t) => t.type === 'sell').length;
    const trades = transactions.filter((t) => t.type === 'trade').length;
    const tin = transactions.filter((t) => t.type === 'transfer_in').length;
    const tout = transactions.filter((t) => t.type === 'transfer_out').length;
    const income = transactions.filter((t) => t.type === 'income').length;
    const withFiat = transactions.filter((t) => t.fiatValue != null && t.fiatValue > 0).length;

    console.log('\n================ REAL-DATA STITCH REPORT ================');
    console.log('Ledger rows in:', ledgerRows.length, '| skipped:', skippedRows);
    console.log('Transactions out:', transactions.length);
    console.log(`  buy=${buys} sell=${sells} trade=${trades} (stitched spot trades=${buys + sells})`);
    console.log(`  transfer_in=${tin} transfer_out=${tout} income=${income}`);
    console.log(`  with fiat value: ${withFiat}`);
    console.log('\n--- vs ground truth ---');
    const tradeRowsTotal = buys + sells + trades;
    console.log(`Spot trades: stitched=${tradeRowsTotal} (buy=${buys} sell=${sells} trade=${trades}) vs TradeHistoryCSV=${tradeCount}  (${Math.round(100 * tradeRowsTotal / tradeCount)}%)`);
    console.log(`Deposits:    stitched=${tin} vs DepositCSV=${depCount}`);
    console.log(`Withdrawals: stitched=${tout} vs WithdrawCSV=${wdCount}`);
    console.log('\n--- stitcher warnings ---');
    for (const w of warnings) console.log('  •', w);

    // Per-asset trade coverage vs Trade History CSV
    const csvByBase: Record<string, number> = {};
    for (const r of parseCsv(TRADES)) {
      const pair = r.Pair;
      const base = pair.replace(/(USDT|USDC|BUSD|FDUSD|TUSD|DAI|BTC|ETH|BNB|USD|EUR|TRY|INR)$/, '');
      csvByBase[base] = (csvByBase[base] || 0) + 1;
    }
    const stitchedByAsset: Record<string, number> = {};
    for (const t of transactions) {
      if (t.type === 'buy' || t.type === 'sell' || t.type === 'trade') {
        stitchedByAsset[t.asset] = (stitchedByAsset[t.asset] || 0) + 1;
        // A crypto-for-crypto trade acquires the counterAsset too — count it so
        // assets only ever received (never the spent leg) still register.
        if (t.counterAsset) stitchedByAsset[t.counterAsset] = (stitchedByAsset[t.counterAsset] || 0) + 1;
      }
    }
    console.log('\n--- per-asset stitched trades vs Trade History CSV ---');
    const assets = [...new Set([...Object.keys(csvByBase), ...Object.keys(stitchedByAsset)])].sort();
    for (const a of assets) {
      const csv = csvByBase[a] || 0, st = stitchedByAsset[a] || 0;
      const flag = csv > 0 && st < csv ? '  <-- GAP' : '';
      console.log(`  ${a.padEnd(8)} csv=${String(csv).padStart(5)} stitched=${String(st).padStart(5)}${flag}`);
    }

    // Hard assertions (so the test has teeth but doesn't fail on informational gaps)
    expect(ledgerRows.length).toBeGreaterThan(28000);
    expect(transactions.length).toBeGreaterThan(0);
    expect(skippedRows).toBeLessThan(ledgerRows.length * 0.05); // <5% skipped
  }, 30000);
});
