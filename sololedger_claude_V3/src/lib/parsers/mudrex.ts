/**
 * Mudrex (India CEX) CSV parser.
 *
 * ASSUMED SCHEMA (validate against a real Mudrex export — see AUTHORING.md).
 * Mudrex's unified history export uses `Coin Pair` for the market and a `Type`
 * column (TRADE / DEPOSIT / WITHDRAWAL). Trade rows fill coin-pair/side/price/
 * executed-quantity; transfer rows fill currency/amount. All timestamps are
 * IST (UTC+5:30) unless the cell carries an offset.
 *
 *   Date, Type, Coin Pair, Side, Price, Quantity, Order Value INR, Currency,
 *   Amount, Fee, Fee Currency, TDS Amount, TDS INR, TDS Currency,
 *   Transaction Hash, Remarks
 *
 * Mudrex's distinguishing header is `Coin Pair`.
 */
import { makeIndiaCexParser, normHeaders } from './indiaCex';

export const mudrexParser = makeIndiaCexParser({
  id: 'mudrex',
  label: 'Mudrex',
  source: 'mudrex',
  refSource: 'mudrex',
  detect(headers) {
    const h = normHeaders(headers);
    const hasPair = h.includes('coinpair');
    const hasType = h.some((x) => x === 'type' || x === 'txntype' || x === 'transactiontype');
    return hasPair && hasType;
  }
});
