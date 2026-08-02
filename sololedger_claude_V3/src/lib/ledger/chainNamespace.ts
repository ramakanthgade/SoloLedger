/** Pure custody namespaces, kept runtime-independent from the RPC provider module. */
export type ChainNamespace = 'bitcoin' | 'solana' | 'evm' | 'starknet' | 'unsupported';

/**
 * Mirrors CHAINS entries whose provider is `alchemy_evm` or
 * `etherscan_compatible`. A regression test locks this list to the provider
 * registry without making custody projection import the network-heavy module.
 */
export const REGISTERED_EVM_CHAINS: ReadonlySet<string> = new Set([
  'ethereum', 'polygon', 'arbitrum', 'base', 'bsc', 'optimism', 'avalanche',
  'fantom', 'celo', 'zksync', 'linea', 'scroll', 'blast', 'mantle', 'aurora',
  'cronos', 'gnosis', 'moonbeam', 'moonriver', 'metis', 'opbnb', 'abstract',
  'apechain', 'anime', 'berachain', 'hyperevm', 'ink', 'lens', 'monad',
  'mythos', 'robinhood', 'rootstock', 'ronin', 'shape', 'settlus', 'soneium',
  'story', 'unichain', 'worldchain', 'zora', 'zetachain', 'fraxtal', 'sei',
  'sonic', 'plasma', 'stable', 'megaeth', 'katana', 'custom_evm'
]);

/** Mainnet numeric ID for every fixed-identity EVM entry in the provider registry. */
export const EVM_CHAIN_NUMERIC_IDS: Readonly<Record<string, string>> = Object.freeze({
  ethereum: '1', polygon: '137', arbitrum: '42161', base: '8453', bsc: '56',
  optimism: '10', avalanche: '43114', fantom: '250', celo: '42220',
  zksync: '324', linea: '59144', scroll: '534352', blast: '81457', mantle: '5000',
  aurora: '1313161554', cronos: '25', gnosis: '100', moonbeam: '1284',
  moonriver: '1285', metis: '1088', opbnb: '204', abstract: '2741',
  apechain: '33139', anime: '69000', berachain: '80094', hyperevm: '999', ink: '57073',
  lens: '232', monad: '143', mythos: '42018', robinhood: '4663', rootstock: '30',
  ronin: '2020', shape: '360', settlus: '5371', soneium: '1868', story: '1514',
  unichain: '130', worldchain: '480', zora: '7777777', zetachain: '7000',
  fraxtal: '252', sei: '1329', sonic: '146',
  plasma: '9745', stable: '988', megaeth: '4326', katana: '747474'
});

export const CHAIN_NATIVE_ASSETS: Readonly<Record<string, string>> = Object.freeze({
  bitcoin: 'BTC', solana: 'SOL', starknet: 'STRK', ethereum: 'ETH', polygon: 'MATIC',
  arbitrum: 'ETH', base: 'ETH', bsc: 'BNB', optimism: 'ETH', avalanche: 'AVAX',
  fantom: 'FTM', celo: 'CELO', zksync: 'ETH', linea: 'ETH', scroll: 'ETH',
  blast: 'ETH', mantle: 'MNT', aurora: 'ETH', cronos: 'CRO', gnosis: 'XDAI',
  moonbeam: 'GLMR', moonriver: 'MOVR', metis: 'METIS', opbnb: 'BNB', abstract: 'ETH',
  apechain: 'APE', anime: 'ANIME', berachain: 'BERA', hyperevm: 'HYPE', ink: 'ETH',
  lens: 'GHO', monad: 'MON', mythos: 'MYTH', robinhood: 'ETH', rootstock: 'RBTC',
  ronin: 'RON', shape: 'ETH', settlus: 'ETH', soneium: 'ETH', story: 'IP',
  unichain: 'ETH', worldchain: 'ETH', zora: 'ETH', zetachain: 'ZETA', fraxtal: 'FRAX',
  sei: 'SEI', sonic: 'S', plasma: 'XPL', stable: 'USDT0', megaeth: 'ETH', katana: 'ETH'
});

const NATIVE_ASSET_BY_EVM_ID: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(EVM_CHAIN_NUMERIC_IDS)
    .map(([chain, id]) => [id, CHAIN_NATIVE_ASSETS[chain]]))
);

const EVM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  eth: 'ethereum',
  matic: 'polygon',
  avax: 'avalanche',
  binance_smart_chain: 'bsc'
});

export function normalizeChainIdentity(chain: string): string {
  const normalized = chain.trim().toLowerCase().replace(/[ -]+/g, '_');
  return EVM_ALIASES[normalized] ?? normalized;
}

export function chainNamespace(chain: string): ChainNamespace {
  const normalized = normalizeChainIdentity(chain);
  if (normalized === 'bitcoin' || normalized === 'btc') return 'bitcoin';
  if (normalized === 'solana' || normalized === 'sol') return 'solana';
  if (normalized === 'starknet' || normalized === 'starknet_mainnet') return 'starknet';
  if (/^\d+$/.test(normalized) || REGISTERED_EVM_CHAINS.has(normalized)) return 'evm';
  return 'unsupported';
}

export function canonicalChainIdentity(chain: string, customNetworkId?: string): string {
  const normalized = normalizeChainIdentity(chain);
  if (normalized === 'custom_evm') {
    const custom = customNetworkId?.trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '_');
    return custom ? `custom:${custom}` : 'custom:unresolved';
  }
  return EVM_CHAIN_NUMERIC_IDS[normalized] ?? normalized;
}

export function canonicalWalletChainScope(chain: string, customNetworkId?: string): string {
  const namespace = chainNamespace(chain);
  return `${namespace}:${canonicalChainIdentity(chain, customNetworkId)}`;
}

export function isCanonicalNativeAsset(chain: string, asset: string): boolean {
  const normalized = normalizeChainIdentity(chain);
  return (CHAIN_NATIVE_ASSETS[normalized] ?? NATIVE_ASSET_BY_EVM_ID[normalized]) === asset.trim().toUpperCase();
}
