/**
 * kraken.test.ts
 * ==============
 * Tests for Kraken Ledger CSV parser.
 */

import { describe, it, expect } from 'vitest';
import { krakenParser } from './kraken';

describe('krakenParser', () => {
  describe('detect', () => {
    it('detects Kraken ledger headers', () => {
      const headers = ['txid', 'refid', 'time', 'type', 'subtype', 'asset', 'amount', 'fee', 'balance'];
      expect(krakenParser.detect(headers)).toBe(true);
    });

    it('rejects non-Kraken headers', () => {
      const headers = ['Date', 'Type', 'Symbol', 'Quantity', 'Price'];
      expect(krakenParser.detect(headers)).toBe(false);
    });
  });

  describe('parse', () => {
    it('parses a deposit row', () => {
      const rows = [{
        txid: 'ABC123',
        refid: 'REF1',
        time: '2025-01-15 10:30:00',
        type: 'deposit',
        subtype: '',
        asset: 'XBT',
        amount: '0.5',
        fee: '0',
        balance: '0.5',
      }];

      const result = krakenParser.parse(rows);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        type: 'transfer_in',
        asset: 'BTC',
        amount: 0.5,
        source: 'kraken',
      });
    });

    it('parses a withdrawal row', () => {
      const rows = [{
        txid: 'DEF456',
        refid: 'REF2',
        time: '2025-02-01 14:00:00',
        type: 'withdrawal',
        subtype: '',
        asset: 'ETH',
        amount: '-2.0',
        fee: '0.005',
        balance: '10.0',
      }];

      const result = krakenParser.parse(rows);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        type: 'transfer_out',
        asset: 'ETH',
        amount: 2.0,
        feeAmount: 0.005,
      });
    });

    it('parses staking income', () => {
      const rows = [{
        txid: 'GHI789',
        refid: 'REF3',
        time: '1704067200',
        type: 'staking',
        subtype: '',
        asset: 'DOT',
        amount: '1.5',
        fee: '0',
        balance: '100.0',
      }];

      const result = krakenParser.parse(rows);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0]).toMatchObject({
        type: 'income',
        asset: 'DOT',
        amount: 1.5,
      });
    });

    it('stitches a trade from two rows sharing the same refid', () => {
      const rows = [
        {
          txid: 'TRADE1',
          refid: 'TRADE_ABC',
          time: '2025-03-10 09:00:00',
          type: 'trade',
          subtype: '',
          asset: 'XBT',
          amount: '-0.1',
          fee: '0.001',
          balance: '0.4',
        },
        {
          txid: 'TRADE2',
          refid: 'TRADE_ABC',
          time: '2025-03-10 09:00:00',
          type: 'trade',
          subtype: '',
          asset: 'ZUSD',
          amount: '5000',
          fee: '2.5',
          balance: '10000',
        },
      ];

      const result = krakenParser.parse(rows);
      // 2 trade legs should become 1 stitched transaction
      expect(result.transactions).toHaveLength(1);

      const tx = result.transactions[0];
      expect(tx.type).toBe('sell');
      expect(tx.asset).toBe('BTC');
      expect(tx.amount).toBeCloseTo(0.1);
      expect(tx.counterAsset).toBe('USD');
      expect(tx.counterAmount).toBeCloseTo(5000);
      expect(tx.source).toBe('kraken');
      expect(tx.sourceRef).toBe('TRADE_ABC');
    });

    it('stitches a buy trade (receive crypto, send fiat)', () => {
      const rows = [
        {
          txid: 'TRADE3',
          refid: 'TRADE_DEF',
          time: '2025-04-01 12:00:00',
          type: 'trade',
          subtype: '',
          asset: 'ETH',
          amount: '2.0',
          fee: '0.01',
          balance: '5.0',
        },
        {
          txid: 'TRADE4',
          refid: 'TRADE_DEF',
          time: '2025-04-01 12:00:00',
          type: 'trade',
          subtype: '',
          asset: 'ZUSD',
          amount: '-6000',
          fee: '3.0',
          balance: '4000',
        },
      ];

      const result = krakenParser.parse(rows);
      expect(result.transactions).toHaveLength(1);
      const tx = result.transactions[0];
      expect(tx.type).toBe('buy');
      expect(tx.asset).toBe('ETH');
      expect(tx.amount).toBeCloseTo(2.0);
      expect(tx.counterAsset).toBe('USD');
      expect(tx.counterAmount).toBeCloseTo(6000);
    });

    it('normalizes Kraken asset codes', () => {
      const rows = [{
        txid: 'XBT1',
        refid: 'REF_XBT',
        time: '2025-01-01',
        type: 'deposit',
        subtype: '',
        asset: 'XXBT',
        amount: '1.0',
        fee: '0',
        balance: '1.0',
      }];

      const result = krakenParser.parse(rows);
      expect(result.transactions[0].asset).toBe('BTC');
    });

    it('skips rows with missing or empty data', () => {
      const rows = [{
        txid: '',
        refid: '',
        time: '',
        type: '',
        subtype: '',
        asset: '',
        amount: '',
        fee: '0',
        balance: '',
      }];

      const result = krakenParser.parse(rows);
      expect(result.skippedRows).toBe(1);
      expect(result.transactions).toHaveLength(0);
    });

    it('handles mixed row types (deposits, trades, staking together)', () => {
      const rows = [
        {
          txid: 'D1',
          refid: 'REF_D1',
          time: '2025-01-01',
          type: 'deposit',
          subtype: '',
          asset: 'XBT',
          amount: '1.0',
          fee: '0',
          balance: '1.0',
        },
        {
          txid: 'T1',
          refid: 'REF_TRADE',
          time: '2025-01-02',
          type: 'trade',
          subtype: '',
          asset: 'XBT',
          amount: '-0.5',
          fee: '0.002',
          balance: '0.5',
        },
        {
          txid: 'T2',
          refid: 'REF_TRADE',
          time: '2025-01-02',
          type: 'trade',
          subtype: '',
          asset: 'ZUSD',
          amount: '25000',
          fee: '5',
          balance: '50000',
        },
        {
          txid: 'S1',
          refid: 'REF_S1',
          time: '2025-01-03',
          type: 'staking',
          subtype: '',
          asset: 'DOT',
          amount: '0.5',
          fee: '0',
          balance: '100.5',
        },
      ];

      const result = krakenParser.parse(rows);
      // 1 deposit + 1 stitched trade (from 2 legs) + 1 staking = 3 transactions
      expect(result.transactions).toHaveLength(3);
      expect(result.skippedRows).toBe(0);
    });
  });
});
