import { describe, expect, it } from 'vitest';
import { canUseSymbolPrice, resolvePriceAsset } from './resolvePriceAsset';

describe('safety-aware price identity', () => {
  it('forbids symbol pricing for an unverified same-symbol contract', () => {
    const fake = '0x1111111111111111111111111111111111111111';
    expect(resolvePriceAsset('USDC', fake, 'ethereum', 'unverified')).toBe(fake);
    expect(canUseSymbolPrice(fake, 'unverified')).toBe(false);
  });
  it('allows canonical trusted contracts to use their exact known mapping', () => {
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    expect(resolvePriceAsset('anything', usdc, 'ethereum', 'trusted')).toBe('USDC');
  });
  it('prices Circle-issued Polygon native USDC as USDC', () => {
    expect(resolvePriceAsset(
      'USD Coin',
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      'polygon',
      'trusted'
    )).toBe('USDC');
  });
  it('does not inherit Polygon native USDC pricing on another EVM chain', () => {
    const contract = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
    expect(resolvePriceAsset('LOOKALIKE', contract, 'ethereum', 'trusted')).toBe('LOOKALIKE');
  });
  it('prices BNB Chain BUSD only on its exact chain and contract', () => {
    const contract = '0xe9e7cea3dedca5984780bafc599bd69add087d56';
    expect(resolvePriceAsset('Binance USD', contract, 'bsc', 'trusted')).toBe('BUSD');
    expect(resolvePriceAsset('LOOKALIKE', contract, 'ethereum', 'trusted')).toBe('LOOKALIKE');
  });
});
