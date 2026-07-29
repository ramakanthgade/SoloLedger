import { describe, it, expect } from 'vitest';
import { getAssetLogoUrl, getLocalLogoPath, preloadAssetLogos } from './assetLogos';

describe('getAssetLogoUrl', () => {
  it('returns CDN URL for all assets (local SVGs render black, skip them)', () => {
    expect(getAssetLogoUrl('BTC')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/bitcoin/small.png'
    );
    expect(getAssetLogoUrl('ETH')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/ethereum/small.png'
    );
    expect(getAssetLogoUrl('SOL')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/solana/small.png'
    );
    expect(getAssetLogoUrl('USDT')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/tether/small.png'
    );
  });

  it('returns CDN URL for mapped assets', () => {
    expect(getAssetLogoUrl('UNI')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/uniswap/small.png'
    );
    expect(getAssetLogoUrl('ROSE')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/oasis-network/small.png'
    );
    expect(getAssetLogoUrl('HNT')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/helium/small.png'
    );
  });

  it('returns CDN URL with correct size', () => {
    expect(getAssetLogoUrl('BTC', 'large')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/bitcoin/large.png'
    );
    expect(getAssetLogoUrl('UNI', 'large')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/uniswap/large.png'
    );
    expect(getAssetLogoUrl('UNI', 'thumb')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/uniswap/thumb.png'
    );
  });

  it('falls back to ticker as CoinGecko ID for unmapped assets', () => {
    const url = getAssetLogoUrl('XYZ123');
    expect(url).toBe('https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/xyz123/small.png');
  });

  it('handles case insensitivity', () => {
    expect(getAssetLogoUrl('btc')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/bitcoin/small.png'
    );
    expect(getAssetLogoUrl('Uni')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/uniswap/small.png'
    );
  });

  it('handles whitespace', () => {
    expect(getAssetLogoUrl('  BTC  ')).toBe(
      'https://cdn.jsdelivr.net/gh/simplr-sh/coin-logos/images/bitcoin/small.png'
    );
  });

  it('returns null for empty ticker', () => {
    expect(getAssetLogoUrl('')).toBeNull();
    expect(getAssetLogoUrl('   ')).toBeNull();
  });
});

describe('getLocalLogoPath', () => {
  it('returns null for all assets (no local bundling — use CDN)', () => {
    expect(getLocalLogoPath('BTC')).toBeNull();
    expect(getLocalLogoPath('ETH')).toBeNull();
    expect(getLocalLogoPath('UNI')).toBeNull();
    expect(getLocalLogoPath('UNKNOWN')).toBeNull();
  });
});

describe('preloadAssetLogos', () => {
  it('does not throw for valid tickers', () => {
    // Image is not available in Node test env — mock it
    const originalImage = global.Image;
    global.Image = class {
      src = '';
    } as any;
    expect(() => preloadAssetLogos(['BTC', 'ETH', 'UNI'])).not.toThrow();
    global.Image = originalImage;
  });

  it('handles empty array', () => {
    const originalImage = global.Image;
    global.Image = class {
      src = '';
    } as any;
    expect(() => preloadAssetLogos([])).not.toThrow();
    global.Image = originalImage;
  });
});
