import type { ExchangeParser } from './types';
import { stitchBinanceTransactionHistory } from './binanceStitch';

/**
 * Binance "Transaction History" / "Transaction Record" export.
 * Wallet → Transaction History → Export (or Orders → Export Transaction Records).
 *
 * Each spot trade appears as 3+ ledger rows (Buy + Spend + Fee, or Sold + Revenue + Fee).
 * We stitch those into single buy/sell rows with fiat cost/proceeds — same approach as Koinly/CoinTracker.
 */
export const binanceParser: ExchangeParser = {
  id: 'binance',
  label: 'Binance Transaction History',

  detect(headers) {
    const h = headers.map((x) => x.toLowerCase());
    return h.some((x) => x.includes('operation')) && h.some((x) => x === 'coin') && h.some((x) => x === 'change');
  },

  parse(rows) {
    return stitchBinanceTransactionHistory(rows);
  }
};
