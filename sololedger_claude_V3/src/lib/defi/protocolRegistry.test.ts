import { describe, expect, it } from 'vitest';
import { AAVE_DATA_PROVIDER_SELECTORS, PROTOCOL_REGISTRY, resolveProtocol } from './protocolRegistry';

describe('Ethereum protocol registry', () => {
  it('test-locks canonical deployments and ABI selectors', () => {
    expect(PROTOCOL_REGISTRY).toEqual({
      'aave-v2-ethereum': expect.objectContaining({ chainId: 1, poolAddress: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9', dataProviderAddress: '0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d' }),
      'aave-v3-ethereum': expect.objectContaining({ chainId: 1, poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2', dataProviderAddress: '0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3' }),
      'spark-v1-ethereum': expect.objectContaining({ chainId: 1, poolAddress: '0xC13e21B648A5Ee794902342038FF3aDAB66BE987', dataProviderAddress: '0xFc21d6d146E6086B8359705C8b28512a983db0cb' })
    });
    // Independent ABI-signature literals: do not mirror implementation aliases.
    expect(AAVE_DATA_PROVIDER_SELECTORS.getAllReservesTokens).toBe('0xb316ff89'); // getAllReservesTokens()
    expect(AAVE_DATA_PROVIDER_SELECTORS.getUserReserveData).toBe('0xbf92857c'); // getUserReserveData(address,address)
    expect(AAVE_DATA_PROVIDER_SELECTORS.getReserveTokensAddresses).toBe('0xcd3daf9b'); // getReserveTokensAddresses(address)
  });
  it.each([137, 42161, 8453])('rejects chain %s before registry resolution', (chainId) => {
    expect(resolveProtocol(chainId, 'aave-v3-ethereum')).toBeUndefined();
  });
  it('rejects unknown protocols', () => expect(resolveProtocol(1, 'compound-v3-ethereum')).toBeUndefined());
});
