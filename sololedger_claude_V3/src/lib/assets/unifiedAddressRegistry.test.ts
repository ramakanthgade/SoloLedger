import { describe, expect, it } from 'vitest';
import { lookupBlockworksAddress } from './blockworksRegistry';
import { classifyIncomingTransfer } from './unifiedAddressRegistry';
import { GEOD_TOKEN_POLYGON, GEOD_REWARDS_WALLET_POLYGON } from './rewardRegistry';

describe('unified address registry', () => {
  it('normalizes EVM addresses but preserves Solana case', () => {
    expect(lookupBlockworksAddress('0xFA5FED5CC2B6DD8F370651D17242C52ED711B14F', 'polygon')?.role)
      .toBe('mining_allocation');
    expect(lookupBlockworksAddress('8eznVreusXAyh4HZirLWNjMxgoQdxzqfTi9Uw8gEL2RE', 'solana')).not.toBeNull();
    expect(lookupBlockworksAddress('8eznvreusxayh4hzirlwnjmxgoqdxzqfti9uw8gel2re', 'solana')).toBeNull();
  });

  it('keeps the static registry first and exposes source/confidence', () => {
    expect(classifyIncomingTransfer({
      contractAddress: GEOD_TOKEN_POLYGON,
      counterpartyAddress: GEOD_REWARDS_WALLET_POLYGON,
      chain: 'polygon'
    })).toMatchObject({ source: 'reward_registry_static', confidence: 'high', type: 'income' });

    expect(classifyIncomingTransfer({
      contractAddress: '0x0000000000000000000000000000000000000001',
      counterpartyAddress: '0xfa5fed5cc2b6dd8f370651d17242c52ed711b14f',
      chain: 'polygon'
    })).toMatchObject({ source: 'blockworks', confidence: 'high', type: 'income' });
  });
});
