/**
 * ZebPay (India CEX) CSV parser.
 *
 * ASSUMED SCHEMA (validate against a real ZebPay export — see AUTHORING.md).
 * ZebPay's unified history export uses `Symbol` for the trading pair and a
 * `Transaction Type` column (TRADE/BUY/SELL/DEPOSIT/WITHDRAWAL). Trade rows
 * fill symbol/side/price/quantity; transfer rows fill currency/amount. All
 * timestamps are IST (UTC+5:30) unless the cell carries an offset.
 *
 *   Date, Transaction Type, Symbol, Side, Price, Quantity, Value, Currency,
 *   Amount, Fee, Fee Currency, TDS, TDS Currency, Txn Hash, Remarks
 *
 * ZebPay's distinguishing headers are `Symbol` for the pair plus a
 * `Transaction Type` column.
 */
import { makeIndiaCexParser, normHeaders } from './indiaCex';

export const zebpayParser = makeIndiaCexParser({
  id: 'zebpay',
  label: 'ZebPay',
  source: 'zebpay',
  refSource: 'zebpay',
  detect(headers) {
    const h = normHeaders(headers);
    const hasSymbol = h.includes('symbol');
    const hasType = h.some((x) => x === 'transactiontype' || x === 'txntype' || x === 'type');
    const hasTradeCols = h.some((x) => x === 'side' || x === 'quantity' || x === 'price');
    return hasSymbol && hasType && hasTradeCols;
  }
});
