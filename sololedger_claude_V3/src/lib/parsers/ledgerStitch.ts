import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeTimestampUtc } from './types';
import { quoteToFiatCurrency } from './pairUtils';

/**
 * GENERIC EXCHANGE-LEDGER STITCHING ENGINE
 * ========================================
 *
 * Exchange "full ledger" exports (Binance Transaction History, and the
 * equivalent from other CCXT exchanges) record every balance movement as one
 * row: (time, account, operation, coin, signed change). A single economic
 * event (a spot trade, a convert, a dust sweep) appears as 2-3 rows that must
 * be STITCHED back together.
 *
 * The stitching logic here is exchange-AGNOSTIC: leg pairing, group keys,
 * buy/sell/fee→trade assembly, stable-quote detection, income/fee/transfer
 * classification. The exchange-SPECIFIC part is a declarative OPERATION-MAP:
 * a table mapping operation strings → semantic roles. Supporting a new
 * exchange = writing a new operation-map, not a new stitcher.
 *
 * Deliberately NOT attempted: a universal "any CSV" reader. Column layouts and
 * operation vocabularies differ per exchange; what generalizes is the
 * stitching, what stays per-exchange is the op-map + column mapping.
 */

export const STABLECOINS = new Set([
  'USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'DAI', 'USD', 'EUR', 'GBP'
]);

export function isStable(coin: string): boolean {
  return STABLECOINS.has(coin.toUpperCase());
}

function fiatFromCoin(coin: string): string {
  return quoteToFiatCurrency(coin) ?? 'USD';
}

/** A normalized ledger row — the engine's input. */
export interface LedgerRow {
  index: number;
  timestamp: number;
  account: string;
  operation: string; // raw operation string from the export
  coin: string;
  change: number; // signed
  remark?: string;
  raw: Record<string, string>;
  /** Order/trade id extracted by the exchange's columns config (per-fill discriminator). */
  orderId?: string;
}

/**
 * Declarative per-exchange operation map. Every operation string the export
 * can contain should appear in exactly ONE list. Anything unlisted is reported
 * as unrecognized (coverage tests assert the list is complete per exchange).
 */
export interface OperationMap {
  /** Buy+Spend+Fee triplets (modern spot buys). */
  tradeBuy: string[];
  /** Sold+Revenue+Fee triplets (modern spot sells). */
  tradeSell: string[];
  /** OLD-era simple Buy/Sell/Fee trades (spent + received + fee). */
  simpleTrade: { buy: string[]; sell: string[]; fee: string[] };
  /** Shared fee op inside tradeBuy/tradeSell groups (e.g. 'Transaction Fee'). */
  tradeFee: string[];
  /** Spend legs of modern buy triplets (e.g. 'Transaction Spend'). */
  spendOps: string[];
  /** Revenue legs of modern sell triplets (e.g. 'Transaction Revenue'). */
  revenueOps: string[];
  /** Two-leg swaps (out + in): Binance Convert, auto-conversion, token rebranding. */
  convert: string[];
  /** Grouped dust sweep: all negative legs in a (timestamp, account) group → `dustConvertAsset`. */
  dustConvert?: { ops: string[]; toAsset: string };
  /** Fiat/stable conversion pairs (Binance 'Transaction Related'). */
  fiatConvert: string[];
  /** 1:1 deposits / withdrawals. */
  deposit: string[];
  withdraw: string[];
  /** 1:1 income rows (rewards, rebates, airdrops, distributions). */
  income: string[];
  /** Internal account moves → transfer_in/out flagged possible_internal_transfer. */
  internalTransfer: string[];
  /** Internal moves to EXCLUDE from import entirely (principal shuffles like Inter-Wallet Transfer). */
  internalTransferExclude?: string[];
  /** Sign-varying rows: positive → income, negative → `negativeType`. */
  signSplit?: { op: string; negativeType: TxType; category?: string; derivative?: boolean }[];
  /** Off-ramp of fiat to bank → sell with fiat value. */
  fiatWithdraw: string[];
  /**
   * Recognized but deliberately NOT imported (loan principal, subscription
   * lock/unlock, balance-only recovery events). Classified, not dropped —
   * coverage tests count these as handled.
   */
  skip: string[];
  /** P2P rows: positive → buy, negative → sell, category 'p2p'. */
  p2p?: { ops: string[]; withdrawOpsWithP2pRemark?: string[] };
}

/** Column names for the exchange's export (case/format-insensitive matching). */
export interface LedgerColumns {
  operation: string[];
  coin: string[];
  change: string[];
  time: string[];
  account?: string[];
  remark?: string[];
  orderId?: string[];
}

export interface LedgerStitchConfig {
  exchange: string; // 'binance' — used for source + sourceRef
  columns: LedgerColumns;
  ops: OperationMap;
  defaultAccount?: string;
}

function col(row: Record<string, string>, ...keys: string[]): string {
  const lower = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.toLowerCase().replace(/[^a-z0-9]/g, ''), v])
  );
  for (const k of keys) {
    const hit = lower[k.toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (hit != null && hit !== '') return hit;
  }
  return '';
}

function safeNumberSigned(v: string): number {
  const s = String(v).replace(/[,$\s]/g, '').trim();
  const m = s.match(/^(-?[\d.]+)/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

export function normalizeLedgerRows(
  rows: Record<string, string>[],
  cfg: LedgerStitchConfig
): LedgerRow[] {
  const c = cfg.columns;
  const out: LedgerRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const operation = col(row, ...c.operation).trim();
    const coin = col(row, ...c.coin).trim().toUpperCase();
    const change = safeNumberSigned(col(row, ...c.change));
    const timestamp = safeTimestampUtc(col(row, ...c.time));
    const account = (c.account ? col(row, ...c.account).trim() : '') || cfg.defaultAccount || 'Spot';

    if (!operation || !coin || !Number.isFinite(timestamp) || change === 0) continue;

    out.push({
      index: i,
      timestamp,
      account,
      operation,
      coin,
      change,
      remark: c.remark ? col(row, ...c.remark) || undefined : undefined,
      raw: row,
      orderId: c.orderId ? col(row, ...c.orderId).trim() || undefined : undefined
    });
  }
  return out;
}

/** All operation strings the map recognizes (lowercased). */
export function recognizedOps(ops: OperationMap): Set<string> {
  const s = new Set<string>();
  const add = (list?: string[]) => list?.forEach((o) => s.add(o.toLowerCase()));
  add(ops.tradeBuy);
  add(ops.tradeSell);
  add(ops.simpleTrade.buy);
  add(ops.simpleTrade.sell);
  add(ops.simpleTrade.fee);
  add(ops.tradeFee);
  add(ops.spendOps);
  add(ops.revenueOps);
  add(ops.convert);
  add(ops.dustConvert?.ops);
  add(ops.fiatConvert);
  add(ops.deposit);
  add(ops.withdraw);
  add(ops.income);
  add(ops.internalTransfer);
  add(ops.internalTransferExclude);
  ops.signSplit?.forEach((x) => s.add(x.op.toLowerCase()));
  add(ops.fiatWithdraw);
  add(ops.skip);
  add(ops.p2p?.ops);
  add(ops.p2p?.withdrawOpsWithP2pRemark);
  return s;
}

interface Leg {
  row: LedgerRow;
  amount: number;
}

/** Composite fill key used to pair legs when no explicit order id is present. */
function compositeFillKey(r: LedgerRow): string {
  return `${r.timestamp}|${r.account}|${(r.remark ?? '').trim().toLowerCase()}`;
}

/**
 * Pair trade legs by order/trade id (preferred), falling back to a composite
 * `timestamp|account|remark` key, then to stable input order. Each right leg
 * is consumed at most once. (Sorting-by-magnitude-and-zipping is WRONG: it
 * mispairs same-timestamp fills and crossing magnitudes.)
 */
export function pairLegs<T extends Leg>(
  left: T[],
  right: Leg[]
): (T & { pairedAmount?: number; pairedRow?: LedgerRow })[] {
  const usedRight = new Set<number>();
  const byOrder = new Map<string, number[]>();
  const byComposite = new Map<string, number[]>();

  right.forEach((leg, i) => {
    if (leg.row.orderId) {
      const list = byOrder.get(leg.row.orderId) ?? [];
      list.push(i);
      byOrder.set(leg.row.orderId, list);
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
    let matchIdx =
      (item.row.orderId ? takeFrom(byOrder.get(item.row.orderId)) : undefined) ??
      takeFrom(byComposite.get(compositeFillKey(item.row)));

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

/** Group key: order id discriminates same-second fills when available. */
function groupKey(r: LedgerRow): string {
  return r.orderId ? `${r.timestamp}|${r.account}|oid:${r.orderId}` : `${r.timestamp}|${r.account}`;
}

export interface StitchContext {
  exchange: string;
  ops: OperationMap;
  /** Precompiled lowercase membership sets. */
  sets: {
    tradeBuy: Set<string>;
    tradeSell: Set<string>;
    tradeFee: Set<string>;
    simpleBuy: Set<string>;
    simpleSell: Set<string>;
    simpleFee: Set<string>;
    convert: Set<string>;
    dust: Set<string>;
    fiatConvert: Set<string>;
    deposit: Set<string>;
    withdraw: Set<string>;
    income: Set<string>;
    internal: Set<string>;
    internalExclude: Set<string>;
    fiatWithdraw: Set<string>;
    skip: Set<string>;
    p2p: Set<string>;
    spendLike: Set<string>;
    revenueLike: Set<string>;
    signSplit: Map<string, { negativeType: TxType; category?: string; derivative?: boolean }>;
  };
}

export function makeStitchContext(cfg: LedgerStitchConfig): StitchContext {
  const lc = (list?: string[]) => new Set((list ?? []).map((o) => o.toLowerCase()));
  return {
    exchange: cfg.exchange,
    ops: cfg.ops,
    sets: {
      tradeBuy: lc(cfg.ops.tradeBuy),
      tradeSell: lc(cfg.ops.tradeSell),
      tradeFee: lc(cfg.ops.tradeFee),
      simpleBuy: lc(cfg.ops.simpleTrade.buy),
      simpleSell: lc(cfg.ops.simpleTrade.sell),
      simpleFee: lc(cfg.ops.simpleTrade.fee),
      convert: lc(cfg.ops.convert),
      dust: lc(cfg.ops.dustConvert?.ops),
      fiatConvert: lc(cfg.ops.fiatConvert),
      deposit: lc(cfg.ops.deposit),
      withdraw: lc(cfg.ops.withdraw),
      income: lc(cfg.ops.income),
      internal: lc(cfg.ops.internalTransfer),
      internalExclude: lc(cfg.ops.internalTransferExclude),
      fiatWithdraw: lc(cfg.ops.fiatWithdraw),
      skip: lc(cfg.ops.skip),
      p2p: lc(cfg.ops.p2p?.ops),
      spendLike: lc(cfg.ops.spendOps),
      revenueLike: lc(cfg.ops.revenueOps),
      signSplit: new Map(
        (cfg.ops.signSplit ?? []).map((x) => [
          x.op.toLowerCase(),
          { negativeType: x.negativeType, category: x.category, derivative: x.derivative }
        ])
      )
    }
  };
}

export function makeTx(
  ctx: StitchContext,
  partial: Omit<Transaction, 'id' | 'source' | 'flags' | 'isInternalTransfer' | 'fiatCurrency'> & {
    fiatCurrency?: string;
    flags?: Transaction['flags'];
    isInternalTransfer?: boolean;
  }
): Transaction {
  const fiatCurrency = partial.fiatCurrency ?? 'USD';
  const flags =
    partial.flags ?? (partial.fiatValue != null && partial.fiatValue > 0 ? [] : ['missing_cost_basis']);
  return {
    ...partial,
    id: makeId(ctx.exchange.slice(0, 2)),
    source: ctx.exchange,
    flags,
    isInternalTransfer: partial.isInternalTransfer ?? false,
    fiatCurrency
  };
}

function srcRef(ctx: StitchContext, ts: number, type: string, asset: string, amount: number): string {
  return exchangeSourceRef(ctx.exchange, ts, type, asset, amount);
}

/** Stitch spot buys: Buy + Spend + Fee → one buy row with fiat cost. */
function stitchBuys(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  const { sets } = ctx;
  const buys = rows.filter((r) => sets.tradeBuy.has(r.operation.toLowerCase()));
  const spends = rows.filter((r) => sets.spendLike.has(r.operation.toLowerCase()) && r.change < 0);
  const fees = rows.filter((r) => sets.tradeFee.has(r.operation.toLowerCase()) && r.change < 0);

  if (buys.length === 0) return [];

  const cryptoSpends = spends.filter((s) => !isStable(s.coin));
  if (cryptoSpends.length > 0) {
    return stitchCryptoTrades(ctx, buys, cryptoSpends, fees);
  }

  const stableSpends = spends.filter((s) => isStable(s.coin));
  const paired = pairLegs(
    buys.map((b) => ({ row: b, amount: Math.abs(b.change) })),
    stableSpends.map((s) => ({ row: s, amount: Math.abs(s.change) }))
  );

  const feeByAsset = new Map<string, LedgerRow[]>();
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

    return makeTx(ctx, {
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
      sourceRef: srcRef(ctx, buy.timestamp, 'buy', buy.coin, amount),
      notes: buy.remark,
      raw: { buy: buy.raw, spend: spendRow?.raw, fee: feeRow?.raw }
    });
  });
}

/** Crypto-for-crypto: Buy + Spend (non-stable). */
function stitchCryptoTrades(
  ctx: StitchContext,
  buys: LedgerRow[],
  spends: LedgerRow[],
  fees: LedgerRow[]
): Transaction[] {
  const paired = pairLegs(
    buys.map((b) => ({ row: b, amount: Math.abs(b.change) })),
    spends.map((s) => ({ row: s, amount: Math.abs(s.change) }))
  );
  const usedFees = new Set<number>();

  return paired.map(({ row: buy, amount, pairedRow }) => {
    const spendRow = pairedRow;
    const feeRow =
      fees.find((f) => !usedFees.has(f.index) && (f.coin === buy.coin || f.coin === spendRow?.coin)) ??
      fees.find((f) => !usedFees.has(f.index));
    if (feeRow) usedFees.add(feeRow.index);

    return makeTx(ctx, {
      timestamp: buy.timestamp,
      type: 'trade',
      asset: spendRow?.coin ?? buy.coin,
      amount: spendRow ? Math.abs(spendRow.change) : amount,
      counterAsset: buy.coin,
      counterAmount: amount,
      feeAmount: feeRow ? Math.abs(feeRow.change) : undefined,
      feeAsset: feeRow?.coin,
      sourceRef: srcRef(ctx, buy.timestamp, 'trade', buy.coin, amount),
      notes: 'Crypto-for-crypto trade',
      raw: { buy: buy.raw, spend: spendRow?.raw }
    });
  });
}

/** Stitch spot sells: Sold + Revenue + Fee → one sell row with proceeds. */
function stitchSells(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  const { sets } = ctx;
  const solds = rows.filter((r) => sets.tradeSell.has(r.operation.toLowerCase()));
  const revenues = rows.filter((r) => sets.revenueLike.has(r.operation.toLowerCase()) && r.change > 0);
  const fees = rows.filter((r) => sets.tradeFee.has(r.operation.toLowerCase()) && r.change < 0);

  if (solds.length === 0) return [];

  const paired = pairLegs(
    solds.map((s) => ({ row: s, amount: Math.abs(s.change) })),
    revenues.map((r) => ({ row: r, amount: Math.abs(r.change) }))
  );

  const stableFees = fees.filter((f) => isStable(f.coin));
  stableFees.sort((a, b) => Math.abs(a.change) - Math.abs(b.change));
  const usedFees = new Set<number>();

  return paired.map(({ row: sold, amount, pairedAmount, pairedRow }) => {
    const revRow = pairedRow;
    const feeRow = stableFees.find((f) => !usedFees.has(f.index));
    if (feeRow) usedFees.add(feeRow.index);

    const fiatValue = pairedAmount ?? (revRow ? Math.abs(revRow.change) : undefined);
    const quote = revRow?.coin;

    return makeTx(ctx, {
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
      sourceRef: srcRef(ctx, sold.timestamp, 'sell', sold.coin, amount),
      notes: sold.remark,
      raw: { sold: sold.raw, revenue: revRow?.raw, fee: feeRow?.raw }
    });
  });
}

/**
 * OLD-era simple trades: one Sell (spent) + one Buy (received) + Fee per
 * trade. Stable-quote → 'sell' with fiat value; crypto-quote → 'trade'.
 */
function stitchSimpleTrades(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  const { sets } = ctx;
  // Guard: defer to the modern stitchers if a modern group is present (any
  // modern-era op in the group — triplet legs, shared fee, or convert).
  const isModernGroup = rows.some((r) => {
    const op = r.operation.toLowerCase();
    return (
      sets.tradeBuy.has(op) ||
      sets.tradeSell.has(op) ||
      sets.spendLike.has(op) ||
      sets.revenueLike.has(op) ||
      sets.tradeFee.has(op) ||
      sets.convert.has(op)
    );
  });
  if (isModernGroup) return [];

  const sells = rows.filter((r) => sets.simpleSell.has(r.operation.toLowerCase()));
  const buys = rows.filter((r) => sets.simpleBuy.has(r.operation.toLowerCase()));
  if (sells.length === 0 || buys.length === 0) return [];
  const fees = rows.filter((r) => sets.simpleFee.has(r.operation.toLowerCase()) && r.change < 0);

  const paired = pairLegs(
    sells.map((s) => ({ row: s, amount: Math.abs(s.change) })),
    buys.map((b) => ({ row: b, amount: Math.abs(b.change) }))
  );

  const usedFees = new Set<number>();
  const out: Transaction[] = paired.map(({ row: sell, amount, pairedRow }) => {
    const buyRow = pairedRow;
    const receivedAsset = buyRow?.coin;
    const feeRow =
      fees.find((f) => !usedFees.has(f.index) && f.coin === receivedAsset) ??
      fees.find((f) => !usedFees.has(f.index));
    if (feeRow) usedFees.add(feeRow.index);

    const isStableQuote = receivedAsset != null && isStable(receivedAsset);
    const receivedAmount = buyRow ? Math.abs(buyRow.change) : undefined;
    return makeTx(ctx, {
      timestamp: sell.timestamp,
      type: isStableQuote ? 'sell' : 'trade',
      asset: sell.coin,
      amount,
      counterAsset: receivedAsset,
      counterAmount: receivedAmount,
      fiatValue: isStableQuote ? receivedAmount : undefined,
      fiatCurrency: isStableQuote && receivedAsset ? fiatFromCoin(receivedAsset) : 'USD',
      feeAmount: feeRow ? Math.abs(feeRow.change) : undefined,
      feeAsset: feeRow?.coin,
      sourceRef: srcRef(ctx, sell.timestamp, isStableQuote ? 'sell' : 'trade', sell.coin, amount),
      notes: isStableQuote ? undefined : 'Crypto-for-crypto trade',
      flags: isStableQuote ? [] : ['missing_cost_basis'],
      raw: { sell: sell.raw, buy: buyRow?.raw, fee: feeRow?.raw }
    });
  });

  // Surplus Buy legs (1 Sell + 2 Buys): the extra acquisitions no Sell leg
  // consumed must still import — dropping them silently loses real
  // acquisitions (reproduced: XRP 5000 buy vanished).
  const pairedBuyIndexes = new Set(
    paired.map((p) => p.pairedRow?.index).filter((i): i is number => i != null)
  );
  for (const b of buys) {
    if (pairedBuyIndexes.has(b.index)) continue;
    const amount = Math.abs(b.change);
    out.push(
      makeTx(ctx, {
        timestamp: b.timestamp,
        type: 'buy',
        asset: b.coin,
        amount,
        fiatValue: undefined,
        sourceRef: srcRef(ctx, b.timestamp, 'buy', b.coin, amount),
        notes: 'Unpaired simple-era Buy leg (counter-leg absent)',
        flags: ['missing_cost_basis'],
        raw: { buy: b.raw }
      })
    );
  }

  return out;
}

/** Two-leg swaps: spent leg + received leg → trade. */
function stitchConverts(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  const sel = rows.filter((r) => ctx.sets.convert.has(r.operation.toLowerCase()));
  if (sel.length < 2) return [];
  const outs = sel.filter((r) => r.change < 0);
  const ins = sel.filter((r) => r.change > 0);
  if (outs.length === 0 || ins.length === 0) return [];

  return pairLegs(
    outs.map((o) => ({ row: o, amount: Math.abs(o.change) })),
    ins.map((i) => ({ row: i, amount: Math.abs(i.change) }))
  ).map(({ row: out, amount, pairedAmount, pairedRow }) => {
    const inRow = pairedRow;
    return makeTx(ctx, {
      timestamp: out.timestamp,
      type: 'trade',
      asset: out.coin,
      amount,
      counterAsset: inRow?.coin,
      counterAmount: inRow ? Math.abs(inRow.change) : pairedAmount,
      sourceRef: srcRef(ctx, out.timestamp, 'trade', out.coin, amount),
      notes: out.operation,
      flags: ['missing_cost_basis'],
      raw: { out: out.raw, in: inRow?.raw }
    });
  });
}

/** Grouped dust sweep: every negative leg in a (timestamp, account) group → toAsset. */
function stitchDustConverts(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  const dc = ctx.ops.dustConvert;
  if (!dc) return [];
  const dust = rows.filter((r) => ctx.sets.dust.has(r.operation.toLowerCase()));
  if (dust.length === 0) return [];

  const byGroup = new Map<string, LedgerRow[]>();
  for (const r of dust) {
    const k = `${r.timestamp}|${r.account}`;
    const list = byGroup.get(k) ?? [];
    list.push(r);
    byGroup.set(k, list);
  }
  const out: Transaction[] = [];
  for (const group of byGroup.values()) {
    const receivedTotal = group.filter((r) => r.change > 0).reduce((s, r) => s + r.change, 0);
    for (const r of group) {
      if (r.change >= 0) continue; // credit rows are implied by the trades
      const amount = Math.abs(r.change);
      out.push(
        makeTx(ctx, {
          timestamp: r.timestamp,
          type: 'trade',
          asset: r.coin,
          amount,
          counterAsset: dc.toAsset,
          sourceRef: srcRef(ctx, r.timestamp, 'trade', r.coin, amount),
          notes: `Small assets (dust) converted to ${dc.toAsset} (group total +${receivedTotal} ${dc.toAsset})`,
          flags: ['missing_cost_basis'],
          raw: r.raw
        })
      );
    }
  }
  return out;
}

/** Fiat/stable conversion pairs (e.g. Binance 'Transaction Related'). */
function stitchFiatConverts(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  const rel = rows.filter((r) => ctx.sets.fiatConvert.has(r.operation.toLowerCase()));
  if (rel.length < 2) return [];
  const outLegs = rel.filter((r) => r.change < 0).map((r) => ({ row: r, amount: Math.abs(r.change) }));
  const inLegs = rel.filter((r) => r.change > 0).map((r) => ({ row: r, amount: Math.abs(r.change) }));
  if (outLegs.length === 0 || inLegs.length === 0) return [];
  return pairLegs(outLegs, inLegs).map(({ row: out, amount, pairedRow }) => {
    const inRow = pairedRow;
    const received = inRow ? Math.abs(inRow.change) : undefined;
    return makeTx(ctx, {
      timestamp: out.timestamp,
      type: 'trade',
      asset: out.coin,
      amount,
      counterAsset: inRow?.coin,
      counterAmount: received,
      fiatValue: inRow && quoteToFiatCurrency(inRow.coin) ? received : undefined,
      fiatCurrency: inRow ? fiatFromCoin(inRow.coin) : fiatFromCoin(out.coin),
      sourceRef: srcRef(ctx, out.timestamp, 'trade', out.coin, amount),
      notes: `Fiat/stable conversion (${out.operation})`,
      flags: [],
      category: 'fiat',
      raw: { out: out.raw, in: inRow?.raw }
    });
  });
}

/**
 * Intra-account transfers ("Transfer Between Spot and Funding/CM/UM/Options",
 * "Inter-Wallet Transfer"). These operations are ONLY ever emitted for moves
 * between accounts inside the SAME exchange account — there is no possible
 * external counterparty. They are therefore internal transfers with 100%
 * certainty, so we auto-confirm them (isInternalTransfer: true, no
 * possible_internal_transfer flag) instead of asking the user to mark them.
 * This removes a manual Review step and makes them net to zero in portfolio
 * math immediately. External Deposit/Withdraw stay review-needed (handled
 * separately) because the ledger can't tell own-wallet from third-party there.
 */
function stitchInternalTransfers(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  return rows
    .filter((r) => ctx.sets.internal.has(r.operation.toLowerCase()))
    .map((r) =>
      makeTx(ctx, {
        timestamp: r.timestamp,
        type: r.change > 0 ? 'transfer_in' : 'transfer_out',
        asset: r.coin,
        amount: Math.abs(r.change),
        sourceRef: srcRef(
          ctx,
          r.timestamp,
          r.change > 0 ? 'transfer_in' : 'transfer_out',
          r.coin,
          Math.abs(r.change)
        ),
        notes: r.operation,
        flags: [],
        isInternalTransfer: true, // provably intra-account → auto-confirmed
        raw: r.raw
      })
    );
}

function isP2pRemark(remark?: string): boolean {
  return !!remark && /\bp2p\b/i.test(remark);
}

/** P2P trades: incoming → buy (cost-basis lot), outgoing → sell (disposal). */
function stitchP2pRows(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  const p2pCfg = ctx.ops.p2p;
  if (!p2pCfg) return [];
  const withdrawRemarkOps = new Set(
    (p2pCfg.withdrawOpsWithP2pRemark ?? []).map((o) => o.toLowerCase())
  );
  const out: Transaction[] = [];
  for (const r of rows) {
    const op = r.operation.toLowerCase();
    const isP2p =
      ctx.sets.p2p.has(op) || (withdrawRemarkOps.has(op) && isP2pRemark(r.remark));
    if (!isP2p) continue;
    const amount = Math.abs(r.change);
    const type: TxType = r.change > 0 ? 'buy' : 'sell';
    out.push(
      makeTx(ctx, {
        timestamp: r.timestamp,
        type,
        asset: r.coin,
        amount,
        sourceRef: srcRef(ctx, r.timestamp, type, r.coin, amount),
        notes: r.remark ? `P2P: ${r.remark}` : 'P2P trading',
        flags: ['missing_cost_basis'],
        category: 'p2p',
        raw: r.raw
      })
    );
  }
  return out;
}

/** Sign-varying ops (funding fees, realized PnL): + → income, − → configured type. */
function stitchSignSplits(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  const out: Transaction[] = [];
  for (const r of rows) {
    const rule = ctx.sets.signSplit.get(r.operation.toLowerCase());
    if (!rule) continue;
    const amount = Math.abs(r.change);
    const positive = r.change > 0;
    const type: TxType = positive ? 'income' : rule.negativeType;
    const isPnl = rule.negativeType === 'sell' && type === 'sell'; // loss side of realized PnL
    out.push(
      makeTx(ctx, {
        timestamp: r.timestamp,
        type,
        asset: r.coin,
        amount,
        // Settlement coin is usually a stable → fiat value on PnL rows.
        fiatValue: type !== 'fee' && isStable(r.coin) ? amount : undefined,
        fiatCurrency: fiatFromCoin(r.coin),
        sourceRef: srcRef(ctx, r.timestamp, type, r.coin, amount),
        notes: r.remark ? `${r.operation}: ${r.remark}` : r.operation,
        flags: positive || isPnl ? (positive ? ['missing_cost_basis'] : []) : [],
        category: rule.category,
        instrumentClass: rule.derivative ? 'derivative' : undefined,
        raw: r.raw
      })
    );
  }
  return out;
}

/** Fiat off-ramp: sell of the fiat asset with fiat value. */
function stitchFiatWithdrawals(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  return rows
    .filter((r) => ctx.sets.fiatWithdraw.has(r.operation.toLowerCase()))
    .map((r) => {
      const amount = Math.abs(r.change);
      return makeTx(ctx, {
        timestamp: r.timestamp,
        type: 'sell',
        asset: r.coin,
        amount,
        fiatValue: amount,
        fiatCurrency: fiatFromCoin(r.coin),
        sourceRef: srcRef(ctx, r.timestamp, 'sell', r.coin, amount),
        notes: 'Fiat withdrawal to bank',
        category: 'fiat',
        raw: r.raw
      });
    });
}

/** Remaining 1:1 rows: deposits, withdrawals, income, fees, transfers, strays. */
function stitchSimpleRows(ctx: StitchContext, rows: LedgerRow[]): Transaction[] {
  const { sets } = ctx;
  const out: Transaction[] = [];

  // Fees in a group that held a simple-era trade are consumed by
  // stitchSimpleTrades; skip here to avoid double counting.
  const groupHadSimpleTrade =
    rows.some((r) => sets.simpleBuy.has(r.operation.toLowerCase())) &&
    rows.some((r) => sets.simpleSell.has(r.operation.toLowerCase()));

  const withdrawRemarkP2p = new Set(
    (ctx.ops.p2p?.withdrawOpsWithP2pRemark ?? []).map((o) => o.toLowerCase())
  );

  for (const r of rows) {
    const op = r.operation.toLowerCase();
    // All rows consumed by dedicated stitchers above.
    if (
      sets.tradeBuy.has(op) ||
      sets.tradeSell.has(op) ||
      sets.tradeFee.has(op) ||
      sets.spendLike.has(op) ||
      sets.revenueLike.has(op) ||
      sets.convert.has(op) ||
      sets.internal.has(op) ||
      sets.internalExclude.has(op) ||
      sets.p2p.has(op) ||
      sets.dust.has(op) ||
      sets.fiatConvert.has(op) ||
      sets.fiatWithdraw.has(op) ||
      sets.skip.has(op) ||
      sets.signSplit.has(op)
    )
      continue;
    if (withdrawRemarkP2p.has(op) && isP2pRemark(r.remark)) continue;
    if (sets.simpleFee.has(op) && groupHadSimpleTrade) continue;

    let type: TxType | null = null;
    if (sets.deposit.has(op)) type = 'transfer_in';
    else if (sets.withdraw.has(op)) type = 'transfer_out';
    else if (sets.income.has(op)) {
      // Sign-aware: some income-class ops have rare negative legs (migrations,
      // clawbacks) that are NOT income.
      if (r.change < 0) type = 'transfer_out';
      else type = 'income';
    } else if (sets.simpleFee.has(op)) type = 'fee';
    else if (op === 'transfer') type = r.change > 0 ? 'transfer_in' : 'transfer_out';
    // Unpaired simple-era legs (counter-leg absent from the export) still import.
    else if (sets.simpleBuy.has(op) && !groupHadSimpleTrade) type = 'buy';
    else if (sets.simpleSell.has(op) && !groupHadSimpleTrade) type = 'sell';
    else continue;

    const amount = Math.abs(r.change);
    const flags: Transaction['flags'] =
      type === 'transfer_in' || type === 'transfer_out'
        ? ['possible_internal_transfer']
        : ['missing_cost_basis'];

    out.push(
      makeTx(ctx, {
        timestamp: r.timestamp,
        type,
        asset: r.coin,
        amount,
        sourceRef: srcRef(ctx, r.timestamp, type, r.coin, amount),
        notes: r.remark || r.operation,
        flags,
        raw: r.raw
      })
    );
  }
  return out;
}

/**
 * Group normalized ledger rows by timestamp+account (+order id when present),
 * then stitch multi-leg events into single transactions.
 */
export function stitchLedger(
  rows: Record<string, string>[],
  cfg: LedgerStitchConfig
): { transactions: Transaction[]; skippedRows: number; warnings: string[] } {
  const normalized = normalizeLedgerRows(rows, cfg);
  const skippedRows = rows.length - normalized.length;
  const warnings: string[] = [];
  const ctx = makeStitchContext(cfg);

  const groups = new Map<string, LedgerRow[]>();
  for (const r of normalized) {
    const k = groupKey(r);
    const list = groups.get(k) ?? [];
    list.push(r);
    groups.set(k, list);
  }

  const transactions: Transaction[] = [];
  for (const group of groups.values()) {
    transactions.push(
      ...stitchBuys(ctx, group),
      ...stitchSells(ctx, group),
      ...stitchSimpleTrades(ctx, group),
      ...stitchConverts(ctx, group),
      ...stitchInternalTransfers(ctx, group),
      ...stitchP2pRows(ctx, group),
      ...stitchSignSplits(ctx, group),
      ...stitchDustConverts(ctx, group),
      ...stitchFiatConverts(ctx, group),
      ...stitchFiatWithdrawals(ctx, group),
      ...stitchSimpleRows(ctx, group)
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
  // Count only the transfers that still need user review — rows already
  // auto-confirmed internal (intra-account "Transfer Between…" / "Inter-Wallet
  // Transfer") net to zero and need no action, so exclude them from the
  // "mark internal transfers" prompt to avoid alarming the user with rows
  // they've already been told are handled.
  const reviewableIn = transactions.filter(
    (t) => t.type === 'transfer_in' && !t.isInternalTransfer
  ).length;
  const reviewableOut = transactions.filter(
    (t) => t.type === 'transfer_out' && !t.isInternalTransfer
  ).length;
  const autoInternal = transactions.filter(
    (t) => (t.type === 'transfer_in' || t.type === 'transfer_out') && t.isInternalTransfer
  ).length;
  const p2pTrades = transactions.filter((t) => t.category === 'p2p').length;
  if (p2pTrades > 0) {
    const p2pSells = transactions.filter((t) => t.category === 'p2p' && t.type === 'sell').length;
    warnings.push(
      `${p2pTrades} P2P trade(s) classified as buy/sell (${p2pTrades - p2pSells} buy, ${p2pSells} sell) — included in capital gains unless you mark internal transfer in Review.`
    );
  }
  if (autoInternal > 0) {
    warnings.push(
      `${autoInternal} internal account transfer(s) auto-confirmed (Spot ↔ Funding/Futures/Options) — these net to zero, no action needed.`
    );
  }
  if (reviewableIn + reviewableOut > 0) {
    warnings.push(
      `${reviewableIn} deposit(s) and ${reviewableOut} withdrawal(s) imported — mark internal transfers in Review if moving between your own wallets.`
    );
  }

  return { transactions, skippedRows, warnings };
}
