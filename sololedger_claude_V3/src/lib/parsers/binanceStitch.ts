import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeTimestamp } from './types';
import { quoteToFiatCurrency } from './pairUtils';

const STABLECOINS = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'DAI', 'USD', 'EUR', 'GBP']);

export interface BinanceLedgerRow {
  index: number;
  timestamp: number;
  account: string;
  operation: string;
  coin: string;
  change: number;
  remark?: string;
  raw: Record<string, string>;
}

function col(row: Record<string, string>, ...keys: string[]): string {
  const lower = Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), v]));
  for (const k of keys) {
    const hit = lower[k.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (hit != null && hit !== '') return hit;
  }
  return '';
}

/** Order / trade id from the raw row, if the export includes one. */
function orderId(r: BinanceLedgerRow): string {
  return col(r.raw, 'orderid', 'orderno', 'ordernumber', 'tradeid', 'txid', 'transactionid').trim();
}

export function normalizeBinanceLedgerRows(rows: Record<string, string>[]): BinanceLedgerRow[] {
  const out: BinanceLedgerRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const operation = col(row, 'operation').trim();
    const coin = col(row, 'coin').trim().toUpperCase();
    const changeRaw = col(row, 'change');
    const change = safeNumberSigned(changeRaw);
    const timestamp = safeTimestamp(col(row, 'utctime', 'time', 'datetime'));
    const account = col(row, 'account').trim() || 'Spot';

    if (!operation || !coin || !Number.isFinite(timestamp) || change === 0) continue;

    out.push({
      index: i,
      timestamp,
      account,
      operation,
      coin,
      change,
      remark: col(row, 'remark') || undefined,
      raw: row
    });
  }
  return out;
}

function safeNumberSigned(v: string): number {
  const s = String(v).replace(/[,$\s]/g, '').trim();
  const m = s.match(/^(-?[\d.]+)/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Group key for Binance Transaction-History rows.
 *
 * When the export carries an order/trade id we append it as a per-fill
 * discriminator so distinct orders that happen to share the same
 * second-granular timestamp are NOT collapsed into one group (previously
 * `timestamp|account` alone merged high-frequency same-second fills, which
 * `pairByAmount` then mispaired). Without an order id we fall back to
 * `timestamp|account` and rely on id/composite-keyed pairing inside the group.
 */
function groupKey(r: BinanceLedgerRow): string {
  const oid = orderId(r);
  return oid ? `${r.timestamp}|${r.account}|oid:${oid}` : `${r.timestamp}|${r.account}`;
}

/** Composite fill key used to pair legs when no explicit order id is present. */
function compositeFillKey(r: BinanceLedgerRow): string {
  return `${r.timestamp}|${r.account}|${(r.remark ?? '').trim().toLowerCase()}`;
}

function isStable(coin: string): boolean {
  return STABLECOINS.has(coin.toUpperCase());
}

function fiatFromCoin(coin: string): string {
  return quoteToFiatCurrency(coin) ?? 'USD';
}

function makeTx(
  partial: Omit<Transaction, 'id' | 'source' | 'flags' | 'isInternalTransfer' | 'fiatCurrency'> & {
    fiatCurrency?: string;
    flags?: Transaction['flags'];
    isInternalTransfer?: boolean;
  }
): Transaction {
  const fiatCurrency = partial.fiatCurrency ?? 'USD';
  const flags = partial.flags ?? (partial.fiatValue != null && partial.fiatValue > 0 ? [] : ['missing_cost_basis']);
  return {
    ...partial,
    id: makeId('bn'),
    source: 'binance',
    flags,
    isInternalTransfer: partial.isInternalTransfer ?? false,
    fiatCurrency
  };
}

interface Leg {
  row: BinanceLedgerRow;
  amount: number;
}

/**
 * Pair trade legs by order/trade id (preferred), falling back to a composite
 * `timestamp|account|remark` key, then to stable input order. Replaces the old
 * `pairByAmount`, which sorted both sides by magnitude and zipped them — that
 * mispaired whenever multiple fills shared a timestamp or when fee/rounding
 * made magnitudes cross. Each right leg is consumed at most once.
 */
function pairLegs<T extends Leg>(
  left: T[],
  right: Leg[]
): (T & { pairedAmount?: number; pairedRow?: BinanceLedgerRow })[] {
  const usedRight = new Set<number>(); // index into `right`
  const byOrder = new Map<string, number[]>();
  const byComposite = new Map<string, number[]>();

  right.forEach((leg, i) => {
    const oid = orderId(leg.row);
    if (oid) {
      const list = byOrder.get(oid) ?? [];
      list.push(i);
      byOrder.set(oid, list);
    }
    const ck = compositeFillKey(leg.row);
    const clist = byComposite.get(ck) ?? [];
    clist.push(i);
    byComposite.set(ck, clist);
  });

  const takeFrom = (list: number[] | undefined): number | undefined => {
    if (!list) return undefined;
    for (const idx of list) {
      if (!usedRight.has(idx)) return idx;
    }
    return undefined;
  };

  return left.map((item) => {
    const oid = orderId(item.row);
    let matchIdx =
      (oid ? takeFrom(byOrder.get(oid)) : undefined) ??
      takeFrom(byComposite.get(compositeFillKey(item.row)));

    // Final fallback: next unused right leg in stable input order.
    if (matchIdx == null) {
      for (let i = 0; i < right.length; i++) {
        if (!usedRight.has(i)) {
          matchIdx = i;
          break;
        }
      }
    }

    if (matchIdx == null) return { ...item, pairedAmount: undefined, pairedRow: undefined };
    usedRight.add(matchIdx);
    return { ...item, pairedAmount: right[matchIdx].amount, pairedRow: right[matchIdx].row };
  });
}

/** Stitch spot buys: Transaction Buy + Spend + Fee → one buy row with fiat cost. */
function stitchBuys(rows: BinanceLedgerRow[]): Transaction[] {
  const buys = rows.filter((r) => r.operation.toLowerCase() === 'transaction buy');
  const spends = rows.filter((r) => r.operation.toLowerCase() === 'transaction spend' && r.change < 0);
  const fees = rows.filter((r) => r.operation.toLowerCase() === 'transaction fee' && r.change < 0);

  if (buys.length === 0) return [];

  const cryptoSpends = spends.filter((s) => !isStable(s.coin));
  if (cryptoSpends.length > 0) {
    return stitchCryptoTrades(buys, cryptoSpends, fees);
  }

  const stableSpends = spends.filter((s) => isStable(s.coin));
  const buyLegs = buys.map((b) => ({ row: b, amount: Math.abs(b.change) }));
  const spendLegs = stableSpends.map((s) => ({ row: s, amount: Math.abs(s.change) }));
  const paired = pairLegs(buyLegs, spendLegs);

  const feeByAsset = new Map<string, BinanceLedgerRow[]>();
  for (const f of fees) {
    const list = feeByAsset.get(f.coin) ?? [];
    list.push(f);
    feeByAsset.set(f.coin, list);
  }
  for (const list of feeByAsset.values()) list.sort((a, b) => Math.abs(a.change) - Math.abs(b.change));

  const usedFees = new Set<number>();

  return paired.map(({ row: buy, amount, pairedAmount, pairedRow }) => {
    const spendRow = pairedRow;
    const feeCandidates = (feeByAsset.get(buy.coin) ?? []).filter((f) => !usedFees.has(f.index));
    const feeRow = feeCandidates[0];
    if (feeRow) usedFees.add(feeRow.index);

    const fiatValue = pairedAmount ?? (spendRow ? Math.abs(spendRow.change) : undefined);
    const quote = spendRow?.coin;

    return makeTx({
      timestamp: buy.timestamp,
      type: 'buy',
      asset: buy.coin,
      amount,
      fiatValue,
      fiatCurrency: quote ? fiatFromCoin(quote) : 'USD',
      counterAsset: quote,
      counterAmount: fiatValue,
      feeAmount: feeRow ? Math.abs(feeRow.change) : undefined,
      feeAsset: feeRow?.coin,
      sourceRef: exchangeSourceRef('binance', buy.timestamp, 'buy', buy.coin, amount),
      notes: buy.remark,
      raw: { buy: buy.raw, spend: spendRow?.raw, fee: feeRow?.raw }
    });
  });
}

/** Crypto-for-crypto: Transaction Buy + Transaction Spend (non-stable). */
function stitchCryptoTrades(
  buys: BinanceLedgerRow[],
  spends: BinanceLedgerRow[],
  fees: BinanceLedgerRow[]
): Transaction[] {
  const buyLegs = buys.map((b) => ({ row: b, amount: Math.abs(b.change) }));
  const spendLegs = spends.map((s) => ({ row: s, amount: Math.abs(s.change) }));
  const paired = pairLegs(buyLegs, spendLegs);

  // Consume each fee row at most once (previously `fees.find(...)` could reuse
  // the same fee row for multiple trades in the group).
  const usedFees = new Set<number>();

  return paired.map(({ row: buy, amount, pairedRow }) => {
    const spendRow = pairedRow;
    // Prefer a fee whose coin matches one of the trade legs; otherwise consume
    // any remaining group fee (Binance commonly charges crypto-for-crypto fees
    // in a third asset, e.g. BNB, that matches neither leg). `usedFees` still
    // guarantees each fee row is attached to at most one trade.
    const feeRow =
      fees.find(
        (f) => !usedFees.has(f.index) && (f.coin === buy.coin || f.coin === spendRow?.coin)
      ) ?? fees.find((f) => !usedFees.has(f.index));
    if (feeRow) usedFees.add(feeRow.index);

    return makeTx({
      timestamp: buy.timestamp,
      type: 'trade',
      asset: spendRow?.coin ?? buy.coin,
      amount: spendRow ? Math.abs(spendRow.change) : amount,
      counterAsset: buy.coin,
      counterAmount: amount,
      feeAmount: feeRow ? Math.abs(feeRow.change) : undefined,
      feeAsset: feeRow?.coin,
      sourceRef: exchangeSourceRef('binance', buy.timestamp, 'trade', buy.coin, amount),
      notes: 'Crypto-for-crypto trade',
      raw: { buy: buy.raw, spend: spendRow?.raw }
    });
  });
}

/** Stitch spot sells: Transaction Sold + Revenue + Fee → one sell row with proceeds. */
function stitchSells(rows: BinanceLedgerRow[]): Transaction[] {
  const solds = rows.filter((r) => r.operation.toLowerCase() === 'transaction sold');
  const revenues = rows.filter((r) => r.operation.toLowerCase() === 'transaction revenue' && r.change > 0);
  const fees = rows.filter((r) => r.operation.toLowerCase() === 'transaction fee' && r.change < 0);

  if (solds.length === 0) return [];

  const soldLegs = solds.map((s) => ({ row: s, amount: Math.abs(s.change) }));
  const revLegs = revenues.map((r) => ({ row: r, amount: Math.abs(r.change) }));
  const paired = pairLegs(soldLegs, revLegs);

  const stableFees = fees.filter((f) => isStable(f.coin));
  stableFees.sort((a, b) => Math.abs(a.change) - Math.abs(b.change));
  const usedFees = new Set<number>();

  return paired.map(({ row: sold, amount, pairedAmount, pairedRow }) => {
    const revRow = pairedRow;
    const feeRow = stableFees.find((f) => !usedFees.has(f.index));
    if (feeRow) usedFees.add(feeRow.index);

    const fiatValue = pairedAmount ?? (revRow ? Math.abs(revRow.change) : undefined);
    const quote = revRow?.coin;

    return makeTx({
      timestamp: sold.timestamp,
      type: 'sell',
      asset: sold.coin,
      amount,
      fiatValue,
      fiatCurrency: quote ? fiatFromCoin(quote) : 'USD',
      counterAsset: quote,
      counterAmount: fiatValue,
      feeAmount: feeRow ? Math.abs(feeRow.change) : undefined,
      feeAsset: feeRow?.coin,
      sourceRef: exchangeSourceRef('binance', sold.timestamp, 'sell', sold.coin, amount),
      notes: sold.remark,
      raw: { sold: sold.raw, revenue: revRow?.raw, fee: feeRow?.raw }
    });
  });
}

function stitchConverts(rows: BinanceLedgerRow[]): Transaction[] {
  const converts = rows.filter((r) => r.operation.toLowerCase() === 'binance convert');
  if (converts.length < 2) return [];

  const outs = converts.filter((r) => r.change < 0);
  const ins = converts.filter((r) => r.change > 0);
  const outLegs = outs.map((o) => ({ row: o, amount: Math.abs(o.change) }));
  const inLegs = ins.map((i) => ({ row: i, amount: Math.abs(i.change) }));
  const paired = pairLegs(outLegs, inLegs);

  return paired.map(({ row: out, amount, pairedAmount, pairedRow }) => {
    const inRow = pairedRow;
    return makeTx({
      timestamp: out.timestamp,
      type: 'trade',
      asset: out.coin,
      amount,
      counterAsset: inRow?.coin,
      counterAmount: inRow ? Math.abs(inRow.change) : pairedAmount,
      sourceRef: exchangeSourceRef('binance', out.timestamp, 'trade', out.coin, amount),
      notes: 'Binance Convert',
      flags: ['missing_cost_basis'],
      raw: { out: out.raw, in: inRow?.raw }
    });
  });
}

function stitchInternalTransfers(rows: BinanceLedgerRow[]): Transaction[] {
  const transfers = rows.filter((r) =>
    r.operation.toLowerCase().includes('transfer between')
  );
  if (transfers.length === 0) return [];

  return transfers.map((r) =>
    makeTx({
      timestamp: r.timestamp,
      type: r.change > 0 ? 'transfer_in' : 'transfer_out',
      asset: r.coin,
      amount: Math.abs(r.change),
      sourceRef: exchangeSourceRef(
        'binance',
        r.timestamp,
        r.change > 0 ? 'transfer_in' : 'transfer_out',
        r.coin,
        Math.abs(r.change)
      ),
      notes: r.operation,
      flags: ['possible_internal_transfer'],
      isInternalTransfer: false,
      raw: r.raw
    })
  );
}

const INCOME_OPS = new Set([
  'staking rewards',
  'pos savings interest',
  'savings interest',
  'commission history',
  'distribution',
  'cash voucher distribution',
  'airdrop',
  'referral commission',
  'launchpool interest'
]);

function isP2pOperation(operation: string): boolean {
  return operation.toLowerCase().includes('p2p');
}

/** Remark field sometimes references P2P when operation is Withdraw. */
function isP2pRemark(remark?: string): boolean {
  return !!remark && /\bp2p\b/i.test(remark);
}

/**
 * Binance P2P trades with a counterparty are taxable buy/sell events, not wallet
 * transfers. User can still mark any row as internal transfer in Review.
 * - Incoming crypto (funding / buy side) → buy (opens a cost-basis lot)
 * - Outgoing crypto (sell side) → sell (taxable disposal in capital gains)
 */
function stitchP2pRows(rows: BinanceLedgerRow[]): Transaction[] {
  const out: Transaction[] = [];

  for (const r of rows) {
    const op = r.operation.toLowerCase();
    const amount = Math.abs(r.change);
    const isP2p = isP2pOperation(op) || (op === 'withdraw' && isP2pRemark(r.remark));
    if (!isP2p) continue;

    const type: TxType = r.change > 0 ? 'buy' : 'sell';
    out.push(
      makeTx({
        timestamp: r.timestamp,
        type,
        asset: r.coin,
        amount,
        sourceRef: exchangeSourceRef('binance', r.timestamp, type, r.coin, amount),
        notes: r.remark ? `P2P: ${r.remark}` : 'P2P trading',
        flags: ['missing_cost_basis'],
        category: 'p2p',
        raw: r.raw
      })
    );
  }

  return out;
}

function stitchSimpleRows(rows: BinanceLedgerRow[]): Transaction[] {
  const out: Transaction[] = [];
  const tradeOps = new Set([
    'transaction buy',
    'transaction sold',
    'transaction spend',
    'transaction revenue',
    'transaction fee',
    'binance convert'
  ]);

  for (const r of rows) {
    const op = r.operation.toLowerCase();
    if (tradeOps.has(op) || op.includes('transfer between') || isP2pOperation(op)) continue;
    if (op === 'withdraw' && isP2pRemark(r.remark)) continue;

    let type: TxType | null = null;
    if (op === 'deposit') type = 'transfer_in';
    else if (op === 'withdraw') type = 'transfer_out';
    else if (INCOME_OPS.has(op)) type = 'income';
    else if (op === 'fee') type = 'fee';
    else if (op === 'transfer') type = r.change > 0 ? 'transfer_in' : 'transfer_out';
    else continue;

    const amount = Math.abs(r.change);
    const flags: Transaction['flags'] =
      type === 'transfer_in' || type === 'transfer_out'
        ? ['possible_internal_transfer']
        : type === 'income'
          ? ['missing_cost_basis']
          : ['missing_cost_basis'];

    out.push(
      makeTx({
        timestamp: r.timestamp,
        type,
        asset: r.coin,
        amount,
        sourceRef: exchangeSourceRef('binance', r.timestamp, type, r.coin, amount),
        notes: r.remark || r.operation,
        flags,
        raw: r.raw
      })
    );
  }
  return out;
}

/**
 * Group Binance Transaction History ledger rows by timestamp+account, then stitch
 * multi-leg spot trades (Buy+Spend+Fee, Sold+Revenue+Fee) into single Review rows.
 */
export function stitchBinanceTransactionHistory(rows: Record<string, string>[]): {
  transactions: Transaction[];
  skippedRows: number;
  warnings: string[];
} {
  const normalized = normalizeBinanceLedgerRows(rows);
  const skippedRows = rows.length - normalized.length;
  const warnings: string[] = [];

  const groups = new Map<string, BinanceLedgerRow[]>();
  for (const r of normalized) {
    const k = groupKey(r);
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }

  const transactions: Transaction[] = [];
  for (const group of groups.values()) {
    transactions.push(
      ...stitchBuys(group),
      ...stitchSells(group),
      ...stitchConverts(group),
      ...stitchInternalTransfers(group),
      ...stitchP2pRows(group),
      ...stitchSimpleRows(group)
    );
  }

  transactions.sort((a, b) => a.timestamp - b.timestamp);

  const withFiat = transactions.filter((t) => t.fiatValue != null && t.fiatValue > 0).length;
  const buysSells = transactions.filter((t) => t.type === 'buy' || t.type === 'sell').length;

  if (skippedRows > 0) {
    warnings.push(`${skippedRows} row(s) skipped — missing time, coin, or amount.`);
  }
  if (buysSells > 0) {
    warnings.push(
      `Stitched ${buysSells} spot trade(s) from ledger rows — ${withFiat} include USDT/fiat value for cost basis.`
    );
  }
  const deposits = transactions.filter((t) => t.type === 'transfer_in').length;
  const withdrawals = transactions.filter((t) => t.type === 'transfer_out').length;
  const p2pTrades = transactions.filter((t) => t.category === 'p2p').length;
  if (p2pTrades > 0) {
    const p2pSells = transactions.filter((t) => t.category === 'p2p' && t.type === 'sell').length;
    const p2pBuys = transactions.filter((t) => t.category === 'p2p' && t.type === 'buy').length;
    warnings.push(
      `${p2pTrades} P2P trade(s) classified as buy/sell (${p2pBuys} buy, ${p2pSells} sell) — included in capital gains unless you mark internal transfer in Review.`
    );
  }
  if (deposits + withdrawals > 0) {
    warnings.push(
      `${deposits} deposit(s) and ${withdrawals} withdrawal(s) imported — mark internal transfers in Review if moving between your own wallets.`
    );
  }

  return { transactions, skippedRows, warnings };
}
