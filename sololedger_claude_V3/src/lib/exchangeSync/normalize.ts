/**
 * Exchange Auto-Sync — unified-ccxt → Transaction normalizer.
 *
 * PURE module (no ccxt/db/saas runtime imports): it consumes ccxt's unified
 * structures (as structural types) and produces rows that mirror the existing
 * CSV parsers' semantics EXACTLY, so the shared dedup machinery collapses
 * API↔CSV twins (plan §B-5).
 *
 * Classification parity notes:
 * - Trades (binance/coinbase/okx/kucoin) mirror binanceSpot.ts per-fill
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
  kucoin: 'exkc'
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
  }
}

/**
 * Normalize one per-fill trade (binance/coinbase/okx/kucoin) — §B-5a.
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
    flags: fiatValue != null && fiatValue > 0 ? [] : ['missing_cost_basis'],
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
    const cost = fills.reduce((s, f) => s + (f.cost ?? (f.price != null && f.amount != null ? f.price * f.amount : 0)), 0);

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
    let counterAmount: number;
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
        txAmount = cost;
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
  }
}

/**
 * Whether a unified transfer actually settled. Verify-at-build finding: ccxt
 * 4.5.68's binance leaks RAW numeric statuses ('1' deposit credited / '6'
 * completed) because parseTransactionStatusByType needs a type the capital
 * endpoints don't carry; the other four map to 'ok' properly. Binance
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
 * Normalize one transfer (all five exchanges) — §B-5d, mirrors
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
    // Withdrawal address is the destination (counterparty); a deposit address
    // is the user's own exchange deposit address (wallet side).
    counterpartyAddress: type === 'transfer_out' && address ? address : undefined,
    walletAddress: type === 'transfer_in' && address ? address : undefined,
    chain,
    notes: `${type === 'transfer_in' ? 'Deposit' : 'Withdrawal'}${network ? ` via ${network}` : ''}`,
    flags: ['possible_internal_transfer'],
    isInternalTransfer: false,
    raw: { txid, refid: typeof transfer.info?.refid === 'string' ? transfer.info.refid : undefined }
  };
}
