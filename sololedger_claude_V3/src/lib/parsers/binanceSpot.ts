import type { Transaction } from '@/types/transaction';
import { makeId, safeNumber, safeTimestamp, type ExchangeParser } from './types';
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
    const pairCol = col(map, 'pair', 'symbol', 'market');
    const sideCol = col(map, 'side', 'type', 'direction');
    const priceCol = col(map, 'price', 'avgprice', 'averageprice');
    const amountCol = col(map, 'amount', 'qty', 'quantity', 'executed');
    const totalCol = col(map, 'total', 'quoteqty', 'quotequantity', 'value');
    const feeCol = col(map, 'fee', 'commission');
    const feeCoinCol = col(map, 'feecoin', 'commissionasset', 'feecurrency');

    if (!timeCol || !pairCol || !sideCol || !amountCol) {
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

      const timestamp = safeTimestamp(row[timeCol]);
      const pairRaw = (row[pairCol] || '').trim();
      const { base, quote } = parseTradingPair(pairRaw);
      const qty = Math.abs(safeNumber(row[amountCol]));
      const price = priceCol ? Math.abs(safeNumber(row[priceCol])) : 0;
      const total = totalCol ? Math.abs(safeNumber(row[totalCol])) : 0;

      if (!base || !Number.isFinite(timestamp) || qty === 0) {
        skippedRows++;
        continue;
      }

      let fiatValue: number | undefined;
      let fiatCurrency = quoteToFiatCurrency(quote) ?? 'USD';
      if (total > 0) {
        fiatValue = total;
      } else if (price > 0 && qty > 0) {
        fiatValue = price * qty;
      }

      const feeAmount = feeCol ? Math.abs(safeNumber(row[feeCol])) : undefined;
      const feeAsset = feeCoinCol ? (row[feeCoinCol] || '').trim().toUpperCase() : undefined;

      transactions.push({
        id: makeId('bnspot'),
        timestamp,
        type: isBuy ? 'buy' : 'sell',
        asset: base,
        amount: qty,
        counterAsset: quote,
        counterAmount: total > 0 ? total : price > 0 ? price * qty : undefined,
        fiatCurrency,
        fiatValue,
        feeAmount: feeAmount && feeAmount > 0 ? feeAmount : undefined,
        feeAsset: feeAsset || undefined,
        source: 'binance_spot',
        sourceRef: `row:${i}`,
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
