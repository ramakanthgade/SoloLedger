/**
 * CoinSwitch (India CEX) CSV parser.
 *
 * ASSUMED SCHEMA (validate against a real CoinSwitch export — see AUTHORING.md).
 * CoinSwitch is INR-first; its unified history export uses `Trading Pair` for
 * the market and a `Type` column (TRADE / DEPOSIT / WITHDRAWAL). Trade rows
 * fill trading-pair/side/price; transfer rows fill currency/amount. All
 * timestamps are IST (UTC+5:30) unless the cell carries an offset.
 *
 *   Date, Type, Trading Pair, Side, Price, Quantity, Total INR, Currency,
 *   Amount, Fee, Fee Currency, TDS Amount, TDS Currency, Reference ID, Remarks
 *
 * CoinSwitch's distinguishing header is `Trading Pair`.
 */
import { makeIndiaCexParser, normHeaders } from './indiaCex';

export const coinswitchParser = makeIndiaCexParser({
  id: 'coinswitch',
  label: 'CoinSwitch',
  source: 'coinswitch',
  refSource: 'coinswitch',
  detect(headers) {
    const h = normHeaders(headers);
    const hasPair = h.includes('tradingpair');
    const hasType = h.some((x) => x === 'type' || x === 'txntype' || x === 'transactiontype');
    return hasPair && hasType;
  }
});
