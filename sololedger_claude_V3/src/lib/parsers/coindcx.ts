/**
 * CoinDCX (India CEX) CSV parser.
 *
 * ASSUMED SCHEMA (validate against a real CoinDCX export — see AUTHORING.md).
 * A single unified "transaction history" export whose `Type` column is one of
 * TRADE / DEPOSIT / WITHDRAWAL. Trade rows fill the market/side/price columns;
 * deposit & withdrawal rows fill currency/amount and leave the trade columns
 * blank. All timestamps are IST (UTC+5:30) unless the cell carries an offset.
 *
 *   Date, Type, Market, Side, Price, Quantity, Total, Currency, Amount,
 *   Fee, Fee Currency, TDS Amount, TDS Currency, Transaction Hash, Remarks
 *
 * CoinDCX's distinguishing header is `Market` for the trading pair (e.g.
 * "BTCINR", "ETHUSDT") combined with a `Type` column.
 */
import { makeIndiaCexParser, normHeaders } from './indiaCex';

export const coindcxParser = makeIndiaCexParser({
  id: 'coindcx',
  label: 'CoinDCX',
  source: 'coindcx',
  refSource: 'coindcx',
  detect(headers) {
    const h = normHeaders(headers);
    const hasMarket = h.includes('market');
    const hasType = h.some((x) => x === 'type' || x === 'txntype' || x === 'transactiontype');
    const hasTradeCols = h.some((x) => x === 'side' || x === 'quantity' || x === 'price');
    return hasMarket && hasType && hasTradeCols;
  }
});
