/**
 * Generic + WazirX-style spot trade history sheets.
 *
 * Typical columns (WazirX "Exchange Trades"):
 *   Date, Market, Price, Volume, Total (Price x Volume), Trade Type,
 *   Fee Paid in, Fee Amount, TDS Paid in, TDS Amount, TDS In INR
 *
 * Also matches similar Market/Pair + Side/Trade Type + Volume exports from other exchanges.
 */
import type { Transaction } from '@/types/transaction';
import {
  makeId,
  safeQuantity,
  safeTimestampIst,
  exchangeSourceRef,
  type ExchangeParser
} from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
import { headerMap, col, colIncludes } from './headerMap';

function norms(headers: string[]): string[] {
  return headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

export const wazirxTradesParser: ExchangeParser = {
  id: 'wazirx_trades',
  label: 'Exchange Spot Trades',

  detect(headers) {
    const h = norms(headers);
    const hasMarket = h.some((x) => x === 'market' || x === 'pair' || x === 'symbol');
    const hasTradeType = h.some(
      (x) => x === 'tradetype' || x === 'side' || x === 'type' || x === 'buysell'
    );
    const hasVolume = h.some((x) => x === 'volume' || x === 'qty' || x === 'quantity' || x === 'amount');
    const hasPrice = h.some((x) => x === 'price' || x.includes('total'));
    // Prefer WazirX-like: Market + Trade Type + Volume (Binance spot uses Pair/Side/Executed)
    const looksWazirx =
      h.includes('market') &&
      (h.includes('tradetype') || h.some((x) => x.includes('tradetype'))) &&
      h.includes('volume');
    const looksGenericSpot = hasMarket && hasTradeType && hasVolume && hasPrice;
    return looksWazirx || (looksGenericSpot && h.includes('feepaidin'));
  },

  parse(rows) {
    const transactions: Transaction[] = [];
    const warnings: string[] = [];
    let skippedRows = 0;

    if (rows.length === 0) {
      return { transactions, skippedRows: 0, warnings: ['Sheet has no data rows.'] };
    }

    const map = headerMap(Object.keys(rows[0]));
    const timeCol = col(map, 'date', 'datetime', 'timestamp', 'time') ?? colIncludes(map, 'date');
    const pairCol = col(map, 'market', 'pair', 'symbol');
    const sideCol =
      col(map, 'tradetype', 'side', 'buysell') ?? colIncludes(map, 'tradetype', 'side');
    const priceCol = col(map, 'price');
    const volumeCol = col(map, 'volume', 'qty', 'quantity', 'amount');
    const totalCol =
      col(map, 'totalpricexvolume', 'total', 'quoteqty') ?? colIncludes(map, 'total');
    const feeCol = col(map, 'feeamount', 'fee', 'commission') ?? colIncludes(map, 'feeamount');
    const feeAssetCol =
      col(map, 'feepaidin', 'feecoin', 'feeasset', 'commissionasset') ??
      colIncludes(map, 'feepaidin', 'feecoin');
    const tdsAmountCol = col(map, 'tdsamount') ?? colIncludes(map, 'tdsamount');
    const tdsAssetCol = col(map, 'tdspaidin') ?? colIncludes(map, 'tdspaidin');
    const tdsInrCol = col(map, 'tdsininr') ?? colIncludes(map, 'tdsininr');

    if (!timeCol || !pairCol || !sideCol || !volumeCol) {
      return {
        transactions: [],
        skippedRows: rows.length,
        warnings: ['Spot trade columns not found (need Date, Market/Pair, Trade Type, Volume).']
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

      const timestamp = safeTimestampIst(row[timeCol]);
      const pairRaw = (row[pairCol] || '').trim();
      const { base, quote } = parseTradingPair(pairRaw);
      const qty = safeQuantity(row[volumeCol]);
      const price = priceCol ? safeQuantity(row[priceCol]) : 0;
      const quoteTotal = totalCol ? safeQuantity(row[totalCol]) : 0;

      if (!base || !Number.isFinite(timestamp) || qty === 0) {
        skippedRows++;
        continue;
      }

      const fiatCurrency = quoteToFiatCurrency(quote) ?? 'INR';
      let fiatValue: number | undefined;
      if (quoteTotal > 0 && quoteToFiatCurrency(quote)) {
        fiatValue = quoteTotal;
      } else if (price > 0 && qty > 0 && quoteToFiatCurrency(quote)) {
        fiatValue = price * qty;
      } else if (quoteTotal > 0 && quote === 'INR') {
        fiatValue = quoteTotal;
      }

      const feeAmount = feeCol ? safeQuantity(row[feeCol]) : undefined;
      const feeAsset = feeAssetCol ? (row[feeAssetCol] || '').trim().toUpperCase() : undefined;
      const tdsAmount = tdsAmountCol ? safeQuantity(row[tdsAmountCol]) : 0;
      const tdsAsset = tdsAssetCol ? (row[tdsAssetCol] || '').trim().toUpperCase() : '';
      const tdsInr = tdsInrCol ? safeQuantity(row[tdsInrCol]) : 0;

      const notesParts = [`Pair ${pairRaw}`];
      if (tdsAmount > 0) {
        notesParts.push(`TDS ${tdsAmount}${tdsAsset ? ' ' + tdsAsset : ''}${tdsInr > 0 ? ` (≈₹${tdsInr})` : ''}`);
      }

      transactions.push({
        id: makeId('wxtrade'),
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
        source: 'wazirx_trades',
        sourceRef: exchangeSourceRef('wazirx', timestamp, isBuy ? 'buy' : 'sell', base, qty),
        notes: notesParts.join(' · '),
        flags: fiatValue != null && fiatValue > 0 ? [] : ['missing_cost_basis'],
        isInternalTransfer: false,
        raw: { ...row, _sheetFormat: 'exchange_trades' }
      });
    }

    if (skippedRows > 0) {
      warnings.push(`${skippedRows} trade row(s) skipped — unrecognized side or missing data.`);
    }

    return { transactions, skippedRows, warnings };
  }
};
