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

    it('detects mixed-case and punctuation-variant headers', () => {
      const headers = ['TxID', 'Ref ID', 'Time', 'Type', 'Subtype', 'Asset', 'Amount', 'Fee', 'Balance'];
      expect(krakenParser.detect(headers)).toBe(true);
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

    it('parses bare ledger timestamps as UTC, not local time', () => {
      const rows = [{
        txid: 'U1',
        refid: 'REF_U1',
        time: '2024-06-15 14:30:00',
        type: 'deposit',
        subtype: '',
        asset: 'XBT',
        amount: '0.5',
        fee: '0',
        balance: '0.5',
      }];

      const result = krakenParser.parse(rows);
      expect(result.transactions).toHaveLength(1);
      // Kraken ledger time is documented UTC — must match the exact UTC epoch
      // (this fails if the string is parsed in the machine's local zone).
      expect(result.transactions[0].timestamp).toBe(Date.UTC(2024, 5, 15, 14, 30, 0));
    });

    it('emits trade with no fiatValue for crypto-to-crypto pairs', () => {
      const rows = [
        {
          txid: 'C1', refid: 'TRADE_C2C', time: '2025-05-01 10:00:00', type: 'trade',
          subtype: '', asset: 'XBT', amount: '-0.1', fee: '0', balance: '0.9',
        },
        {
          txid: 'C2', refid: 'TRADE_C2C', time: '2025-05-01 10:00:00', type: 'trade',
          subtype: '', asset: 'XETH', amount: '2', fee: '0', balance: '2',
        },
      ];

      const result = krakenParser.parse(rows);
      expect(result.transactions).toHaveLength(1);
      const tx = result.transactions[0];
      expect(tx.type).toBe('trade');
      expect(tx.asset).toBe('ETH');
      expect(tx.amount).toBeCloseTo(2);
      expect(tx.counterAsset).toBe('BTC');
      expect(tx.counterAmount).toBeCloseTo(0.1);
      // No fiat leg → no fiat value; the pricing layer backfills FMV.
      expect(tx.fiatValue).toBeUndefined();
    });

    it('values fiat pairs in the fiat leg currency (EUR, not hardcoded USD)', () => {
      const rows = [
        {
          txid: 'E1', refid: 'TRADE_EUR', time: '2025-05-02 10:00:00', type: 'trade',
          subtype: '', asset: 'XBT', amount: '-0.1', fee: '0', balance: '0.9',
        },
        {
          txid: 'E2', refid: 'TRADE_EUR', time: '2025-05-02 10:00:00', type: 'trade',
          subtype: '', asset: 'ZEUR', amount: '9000', fee: '0', balance: '9000',
        },
      ];

      const result = krakenParser.parse(rows);
      expect(result.transactions).toHaveLength(1);
      const tx = result.transactions[0];
      expect(tx.type).toBe('sell');
      expect(tx.asset).toBe('BTC');
      expect(tx.fiatCurrency).toBe('EUR');
      expect(tx.fiatValue).toBeCloseTo(9000);
    });

    it('values a fiat-funded buy in the spent fiat currency', () => {
      const rows = [
        {
          txid: 'B1', refid: 'TRADE_BUY_EUR', time: '2025-05-02 11:00:00', type: 'trade',
          subtype: '', asset: 'XETH', amount: '0.5', fee: '0', balance: '0.5',
        },
        {
          txid: 'B2', refid: 'TRADE_BUY_EUR', time: '2025-05-02 11:00:00', type: 'trade',
          subtype: '', asset: 'ZEUR', amount: '-800', fee: '0', balance: '200',
        },
      ];

      const tx = krakenParser.parse(rows).transactions[0];
      expect(tx.type).toBe('buy');
      expect(tx.asset).toBe('ETH');
      expect(tx.fiatCurrency).toBe('EUR');
      expect(tx.fiatValue).toBeCloseTo(800);
    });

    it('skips same-sign trade leg groups with a warning instead of crashing', () => {
      const rows = [
        {
          txid: 'S1', refid: 'TRADE_BAD', time: '2025-05-03 10:00:00', type: 'trade',
          subtype: '', asset: 'XBT', amount: '-0.1', fee: '0', balance: '0.9',
        },
        {
          txid: 'S2', refid: 'TRADE_BAD', time: '2025-05-03 10:00:00', type: 'trade',
          subtype: '', asset: 'XBT', amount: '-0.2', fee: '0', balance: '0.7',
        },
      ];

      const result = krakenParser.parse(rows);
      expect(result.transactions).toHaveLength(0);
      expect(result.skippedRows).toBe(2);
      expect(result.warnings.some((w) => w.includes('TRADE_BAD'))).toBe(true);
    });

    it('aggregates all legs per sign for multi-fill groups sharing a refid', () => {
      const rows = [
        {
          txid: 'M1', refid: 'TRADE_FILL', time: '2025-05-04 10:00:00', type: 'trade',
          subtype: '', asset: 'XBT', amount: '-0.05', fee: '0', balance: '0.95',
        },
        {
          txid: 'M2', refid: 'TRADE_FILL', time: '2025-05-04 10:00:01', type: 'trade',
          subtype: '', asset: 'XBT', amount: '-0.05', fee: '0', balance: '0.9',
        },
        {
          txid: 'M3', refid: 'TRADE_FILL', time: '2025-05-04 10:00:01', type: 'trade',
          subtype: '', asset: 'ZUSD', amount: '5000', fee: '5', balance: '5000',
        },
      ];

      const result = krakenParser.parse(rows);
      expect(result.transactions).toHaveLength(1);
      const tx = result.transactions[0];
      expect(tx.type).toBe('sell');
      expect(tx.amount).toBeCloseTo(0.1);
      expect(tx.counterAmount).toBeCloseTo(5000);
      expect(tx.fiatValue).toBeCloseTo(5000);
      // All fees are USD-denominated → summed under USD.
      expect(tx.feeAmount).toBeCloseTo(5);
      expect(tx.feeAsset).toBe('USD');
    });

    it('drops stitched fees when legs charge fees in different assets', () => {
      const rows = [
        {
          txid: 'F1', refid: 'TRADE_FEE', time: '2025-05-05 10:00:00', type: 'trade',
          subtype: '', asset: 'XBT', amount: '-0.1', fee: '0.0001', balance: '0.9',
        },
        {
          txid: 'F2', refid: 'TRADE_FEE', time: '2025-05-05 10:00:00', type: 'trade',
          subtype: '', asset: 'ZUSD', amount: '5000', fee: '2.5', balance: '5000',
        },
      ];

      const tx = krakenParser.parse(rows).transactions[0];
      // BTC fee + USD fee must not be summed under a single asset label.
      expect(tx.feeAmount).toBeUndefined();
      expect(tx.feeAsset).toBeUndefined();
    });
  });
});
