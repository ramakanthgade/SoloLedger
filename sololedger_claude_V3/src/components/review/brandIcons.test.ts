import { describe, it, expect } from 'vitest';
import { sourceBrandInfo, assetIconId, chipInitials } from './brandIconMap';

describe('sourceBrandInfo', () => {
  it('maps exchange sources (incl. sync/CSV variants) to the exchange mark', () => {
    expect(sourceBrandInfo('binance')).toEqual({ id: 'binance', label: 'Binance' });
    expect(sourceBrandInfo('binance_api').id).toBe('binance');
    expect(sourceBrandInfo('wazirx_trades')).toEqual({ id: 'wazirx', label: 'WazirX' });
    expect(sourceBrandInfo('coindcx')).toEqual({ id: 'coindcx', label: 'CoinDCX' });
    expect(sourceBrandInfo('kraken_api').id).toBe('kraken');
    expect(sourceBrandInfo('bitstamp_api')).toEqual({ id: 'bitstamp', label: 'Bitstamp' });
    expect(sourceBrandInfo('coinswitch')).toEqual({ id: 'coinswitch', label: 'CoinSwitch' });
  });

  it('maps wallet sources to wallet marks', () => {
    expect(sourceBrandInfo('metamask')).toEqual({ id: 'metamask', label: 'MetaMask' });
    expect(sourceBrandInfo('phantom').id).toBe('phantom');
    expect(sourceBrandInfo('ledger').label).toBe('Ledger');
  });

  it('maps rpc:<chain> sources to chain marks and uses the pretty chain label', () => {
    expect(sourceBrandInfo('rpc:ethereum', 'Ethereum')).toEqual({ id: 'ethereum', label: 'Ethereum' });
    expect(sourceBrandInfo('rpc:solana', 'Solana')).toEqual({ id: 'solana', label: 'Solana' });
    // No chain label passed and no mark for the chain → generic wallet import.
    expect(sourceBrandInfo('rpc:scroll')).toEqual({ id: undefined, label: 'Wallet import' });
  });

  it('maps rpc:<provider> sources to the row chain mark via chainId (D-1)', () => {
    // Real sources are provider-keyed — the chain mark comes from t.chain.
    expect(sourceBrandInfo('rpc:blockstream', 'Bitcoin', 'bitcoin')).toEqual({ id: 'bitcoin', label: 'Bitcoin' });
    expect(sourceBrandInfo('rpc:helius', 'Solana', 'solana')).toEqual({ id: 'solana', label: 'Solana' });
    expect(sourceBrandInfo('rpc:alchemy', 'Ethereum', 'ethereum')).toEqual({ id: 'ethereum', label: 'Ethereum' });
    expect(sourceBrandInfo('rpc:moralis', 'Polygon', 'polygon')).toEqual({ id: 'polygon', label: 'Polygon' });
    // Chain without a shipped mark still falls back to the letter chip.
    expect(sourceBrandInfo('rpc:alchemy', 'Arbitrum One', 'arbitrum')).toEqual({ id: undefined, label: 'Arbitrum One' });
    // No chain context at all → generic wallet import chip.
    expect(sourceBrandInfo('rpc:alchemy')).toEqual({ id: undefined, label: 'Wallet import' });
    expect(sourceBrandInfo('rpc:alchemy', 'Solana')).toEqual({ id: undefined, label: 'Solana' });
  });

  it('labels non-brand sources without a mark', () => {
    expect(sourceBrandInfo('manual')).toEqual({ id: undefined, label: 'Manual entry' });
    expect(sourceBrandInfo('csv:generic_v1')).toEqual({ id: undefined, label: 'CSV import' });
    expect(sourceBrandInfo('wallet')).toEqual({ id: undefined, label: 'Wallet' });
  });

  it('prettifies unknown exchange ids and leaves them unmapped', () => {
    expect(sourceBrandInfo('gateio')).toEqual({ id: undefined, label: 'Gate.io' });
    expect(sourceBrandInfo('some_new_exchange')).toEqual({ id: undefined, label: 'Some New Exchange' });
  });
});

describe('assetIconId', () => {
  it('maps known symbols case-insensitively', () => {
    expect(assetIconId('BTC')).toBe('bitcoin');
    expect(assetIconId('eth')).toBe('ethereum');
    expect(assetIconId('Sol')).toBe('solana');
    expect(assetIconId('MATIC')).toBe('polygon');
    expect(assetIconId('POL')).toBe('polygon');
    expect(assetIconId('USDT')).toBe('tether');
    expect(assetIconId('USDC')).toBe('usdc');
    expect(assetIconId('BNB')).toBe('bnb');
  });

  it('returns undefined for unmapped or missing symbols', () => {
    expect(assetIconId('JUP-9f')).toBeUndefined();
    expect(assetIconId(undefined)).toBeUndefined();
  });
});

describe('chipInitials', () => {
  it('takes two letters for single-word labels and word initials for multi-word', () => {
    expect(chipInitials('Binance')).toBe('BI');
    expect(chipInitials('Manual entry')).toBe('ME');
    expect(chipInitials('CSV import')).toBe('CI');
    expect(chipInitials('')).toBe('?');
  });
});
