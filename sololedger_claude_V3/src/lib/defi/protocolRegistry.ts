import type { ProtocolId } from './types';

export const ETHEREUM_CHAIN_ID = 1 as const;
export const AAVE_DATA_PROVIDER_SELECTORS = Object.freeze({
  getAllReservesTokens: '0xb316ff89',
  getUserReserveData: '0xbf92857c',
  getReserveTokensAddresses: '0xcd3daf9b',
  decimals: '0x313ce567',
  symbol: '0x95d89b41'
});

export interface ProtocolRegistryEntry {
  id: ProtocolId;
  chainId: 1;
  protocol: 'Aave' | 'Spark';
  version: 'v2' | 'v3' | 'v1';
  moralisSlug: 'aave-v2' | 'aave-v3' | 'sparkfi';
  poolAddress: string;
  dataProviderAddress: string;
}

/** Canonical Ethereum deployments: Aave address-book and Spark deployment verification. */
export const PROTOCOL_REGISTRY: Readonly<Record<ProtocolId, ProtocolRegistryEntry>> = Object.freeze({
  'aave-v2-ethereum': Object.freeze({
    id: 'aave-v2-ethereum', chainId: 1, protocol: 'Aave', version: 'v2', moralisSlug: 'aave-v2',
    poolAddress: '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9',
    dataProviderAddress: '0x057835Ad21a177dbdd3090bB1CAE03EaCF78Fc6d'
  }),
  'aave-v3-ethereum': Object.freeze({
    id: 'aave-v3-ethereum', chainId: 1, protocol: 'Aave', version: 'v3', moralisSlug: 'aave-v3',
    poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2',
    dataProviderAddress: '0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3'
  }),
  'spark-v1-ethereum': Object.freeze({
    id: 'spark-v1-ethereum', chainId: 1, protocol: 'Spark', version: 'v1', moralisSlug: 'sparkfi',
    poolAddress: '0xC13e21B648A5Ee794902342038FF3aDAB66BE987',
    dataProviderAddress: '0xFc21d6d146E6086B8359705C8b28512a983db0cb'
  })
});

export function resolveProtocol(chainId: number, protocolId: string): ProtocolRegistryEntry | undefined {
  if (chainId !== ETHEREUM_CHAIN_ID) return undefined;
  return PROTOCOL_REGISTRY[protocolId as ProtocolId];
}
