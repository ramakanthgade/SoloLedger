import { describe, it, expect } from 'vitest';
import {
  transactionExchangeKey,
  transactionSourceKey,
  transactionImportKey
} from '@/lib/storage/db';

describe('transactionExchangeKey', () => {
  it('builds an exchange key for recognised exchange sources with a sourceRef', () => {
    expect(transactionExchangeKey({ source: 'binance', sourceRef: 'abc123' })).toBe('ex:abc123');
    expect(transactionExchangeKey({ source: 'coinbase', sourceRef: 'ref-9' })).toBe('ex:ref-9');
    expect(transactionExchangeKey({ source: 'wazirx-spot', sourceRef: 'w1' })).toBe('ex:w1');
  });

  it('builds an exchange key for the newer exchange CSV parser sources', () => {
    const sources = ['kraken', 'kucoin', 'cryptocom', 'bybit', 'okx', 'gateio', 'bitfinex', 'gemini', 'htx', 'coinspot'];
    for (const source of sources) {
      expect(transactionExchangeKey({ source, sourceRef: 'row-1' })).toBe('ex:row-1');
    }
  });

  it('returns null when there is no sourceRef', () => {
    expect(transactionExchangeKey({ source: 'binance', sourceRef: undefined })).toBeNull();
  });

  it('returns null for non-exchange sources', () => {
    expect(transactionExchangeKey({ source: 'ethereum', sourceRef: 'x' })).toBeNull();
  });
});

describe('transactionSourceKey', () => {
  it('joins lowercased wallet, sourceRef and asset key', () => {
    const key = transactionSourceKey({
      sourceRef: '0xHASH',
      walletAddress: '0xABC',
      asset: 'eth',
      contractAddress: undefined
    });
    expect(key).toBe('0xabc|0xHASH|ETH');
  });

  it('prefers the contract address over the display symbol', () => {
    const key = transactionSourceKey({
      sourceRef: 'sig',
      walletAddress: '0xWallet',
      asset: 'USDC',
      contractAddress: '0xTokenContract'
    });
    expect(key).toBe('0xwallet|sig|0xtokencontract');
  });

  it('returns null without a wallet address', () => {
    expect(
      transactionSourceKey({
        sourceRef: 'sig',
        walletAddress: undefined,
        asset: 'ETH',
        contractAddress: undefined
      })
    ).toBeNull();
  });
});

describe('transactionImportKey', () => {
  it('includes a precision-stable amount (4dp for amounts >= 1)', () => {
    const key = transactionImportKey({
      sourceRef: 'sig',
      walletAddress: '0xWallet',
      asset: 'ETH',
      amount: 1.23456,
      contractAddress: undefined
    });
    // 4dp tier (reconciled with exchangeSourceRef/stableAmountKey) so a
    // re-import produces the same key regardless of import path.
    expect(key).toBe('sig|0xwallet|ETH|1.2346');
  });

  it('returns null when required fields are missing', () => {
    expect(
      transactionImportKey({
        sourceRef: undefined,
        walletAddress: '0xWallet',
        asset: 'ETH',
        amount: 1,
        contractAddress: undefined
      })
    ).toBeNull();
  });
});
