import { describe, expect, it } from 'vitest';
import {
  canUseSymbolPrice,
  canonicalCustodyPriceAsset,
  resolvePriceAsset
} from './resolvePriceAsset';

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
  it.each([
    ['0x5ee5bf7ae06d1be5997a1a72006fe6c607ec6de8', 'WBTC'],
    ['0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', 'USDC'],
    ['0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8', 'ETH'],
    ['0x4197ba364ae6698015ae5c1468f54087602715b2', 'WBTC'],
    ['0xe7df13b8e3d6740fe17cbe928c7334243d86c92f', 'USDT'],
    ['0x59cD1C87501baa753d0B5B5Ab5D8416A45cD71DB', 'ETH']
  ])('maps Ethereum receipt %s to %s for custody pricing', (contract, underlying) => {
    expect(canonicalCustodyPriceAsset('0x1', contract)).toBe(underlying);
    expect(canonicalCustodyPriceAsset(
      'polygon', contract
    )).toBeUndefined();
  });
});
