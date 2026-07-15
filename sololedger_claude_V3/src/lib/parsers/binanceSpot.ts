import type { Transaction } from '@/types/transaction';
import {
  makeId,
  safeQuantity,
  safeTimestamp,
  safeTimestampUtc,
  exchangeSourceRef,
  type ExchangeParser
} from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';

/**
 * Binance Spot trade history export (Wallet → Orders → Trade History → Export).
 * Typical columns: Date(UTC), Pair, Side, Price, Amount, Total, Fee, Fee Coin
 */
function headerMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    map[h.toLowerCase().replace(/[^a-z0-9]/g, '')] = h;
  }
  return map;
}

function col(map: Record<string, string>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const hit = map[k.replace(/[^a-z0-9]/g, '')];
    if (hit) return hit;
  }
  return undefined;
}

export const binanceSpotParser: ExchangeParser = {
  id: 'binance_spot',
  label: 'Binance Spot Trades',

  detect(headers) {
    const h = headers.map((x) => x.toLowerCase());
    const hasPair = h.some((x) => x === 'pair' || x === 'symbol' || x === 'market');
    const hasSide = h.some((x) => x === 'side' || x === 'type');
    const hasPrice = h.some((x) => x === 'price' || x === 'avgprice' || x === 'averageprice');
    const hasAmount = h.some((x) => x === 'amount' || x === 'qty' || x === 'quantity' || x === 'executed');
    return hasPair && hasSide && (hasPrice || hasAmount);
  },

  parse(rows) {
    const transactions: Transaction[] = [];
    const warnings: string[] = [];
    let skippedRows = 0;

    if (rows.length === 0) {
      return { transactions, skippedRows: 0, warnings: ['File has no data rows.'] };
    }

    const map = headerMap(Object.keys(rows[0]));
    const timeCol = col(map, 'dateutc', 'time', 'datetime', 'timestamp', 'date');
    // Binance Spot exports label the trade time as "Date(UTC)". When the column
    // is UTC-documented (or has no explicit zone), parse it as UTC so timestamps
    // don't drift on a non-UTC machine.
    const timeIsUtc = !!timeCol && /utc/.test(timeCol.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const pairCol = col(map, 'pair', 'symbol', 'market');
    const sideCol = col(map, 'side', 'type', 'direction');
    const priceCol = col(map, 'price', 'avgprice', 'averageprice');
    // Binance Trade History uses Executed=crypto qty, Amount=quote total (opposite of some other exports)
    const executedCol = col(map, 'executed', 'qty', 'quantity');
    const amountCol = col(map, 'amount', 'total', 'quoteqty', 'quotequantity', 'value');
    const totalOnlyCol = col(map, 'total', 'quoteqty', 'quotequantity', 'value');
    const feeCol = col(map, 'fee', 'commission');
    const feeCoinCol = col(map, 'feecoin', 'commissionasset', 'feecurrency');

    const qtyCol = executedCol ?? amountCol;

    if (!timeCol || !pairCol || !sideCol || !qtyCol) {
      return {
        transactions: [],
        skippedRows: rows.length,
        warnings: ['Binance spot columns not found — try manual or AI mapping.']
      };
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rawSide = (row[sideCol] || '').trim().toLowerCase();
      const isBuy = rawSide.includes('buy') || rawSide === 'b';
      const isSell = rawSide.includes('sell') || rawSide === 's';
      if (!isBuy && !isSell) {
        skippedRows++;
        continue;
      }

      const timestamp = timeIsUtc ? safeTimestampUtc(row[timeCol]) : safeTimestamp(row[timeCol]);
      const pairRaw = (row[pairCol] || '').trim();
      const { base, quote } = parseTradingPair(pairRaw);
      const qty = safeQuantity(row[qtyCol]);
      const price = priceCol ? safeQuantity(row[priceCol]) : 0;
      // Quote total: prefer Amount column when Executed holds crypto; else Total/Amount
      const quoteTotal =
        executedCol && amountCol && amountCol !== executedCol
          ? safeQuantity(row[amountCol])
          : totalOnlyCol
            ? safeQuantity(row[totalOnlyCol])
            : 0;

      if (!base || !Number.isFinite(timestamp) || qty === 0) {
        skippedRows++;
        continue;
      }

      let fiatValue: number | undefined;
      let fiatCurrency = quoteToFiatCurrency(quote) ?? 'USD';
      if (quoteTotal > 0) {
        fiatValue = quoteTotal;
      } else if (price > 0 && qty > 0) {
        fiatValue = price * qty;
      }

      const feeAmount = feeCol ? safeQuantity(row[feeCol]) : undefined;
      const feeAsset = feeCoinCol ? (row[feeCoinCol] || '').trim().toUpperCase() : undefined;

      transactions.push({
        id: makeId('bnspot'),
        timestamp,
        type: isBuy ? 'buy' : 'sell',
        asset: base,
        amount: qty,
        counterAsset: quote,
        counterAmount: quoteTotal > 0 ? quoteTotal : price > 0 ? price * qty : undefined,
        fiatCurrency,
        fiatValue,
        feeAmount: feeAmount && feeAmount > 0 ? feeAmount : undefined,
        feeAsset: feeAsset || undefined,
        source: 'binance_spot',
        sourceRef: exchangeSourceRef('binance', timestamp, isBuy ? 'buy' : 'sell', base, qty),
        notes: pairRaw !== base ? `Pair ${pairRaw}` : undefined,
        flags: fiatValue != null && fiatValue > 0 ? [] : ['missing_cost_basis'],
        isInternalTransfer: false,
        raw: row
      });
    }

    if (skippedRows > 0) {
      warnings.push(`${skippedRows} row(s) skipped — unrecognized side or missing data.`);
    }
    if (transactions.some((t) => t.fiatValue == null)) {
      warnings.push(
        'Some rows have no fiat value — use Review → Fetch missing prices (needs CoinGecko key in Settings), or ensure your file has a Total column.'
      );
    }

    return { transactions, skippedRows, warnings };
  }
};
