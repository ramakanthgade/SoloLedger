/**
 * crossDetection.test.ts
 * ======================
 * Regression guard against parser cross-talk for the ten newer exchange
 * parsers (kraken … coinspot). For each exchange's real export header set:
 *
 *  1. Its own parser must detect it.
 *  2. No OTHER parser may claim it ahead of its own parser in registry order
 *     (the winner of `PARSERS.find` must be its own parser — this also proves
 *     the loose generic fallback never pre-claims one of these files).
 *  3. None of the other nine new-exchange parsers detects it at all.
 */
import { describe, expect, it } from 'vitest';
import { PARSERS } from './index';
import type { ExchangeParser } from './types';
import { krakenParser } from './kraken';
import { kucoinParser } from './kucoin';
import { cryptocomParser } from './cryptocom';
import { bybitParser } from './bybit';
import { okxParser } from './okx';
import { gateioParser } from './gateio';
import { bitfinexParser } from './bitfinex';
import { geminiParser } from './gemini';
import { htxParser } from './htx';
import { coinspotParser } from './coinspot';

const REAL_HEADER_SETS: { parser: ExchangeParser; headers: string[] }[] = [
  {
    parser: krakenParser,
    headers: ['txid', 'refid', 'time', 'type', 'subtype', 'asset', 'amount', 'fee', 'balance']
  },
  {
    parser: kucoinParser,
    headers: ['time', 'tradeId', 'symbol', 'side', 'price', 'size', 'funds', 'fee', 'feeCurrency']
  },
  {
    parser: cryptocomParser,
    headers: ['Timestamp (UTC)', 'Transaction Description', 'Currency', 'Amount', 'To Currency', 'To Amount', 'Native Currency', 'Native Amount', 'Native Amount (in USD)', 'Transaction Kind', 'Transaction Hash']
  },
  {
    parser: bybitParser,
    headers: ['Time', 'Symbol', 'Side', 'Volume', 'Price', 'Total', 'Fee', 'Fee Currency', 'Order ID']
  },
  {
    parser: okxParser,
    headers: ['time', 'type', 'pair', 'side', 'fillSz', 'fillPx', 'fee', 'feeCcy', 'ordId']
  },
  {
    parser: gateioParser,
    headers: ['ID', 'Time', 'Pair', 'Type', 'Amount', 'Fee', 'Fee Currency', 'Total']
  },
  {
    parser: bitfinexParser,
    headers: ['#', 'Date', 'Pair', 'Amount', 'Price', 'Fee', 'Fee Currency']
  },
  {
    // Real Gemini exports label the time column "Time (UTC)".
    parser: geminiParser,
    headers: ['Date', 'Time (UTC)', 'Type', 'Symbol', 'Quantity', 'Price', 'Fee', 'Total']
  },
  {
    parser: htxParser,
    headers: ['id', 'time', 'symbol', 'type', 'amount', 'price', 'filled', 'fee', 'fee-asset', 'order-id']
  },
  {
    parser: coinspotParser,
    headers: ['Date', 'Action', 'Coin', 'Amount', 'Rate', 'AUD', 'AUD Fee']
  }
];

describe('exchange parser cross-detection', () => {
  it('each parser detects its own real export headers', () => {
    for (const { parser, headers } of REAL_HEADER_SETS) {
      expect(parser.detect(headers)).toBe(true);
    }
  });

  it('every header set is claimed first by its own parser (generic fallback never pre-claims)', () => {
    for (const { parser, headers } of REAL_HEADER_SETS) {
      const winner = PARSERS.find((p) => p.detect(headers));
      expect(winner?.id).toBe(parser.id);
    }
  });

  it('none of the other new-exchange parsers claims another exchange\'s headers', () => {
    for (const { parser: owner, headers } of REAL_HEADER_SETS) {
      for (const { parser: other } of REAL_HEADER_SETS) {
        if (other.id === owner.id) continue;
        expect(other.detect(headers)).toBe(false);
      }
    }
  });
});
