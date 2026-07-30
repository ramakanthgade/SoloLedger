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
import { existsSync, readFileSync } from 'node:fs';
import { stitchBinanceTransactionHistory } from './binanceStitch';

const DIR = 'C:/Users/ramak/.hermes/desktop-attachments';
const LEDGER = `${DIR}/Ram_Binance-Transaction-History-Jan 01 2017_July 27 2026.csv`;
const TRADES = `${DIR}/Ram_Binance-Spot-Trade-History-Jan 01 2017_July 27 2026.csv`;
const DEPS = `${DIR}/Ram_Binance-Deposit-History-Jan 01 2017_July 27 2026.csv`;
const WDS = `${DIR}/Ram_Binance-Withdraw-History-Jan 01 2017_July 27 2026.csv`;
// Real-data ground truth lives only on the author's machine — skip cleanly on
// CI/other machines instead of ENOENT-failing the whole suite.
const HAS_GROUND_TRUTH = existsSync(LEDGER) && existsSync(TRADES) && existsSync(DEPS) && existsSync(WDS);

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

describe.skipIf(!HAS_GROUND_TRUTH)('REAL Binance Transaction History through the production stitcher', () => {
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

  /**
   * Conservation regression: the stitched per-asset net must converge on the raw
   * ledger `Change` sum (the absolute ground truth — every row is a signed
   * balance movement). Guards the three fixes shipped for the order-less
   * stitcher:
   *   (1) sign-aware clawback (Asset Recovery subtracts, NFT +44,680 → 0);
   *   (2) cancellation-reversal netting (a +X/−X deposit pair cancels);
   *   (3) unique per-fill sourceRef (dedup must never collapse distinct fills).
   * The major phantoms are asserted to reconcile EXACTLY; the small residual
   * net≈0 op-classification edge cases are tracked but not yet zero (documented
   * long tail), so this asserts the major-phantom guarantee, not full parity.
   */
  it('conserves per-asset balances: major phantoms reconcile to raw ledger, dedup never collapses fills', () => {
    const ledgerRows = parseCsv(LEDGER);
    const { transactions } = stitchBinanceTransactionHistory(ledgerRows);

    // Raw ground truth: signed sum of Change per coin.
    const raw = new Map<string, number>();
    for (const r of ledgerRows) {
      const coin = (r.Coin ?? '').toUpperCase();
      const ch = Number(r.Change ?? '0');
      if (coin && Number.isFinite(ch)) raw.set(coin, (raw.get(coin) ?? 0) + ch);
    }

    // Net signed contribution of the stitched output to one asset.
    const netFor = (asset: string): number => {
      let d = 0;
      for (const t of transactions) {
        const a = t.asset?.toUpperCase();
        const c = t.counterAsset?.toUpperCase();
        if (a === asset) {
          if (['buy', 'transfer_in', 'income', 'gift_received'].includes(t.type)) d += t.amount;
          else if (['sell', 'transfer_out', 'fee', 'trade', 'gift_sent'].includes(t.type)) d -= t.amount;
        }
        if (c === asset && t.counterAmount) {
          if (t.type === 'sell' || t.type === 'trade') d += t.counterAmount;
          else if (t.type === 'buy') d -= t.counterAmount;
        }
      }
      return d;
    };

    // (1) The major phantoms must reconcile EXACTLY to raw. These are the
    // clawback/cancellation cases that fabricated tens of thousands of units.
    for (const asset of ['NFT', 'CELO', 'CND', 'MATIC', 'WETH', 'FLOW', 'BOND']) {
      expect(netFor(asset), `phantom ${asset} should reconcile to raw`).toBeCloseTo(raw.get(asset) ?? 0, 4);
    }

    // (2) Known-good major holdings must stay exact (no regression on the
    // assets that were already correct).
    for (const asset of ['UNI', 'ROSE', 'XPR']) {
      expect(netFor(asset), `holding ${asset} should stay exact`).toBeCloseTo(raw.get(asset) ?? 0, 4);
    }

    // (3) Dedup must NEVER collapse two distinct fills into one: every emitted
    // transaction gets a unique sourceRef. (Pre-fix, identical same-second
    // fills shared a ref and dedup merged them, driving USDT/BTC negative.)
    const refs = transactions.map((t) => t.sourceRef).filter(Boolean);
    expect(new Set(refs).size).toBe(refs.length);

    // (4) The catastrophic USDC fabrication (+436,107 pre-fix) must be reduced
    // to the small residual op-classification tail (< 1% of the pre-fix value).
    expect(Math.abs(netFor('USDC') - (raw.get('USDC') ?? 0))).toBeLessThan(5000);
  }, 30000);
});
