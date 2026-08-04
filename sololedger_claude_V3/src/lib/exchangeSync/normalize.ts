/**
 * Exchange Auto-Sync — unified-ccxt → Transaction normalizer.
 *
 * PURE module (no ccxt/db/saas runtime imports): it consumes ccxt's unified
 * structures (as structural types) and produces rows that mirror the existing
 * CSV parsers' semantics EXACTLY, so the shared dedup machinery collapses
 * API↔CSV twins (plan §B-5).
 *
 * Classification parity notes:
 * - Trades (binance/coinbase/okx/kucoin) mirror binanceSpot.ts per-fill;
 *   Bybit fills aggregate by Order ID to mirror its order-level CSV export
 *   semantics, except crypto-quoted fills classify as 'trade' (the more
 *   correct treatment — see the v1.1 divergence note in README) while their
 *   sourceRef still collides with the Trade-History-CSV row.
 * - Kraken fills aggregate per order txid and mirror kraken.ts stitch
 *   granularity + fiat-only quote semantics.
 * - Transfers mirror binanceTransfers.ts.
 */
import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId } from '@/lib/parsers/types';
import { quoteToFiatCurrency } from '@/lib/parsers/pairUtils';
import { isRealTxHash, isValidTxHashForChain, normalizeChain } from '@/lib/parsers/explorer';
import type { ExchangeId } from './types';
import type { UnifiedMarket, UnifiedTrade, UnifiedTransfer } from './ccxtLoader';
import { requiresMarketValue } from '@/lib/transactions/requiresMarketValue';

/** Quotes treated as fiat-equivalent for fiatValue purposes (§B-5a). */
const STABLE_QUOTES = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'DAI']);

/** Kraken fiat quotes (kraken.ts FIAT_ASSETS — intentionally NO stablecoins). */
const KRAKEN_FIAT_ASSETS = new Set(['USD', 'EUR', 'CAD', 'GBP', 'JPY', 'AUD']);

/** makeId prefixes per exchange. */
const ID_PREFIX: Record<ExchangeId, string> = {
  binance: 'exbn',
  coinbase: 'excb',
  kraken: 'exkr',
  okx: 'exok',
  kucoin: 'exkc',
  bybit: 'exbb'
};

/** Floor an ms timestamp to whole seconds (CSV exports are second-granular). */
export function floorToSeconds(ts: number): number {
  return Math.floor(ts / 1000) * 1000;
}

/**
 * Resolve a market for a parsed trade/transfer. Verify-at-build finding:
 * when the engine fetches WITHOUT a symbol (coinbase/okx/kucoin/kraken),
 * ccxt parses `trade.symbol` as the exchange-native market ID ('BTC-USDT',
 * 'XXBTZUSD'), not the unified symbol the loadMarkets map is keyed by — so
 * fall back to an id scan (ccxt safeMarket does the same).
 */
export function resolveMarket(
  markets: Record<string, UnifiedMarket>,
  symbol: string | undefined
): UnifiedMarket | undefined {
  if (!symbol) return undefined;
  const direct = markets[symbol];
  if (direct) return direct;
  for (const market of Object.values(markets)) {
    if ((market as UnifiedMarket & { id?: string }).id === symbol) return market;
  }
  return undefined;
}

type PerFillExchange = Exclude<ExchangeId, 'kraken'>;

/** sourceRef for a per-fill trade (§B-5b). */
function tradeSourceRef(
  exchange: PerFillExchange,
  trade: UnifiedTrade,
  side: string,
  base: string,
  amount: number,
  ts: number
): string | undefined {
  switch (exchange) {
    case 'binance':
      // Collides with binanceSpot.ts Trade-History-CSV refs by construction.
      return exchangeSourceRef('binance', floorToSeconds(ts), side, base, amount);
    case 'coinbase':
      // CSV uses the ID column; formula is a defensive fallback only.
      return trade.id ?? exchangeSourceRef('coinbase', floorToSeconds(ts), side, base, amount);
    case 'okx':
      // ORDER FIRST — okx.ts prefers ordId; id-first would never collide.
      return trade.order ?? trade.id ?? exchangeSourceRef('okx', floorToSeconds(ts), side, base, amount);
    case 'kucoin':
      return trade.id ?? exchangeSourceRef('kucoin', floorToSeconds(ts), side, base, amount);
    case 'bybit':
      // Bybit's CSV parser uses Order ID; execution id is only a fallback.
      return trade.order ?? trade.id ?? exchangeSourceRef('bybit', floorToSeconds(ts), side, base, amount);
  }
}

/**
 * Normalize one per-fill trade (binance/coinbase/okx/kucoin, plus a synthetic
 * aggregated Bybit order) — §B-5a.
 * Returns null for fills that lack the fields any classification needs.
 */
export function normalizeTrade(
  exchange: PerFillExchange,
  trade: UnifiedTrade,
  market: UnifiedMarket | undefined
): Transaction | null {
  const ts = trade.timestamp;
  const side = trade.side === 'buy' ? 'buy' : trade.side === 'sell' ? 'sell' : undefined;
  const amount = trade.amount;
  if (!market || ts == null || !Number.isFinite(ts) || !side || amount == null || !(amount > 0)) {
    return null;
  }
  const base = market.base.toUpperCase();
  const quote = market.quote.toUpperCase();
  const cost = trade.cost ?? (trade.price != null ? trade.price * amount : undefined);

  const quoteFiat = quoteToFiatCurrency(quote);
  const fiatCurrency = quoteFiat ?? 'USD';
  const fiatValue = (quoteFiat != null || STABLE_QUOTES.has(quote)) && cost != null ? cost : undefined;

  const feeCost = trade.fee?.cost != null ? Math.abs(trade.fee.cost) : undefined;
  const feeAsset = trade.fee?.currency?.toUpperCase() || undefined;

  let type: TxType;
  let asset: string;
  let txAmount: number;
  let counterAsset: string;
  let counterAmount: number | undefined;
  let notes: string | undefined;

  if (fiatValue != null) {
    // Fiat/stable-quoted fill → buy/sell with the quote total as cost basis.
    type = side;
    asset = base;
    txAmount = amount;
    counterAsset = quote;
    counterAmount = cost;
    if (exchange === 'binance' && (market.symbol ?? base) !== base) {
      // Mirrors binanceSpot.ts `Pair <pairRaw>` note.
      notes = `Pair ${market.symbol}`;
    }
  } else {
    // Crypto-quoted fill → 'trade' with binanceStitch.ts crypto orientation:
    // the SPENT leg is the disposed asset.
    type = 'trade';
    notes = 'Crypto-for-crypto trade';
    if (side === 'buy') {
      asset = quote; // spent
      txAmount = cost ?? 0;
      counterAsset = base; // received
      counterAmount = amount;
    } else {
      asset = base; // spent
      txAmount = amount;
      counterAsset = quote; // received
      counterAmount = cost;
    }
  }
  if (txAmount <= 0) return null;

  return {
    id: makeId(ID_PREFIX[exchange]),
    timestamp: ts,
    type,
    asset,
    amount: txAmount,
    counterAsset,
    counterAmount,
    fiatCurrency,
    fiatValue,
    feeAmount: feeCost != null && feeCost > 0 ? feeCost : undefined,
    feeAsset: feeCost != null && feeCost > 0 ? feeAsset : undefined,
    source: `${exchange}_api`,
    sourceRef: tradeSourceRef(exchange, trade, side, base, amount, ts),
    notes,
    flags: fiatValue != null || !requiresMarketValue(type) ? [] : ['missing_market_value'],
    isInternalTransfer: false,
    raw: { tradeId: trade.id, orderId: trade.order }
  };
}

/**
 * Kraken fills → one row per ORDER txid (§B-5c — mirrors kraken.ts stitch
 * granularity): amount=Σ, cost=Σ, ts = earliest fill, fee = Σ only when a
 * single fee currency. Fiat-only quotes classify buy/sell; everything else
 * (stable OR crypto quote) is 'trade' with asset = RECEIVED asset.
 */
export function normalizeKrakenTradesByOrder(
  trades: UnifiedTrade[],
  markets: Record<string, UnifiedMarket>
): { transactions: Transaction[]; skipped: number } {
  const groups = new Map<string, UnifiedTrade[]>();
  for (const t of trades) {
    const key = t.order ?? `__noid__${t.id ?? groups.size}`;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  const transactions: Transaction[] = [];
  let skipped = 0;

  for (const [orderKey, fills] of groups) {
    const first = fills[0];
    const market = resolveMarket(markets, first.symbol);
    const ts = Math.min(...fills.map((f) => f.timestamp ?? Number.POSITIVE_INFINITY));
    const side = first.side === 'buy' ? 'buy' : first.side === 'sell' ? 'sell' : undefined;
    const amount = fills.reduce((s, f) => s + (f.amount ?? 0), 0);
    if (!market || !side || !(amount > 0) || !Number.isFinite(ts)) {
      skipped += fills.length;
      continue;
    }
    const base = market.base.toUpperCase();
    const quote = market.quote.toUpperCase();
    const costParts = fills.map((f) => f.cost ?? (f.price != null && f.amount != null ? f.price * f.amount : undefined));
    const cost = costParts.every((part) => part == null)
      ? undefined
      : costParts.reduce<number>((sum, part) => sum + (part ?? 0), 0);

    // Fee: summed only when every fill's fee is in the same currency. When
    // ccxt leaves the fee currency unset (kraken parses no fee currency when
    // no market is threaded), Kraken spot fees are denominated in the quote.
    const feeCurrencies = new Set(
      fills.filter((f) => (f.fee?.cost ?? 0) > 0).map((f) => (f.fee?.currency ?? '').toUpperCase())
    );
    const feeAmount =
      feeCurrencies.size === 1
        ? fills.reduce((s, f) => s + Math.abs(f.fee?.cost ?? 0), 0)
        : undefined;
    const feeAsset =
      feeCurrencies.size === 1 ? [...feeCurrencies][0] || market.quote.toUpperCase() : undefined;

    let type: TxType;
    let asset: string;
    let txAmount: number;
    let counterAsset: string;
    let counterAmount: number | undefined;
    let fiatCurrency = 'USD';
    let fiatValue: number | undefined;

    if (KRAKEN_FIAT_ASSETS.has(quote)) {
      // Fiat quote → buy/sell with fiatValue = fiat leg (kraken.ts semantics).
      type = side;
      asset = base;
      txAmount = amount;
      counterAsset = quote;
      counterAmount = cost;
      fiatCurrency = quote;
      fiatValue = cost;
    } else {
      // Stable OR crypto quote → 'trade' with asset = RECEIVED asset.
      type = 'trade';
      if (side === 'buy') {
        asset = base; // received
        txAmount = amount;
        counterAsset = quote;
        counterAmount = cost;
      } else {
        asset = quote; // received
        txAmount = cost ?? 0;
        counterAsset = base;
        counterAmount = amount;
      }
    }
    if (!(txAmount > 0)) {
      skipped += fills.length;
      continue;
    }

    transactions.push({
      id: makeId(ID_PREFIX.kraken),
      timestamp: ts,
      type,
      asset,
      amount: txAmount,
      counterAsset,
      counterAmount,
      fiatCurrency,
      fiatValue,
      feeAmount,
      feeAsset,
      source: 'kraken_api',
      // == CSV refid (kraken.ts keys stitched trades by refid == order txid).
      sourceRef: orderKey.startsWith('__noid__') ? first.id : orderKey,
      flags: [],
      isInternalTransfer: false,
      raw: { orderId: orderKey.startsWith('__noid__') ? undefined : orderKey, tradeId: first.id }
    });
  }

  return { transactions, skipped };
}

/**
 * Bybit execution rows are fill-level while the existing CSV is order-level.
 * Aggregate fills by Order ID before normalizing so the API row both preserves
 * the complete economics and collides with the CSV parser's `Order ID` ref.
 */
export function normalizeBybitTradesByOrder(
  trades: UnifiedTrade[],
  markets: Record<string, UnifiedMarket>
): { transactions: Transaction[]; skipped: number } {
  const groups = new Map<string, UnifiedTrade[]>();
  for (const trade of trades) {
    const key = trade.order ?? `__fill__${trade.id ?? groups.size}`;
    const group = groups.get(key) ?? [];
    group.push(trade);
    groups.set(key, group);
  }

  const transactions: Transaction[] = [];
  let skipped = 0;
  for (const [key, fills] of groups) {
    const first = fills[0];
    const feeCurrencies = new Set(
      fills.filter((fill) => fill.fee?.cost != null).map((fill) => fill.fee?.currency?.toUpperCase() ?? '')
    );
    const synthetic: UnifiedTrade = {
      ...first,
      id: first.id,
      order: key.startsWith('__fill__') ? first.order : key,
      timestamp: Math.min(...fills.map((fill) => fill.timestamp ?? Number.POSITIVE_INFINITY)),
      amount: fills.reduce((sum, fill) => sum + (fill.amount ?? 0), 0),
      cost: fills.reduce((sum, fill) => sum + (fill.cost ?? ((fill.price ?? 0) * (fill.amount ?? 0))), 0),
      fee: feeCurrencies.size === 1
        ? {
            cost: fills.reduce((sum, fill) => sum + Math.abs(fill.fee?.cost ?? 0), 0),
            currency: [...feeCurrencies][0] || undefined
          }
        : undefined
    };
    const transaction = normalizeTrade('bybit', synthetic, resolveMarket(markets, synthetic.symbol));
    if (transaction) {
      const market = resolveMarket(markets, synthetic.symbol);
      transaction.raw = {
        ...transaction.raw,
        bybitBase: market?.base.toUpperCase(),
        bybitQuote: market?.quote.toUpperCase(),
        bybitExecutions: fills.map((fill) => ({
          id: fill.id,
          timestamp: fill.timestamp,
          side: fill.side,
          amount: fill.amount,
          cost: fill.cost ?? ((fill.price ?? 0) * (fill.amount ?? 0)),
          feeAmount: fill.fee?.cost != null ? Math.abs(fill.fee.cost) : undefined,
          feeAsset: fill.fee?.currency?.toUpperCase()
        }))
      };
      transactions.push(transaction);
    }
    else skipped += fills.length;
  }
  return { transactions, skipped };
}

interface BybitExecutionEvidence {
  id?: string;
  timestamp?: number;
  side?: string;
  amount?: number;
  cost?: number;
  feeAmount?: number;
  feeAsset?: string;
}

function bybitExecutionEvidence(transaction: Transaction): BybitExecutionEvidence[] {
  const value = transaction.raw?.bybitExecutions;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is BybitExecutionEvidence => item != null && typeof item === 'object');
}

function bybitExecutionIdentity(fill: BybitExecutionEvidence): string {
  if (fill.id) return `id:${fill.id}`;
  return [fill.timestamp, fill.side, fill.amount, fill.cost, fill.feeAmount, fill.feeAsset].join(':');
}

/**
 * Union durable Bybit execution evidence and recompute the order-level row.
 * Existing row identity and user classification metadata survive; only the
 * exchange-derived economics and evidence are refreshed.
 */
export function mergeBybitOrderTransactions(existing: Transaction, incoming: Transaction): Transaction {
  const fills = new Map<string, BybitExecutionEvidence>();
  for (const fill of [...bybitExecutionEvidence(existing), ...bybitExecutionEvidence(incoming)]) {
    fills.set(bybitExecutionIdentity(fill), fill);
  }
  if (fills.size === 0) {
    return {
      ...incoming,
      ...existing,
      raw: incoming.raw
    };
  }

  const executions = [...fills.values()];
  const side = executions.find((fill) => fill.side === 'buy' || fill.side === 'sell')?.side;
  const base = String(incoming.raw?.bybitBase ?? existing.raw?.bybitBase ?? '').toUpperCase();
  const quote = String(incoming.raw?.bybitQuote ?? existing.raw?.bybitQuote ?? '').toUpperCase();
  const amount = executions.reduce((sum, fill) => sum + (fill.amount ?? 0), 0);
  const cost = executions.reduce((sum, fill) => sum + (fill.cost ?? 0), 0);
  const timestamps = executions.map((fill) => fill.timestamp).filter((value): value is number =>
    value != null && Number.isFinite(value));
  const feeFills = executions.filter((fill) => (fill.feeAmount ?? 0) > 0);
  const feeAssets = new Set(feeFills.map((fill) => fill.feeAsset ?? ''));
  const feeAmount = feeAssets.size === 1
    ? feeFills.reduce((sum, fill) => sum + (fill.feeAmount ?? 0), 0)
    : undefined;
  const feeAsset = feeAssets.size === 1 ? [...feeAssets][0] || undefined : undefined;
  let economic: Partial<Transaction>;
  if (incoming.type === 'buy' || incoming.type === 'sell') {
    economic = {
      amount,
      counterAmount: cost
    };
  } else if (side === 'buy') {
    economic = { asset: quote || incoming.asset, amount: cost, counterAsset: base || incoming.counterAsset, counterAmount: amount };
  } else {
    economic = { asset: base || incoming.asset, amount, counterAsset: quote || incoming.counterAsset, counterAmount: cost };
  }

  return {
    ...incoming,
    // Preserve the complete stored row first. Transaction review fields are
    // intentionally open-ended (classification, spam, manual fiat/pricing,
    // notes/category/flags, TDS, etc.); copying only a hand-picked subset is
    // unsafe whenever the model gains another user-owned field.
    ...existing,
    // Refresh only values derived from Bybit executions.
    ...economic,
    timestamp: timestamps.length > 0 ? Math.min(...timestamps) : incoming.timestamp,
    feeAmount,
    feeAsset,
    raw: {
      ...incoming.raw,
      bybitBase: base || undefined,
      bybitQuote: quote || undefined,
      bybitExecutions: executions
    }
  };
}

/** sourceRef for a transfer (§B-5b). */
function transferSourceRef(
  exchange: ExchangeId,
  transfer: UnifiedTransfer,
  type: TxType,
  asset: string,
  amount: number,
  ts: number
): string | undefined {
  const infoRefid = transfer.info?.refid;
  switch (exchange) {
    case 'binance':
      // == binanceTransfers.ts formula.
      return exchangeSourceRef('binance', floorToSeconds(ts), type, asset, amount);
    case 'coinbase':
      return transfer.id ?? exchangeSourceRef('coinbase', floorToSeconds(ts), type, asset, amount);
    case 'kraken':
      // kraken.ts transfers prefer info.refid.
      return (typeof infoRefid === 'string' && infoRefid) || transfer.id;
    case 'okx':
      return transfer.id ?? exchangeSourceRef('okx', floorToSeconds(ts), type, asset, amount);
    case 'kucoin':
      return transfer.id ?? exchangeSourceRef('kucoin', floorToSeconds(ts), type, asset, amount);
    case 'bybit': {
      if (type === 'transfer_out' && transfer.id) return transfer.id;
      const nativeTxid = [transfer.txid, transfer.info?.txID, transfer.info?.txId]
        .find((value) => value != null && String(value).trim().length > 0);
      const nativeIndex = [transfer.info?.txIndex, transfer.info?.id, transfer.info?.depositId, transfer.id]
        .find((value) => value != null && String(value).trim().length > 0);
      if (nativeTxid != null) {
        return `bybit:${String(nativeTxid)}${nativeIndex != null ? `:${String(nativeIndex)}` : ''}`;
      }
      return transfer.id ?? exchangeSourceRef('bybit', floorToSeconds(ts), type, asset, amount);
    }
  }
}

/**
 * Whether a unified transfer actually settled. Verify-at-build finding: ccxt
 * 4.5.68's binance leaks RAW numeric statuses ('1' deposit credited / '6'
 * completed) because parseTransactionStatusByType needs a type the capital
 * endpoints don't carry; the other exchanges map to 'ok' properly. Binance
 * settled sets are per-kind ('1' means ok for deposits but CANCELED for
 * withdrawals).
 */
function isSettledTransfer(exchange: ExchangeId, type: TxType, status: string | undefined): boolean {
  if (status === 'ok') return true;
  if (exchange === 'binance') {
    return type === 'transfer_in' ? status === '1' || status === '6' : status === '6';
  }
  return false;
}

/**
 * Normalize one transfer (all supported exchanges) — §B-5d, mirrors
 * binanceTransfers.ts. Returns null when the transfer is unsettled
 * (status !== 'ok' → counted as skippedUnsettled by the engine) or invalid.
 */
export function normalizeTransfer(exchange: ExchangeId, transfer: UnifiedTransfer): Transaction | null {
  const infoType = transfer.info?.type;
  let type: TxType | null =
    transfer.type === 'deposit' ? 'transfer_in' : transfer.type === 'withdrawal' ? 'transfer_out' : null;
  // Verify-at-build finding: ccxt 4.5.68 coinbase parses v2 'send' rows as
  // unified 'deposit' (positive network.transaction_amount). The raw
  // info.type is authoritative for direction.
  if (exchange === 'coinbase') {
    if (infoType === 'send') type = 'transfer_out';
    else if (infoType === 'receive') type = 'transfer_in';
  }
  if (!type || !isSettledTransfer(exchange, type, transfer.status)) return null;
  const ts = transfer.timestamp;
  const asset = transfer.currency?.toUpperCase();
  const amount = transfer.amount != null ? Math.abs(transfer.amount) : 0;
  if (!type || ts == null || !Number.isFinite(ts) || !asset || !(amount > 0)) return null;

  const network = transfer.network || undefined;
  const chain = normalizeChain(network);
  const txid = transfer.txid;
  // Same guard as the CSV parser: only keep a hash that is real and matches
  // the row chain's shape, so explorer links never break.
  const txHash = txid && isRealTxHash(txid) && isValidTxHashForChain(chain, txid) ? txid : undefined;
  const address = transfer.addressTo ?? transfer.address;

  const feeCost = transfer.fee?.cost != null ? Math.abs(transfer.fee.cost) : undefined;
  const feeAsset = (transfer.fee?.currency ?? asset).toUpperCase();

  return {
    id: makeId(ID_PREFIX[exchange]),
    timestamp: ts,
    type,
    asset,
    amount,
    feeAmount: feeCost != null && feeCost > 0 ? feeCost : undefined,
    feeAsset: feeCost != null && feeCost > 0 ? feeAsset : undefined,
    fiatCurrency: 'USD',
    fiatValue: undefined,
    source: `${exchange}_api`,
    sourceRef: transferSourceRef(exchange, transfer, type, asset, amount, ts),
    txHash,
    // Exchange deposit addresses belong to centralized custody; they are not
    // watched self-custody wallets and must never drive wallet reconciliation.
    counterpartyAddress: type === 'transfer_out' && address ? address : undefined,
    chain,
    notes: `${type === 'transfer_in' ? 'Deposit' : 'Withdrawal'}${network ? ` via ${network}` : ''}`,
    flags: ['possible_internal_transfer'],
    isInternalTransfer: false,
    raw: {
      txid,
      txIndex: transfer.info?.txIndex,
      refid: typeof transfer.info?.refid === 'string' ? transfer.info.refid : undefined,
      transferId: transfer.id,
      exchangeAddress: address
    }
  };
}
