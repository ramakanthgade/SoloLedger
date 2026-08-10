import { describe, expect, it } from 'vitest';
import { AAVE_DATA_PROVIDER_SELECTORS, PROTOCOL_REGISTRY, resolveProtocol } from './protocolRegistry';

describe('Ethereum protocol registry', () => {
  it('test-locks canonical deployments and ABI selectors', () => {
    expect(PROTOCOL_REGISTRY).toEqual({
      'aave-v2-ethereum': expect.objectContaining({ chainId: 1, poolAddress: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9', dataProviderAddress: '0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d', rewardControllerAddresses: ['0xd784927ff2f95ba542bfc824c8a8a98f3495f6b5'], rewardSourceAddresses: ['0x25f2226b597e8f9514b3f68f00f494cf4f286491'], rewardTokenAddresses: ['0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9'] }),
      'aave-v3-ethereum': expect.objectContaining({ chainId: 1, poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2', dataProviderAddress: '0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3', rewardControllerAddresses: ['0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb'] }),
      'spark-v1-ethereum': expect.objectContaining({ chainId: 1, poolAddress: '0xC13e21B648A5Ee794902342038FF3aDAB66BE987', dataProviderAddress: '0xFc21d6d146E6086B8359705C8b28512a983db0cb', rewardControllerAddresses: ['0x4370D3b6C9588E02ce9D22e684387859c7Ff5b34'] })
    });
    // Independent ABI-signature literals: do not mirror implementation aliases.
    expect(AAVE_DATA_PROVIDER_SELECTORS.getAllReservesTokens).toBe('0xb316ff89'); // getAllReservesTokens()
    expect(AAVE_DATA_PROVIDER_SELECTORS.getUserReserveData).toBe('0x28dd2d01'); // getUserReserveData(address,address)
    expect(AAVE_DATA_PROVIDER_SELECTORS.getReserveTokensAddresses).toBe('0xd2493b6c'); // getReserveTokensAddresses(address)
  });
  it.each([137, 42161, 8453])('rejects chain %s before registry resolution', (chainId) => {
    expect(resolveProtocol(chainId, 'aave-v3-ethereum')).toBeUndefined();
  });
  it('rejects unknown protocols', () => expect(resolveProtocol(1, 'compound-v3-ethereum')).toBeUndefined());
});
