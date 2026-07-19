import type { Transaction, TxType } from '@/types/transaction';
import { exchangeSourceRef, makeId, safeEpochTimestamp, safeNumber, type ExchangeParser } from './types';
import { parseTradingPair, quoteToFiatCurrency } from './pairUtils';
import { normalizeHeader } from './tableExtract';
import { rowCol } from './headerMap';

const TYPE_MAP: Record<string, TxType> = {
  buy: 'buy', sell: 'sell', deposit: 'transfer_in', withdraw: 'transfer_out', staking: 'income'
};

export const kucoinParser: ExchangeParser = {
  id: 'kucoin', label: 'KuCoin',
  detect(headers) {
    const h = new Set(headers.map(normalizeHeader));
    return ['tradeid', 'symbol', 'side', 'funds', 'feecurrency'].every((x) => h.has(x));
  },
  parse(rows) {
    const transactions: Transaction[] = [];
    let skippedRows = 0;
    for (const row of rows) {
      const rawType = rowCol(row, 'side', 'type').trim().toLowerCase();
      const type = TYPE_MAP[rawType];
      const pair = parseTradingPair(rowCol(row, 'symbol'));
      const asset = (pair.base || rowCol(row, 'feeCurrency')).toUpperCase();
      const amount = Math.abs(safeNumber(rowCol(row, 'size', 'amount')));
      const ts = safeEpochTimestamp(rowCol(row, 'time', 'timestamp'));
      if (!type || !asset || !amount || !Number.isFinite(ts)) { skippedRows += 1; continue; }
      const total = Math.abs(safeNumber(rowCol(row, 'funds', 'total')));
      const fee = Math.abs(safeNumber(rowCol(row, 'fee')));
      const transfer = type === 'transfer_in' || type === 'transfer_out';
      const quoteFiat = quoteToFiatCurrency(pair.quote);
      transactions.push({
        id: makeId('kc'), timestamp: ts, type, asset, amount,
        counterAsset: pair.quote, counterAmount: total || undefined,
        fiatCurrency: quoteFiat ?? 'USD',
        fiatValue: quoteFiat ? (total || undefined) : undefined,
        feeAmount: fee || undefined, feeAsset: fee ? rowCol(row, 'feeCurrency').toUpperCase() || pair.quote : undefined,
        source: 'kucoin', sourceRef: rowCol(row, 'tradeId', 'orderId') || exchangeSourceRef('kucoin', ts, type, asset, amount),
        flags: transfer ? ['possible_internal_transfer'] : [], isInternalTransfer: false, raw: row
      });
    }
    return { transactions, skippedRows, warnings: skippedRows ? [`${skippedRows} row(s) skipped — unrecognized type or missing data.`] : [] };
  }
};

export default kucoinParser;
