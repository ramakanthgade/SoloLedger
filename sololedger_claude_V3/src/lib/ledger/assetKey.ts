import type { Transaction } from '@/types/transaction';
import {
  canonicalChainIdentity,
  chainNamespace,
  isCanonicalNativeAsset,
  normalizeChainIdentity
} from './chainNamespace';

const SOLANA_WRAPPED_NATIVE_MINT = 'So11111111111111111111111111111111111111112';

export interface AssetIdentity {
  asset: string;
  chain?: string;
  contractAddress?: string;
  customNetworkId?: string;
  unresolvedToken?: boolean;
}

export function normalizeAssetSymbol(asset: string): string {
  return asset.trim().toUpperCase();
}

/** Canonical custody identity. Display symbols are never sufficient for contract assets. */
export function assetKey(identity: AssetIdentity): string {
  const asset = normalizeAssetSymbol(identity.asset);
  if (!asset) throw new Error('asset is required');

  const chain = identity.chain ? normalizeChainIdentity(identity.chain) : undefined;
  const contract = identity.contractAddress?.trim();
  const namespace = chain ? chainNamespace(chain) : undefined;
  const chainIdentity = chain ? canonicalChainIdentity(chain, identity.customNetworkId) : undefined;
  if (chain === 'custom_evm' && chainIdentity === 'custom:unresolved') {
    return contract
      ? `unsupported:custom_evm:missing_network:${contract.toLowerCase()}`
      : 'unsupported:custom_evm:missing_network:native';
  }
  if (identity.unresolvedToken && namespace && chainIdentity) {
    return `unresolved:${namespace}:${chainIdentity}:token:${asset}`;
  }
  if (namespace === 'solana') {
    return contract ? `solana:${contract}` : 'solana:native';
  }
  if (namespace === 'bitcoin') {
    return contract ? `bitcoin:${contract.toLowerCase()}` : 'bitcoin:native';
  }
  if (namespace === 'starknet') {
    return contract ? `starknet:${contract.toLowerCase()}` : 'starknet:native';
  }
  if (namespace === 'evm' && chain) {
    return contract ? `evm:${chainIdentity}:${contract.toLowerCase()}` : `evm:${chainIdentity}:native`;
  }
  if (namespace === 'unsupported' && chain) {
    return contract ? `unsupported:${chain}:${contract.toLowerCase()}` : `unsupported:${chain}:native`;
  }
  if (contract) {
    throw new Error('contractAddress requires chain identity');
  }
  return `asset:${asset}`;
}

function rawString(transaction: Transaction, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = transaction.raw?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function customNetworkId(transaction: Transaction): string | undefined {
  return rawString(transaction, ['customNetworkId', 'customChainId', 'networkId', 'chainId']);
}

function heliusNativeSolContract(
  transaction: Transaction,
  leg: 'principal' | 'counter' | 'fee',
  asset: string,
  contractAddress: string | undefined
): string | undefined {
  if (
    transaction.source !== 'rpc:helius' || normalizeAssetSymbol(asset) !== 'SOL' ||
    contractAddress !== SOLANA_WRAPPED_NATIVE_MINT
  ) return contractAddress;
  const evidenceKey = leg === 'principal' ? 'heliusNativeInput' : leg === 'counter' ? 'heliusNativeOutput' : undefined;
  return evidenceKey && transaction.raw?.[evidenceKey] === true ? undefined : contractAddress;
}

function legIdentity(
  transaction: Transaction,
  asset: string,
  contractAddress: string | undefined
): AssetIdentity {
  const chain = transaction.chain;
  if (!chain || contractAddress || isCanonicalNativeAsset(chain, asset)) {
    return { asset, chain, contractAddress, customNetworkId: customNetworkId(transaction) };
  }
  return {
    asset, chain, customNetworkId: customNetworkId(transaction), unresolvedToken: true
  };
}

export function transactionAssetKey(
  transaction: Transaction
): string {
  // The common exchange/manual case has no chain-qualified identity. Avoid
  // constructing an AssetIdentity and running chain normalization for it.
  if (!transaction.chain && !transaction.contractAddress) {
    const asset = normalizeAssetSymbol(transaction.asset);
    if (!asset) throw new Error('asset is required');
    return `asset:${asset}`;
  }
  const contractAddress = heliusNativeSolContract(
    transaction, 'principal', transaction.asset, transaction.contractAddress
  );
  return assetKey(legIdentity(transaction, transaction.asset, contractAddress));
}

export function transactionLegAssetKey(
  transaction: Transaction,
  leg: 'principal' | 'counter' | 'fee',
  options?: { exchangeCustody?: boolean }
): string {
  const asset = leg === 'principal'
    ? transaction.asset
    : leg === 'counter'
      ? transaction.counterAsset
      : transaction.feeAsset ?? transaction.asset;
  if (!asset) throw new Error(`${leg} asset is required`);

  // Centralized-exchange balance authorities are symbol-scoped. A chain on an
  // exchange transfer is route/explorer metadata, not custody identity, unless
  // an authority explicitly proves chain/contract-separated balances.
  if (options?.exchangeCustody) {
    const normalizedAsset = normalizeAssetSymbol(asset);
    if (!normalizedAsset) throw new Error(`${leg} asset is required`);
    return `asset:${normalizedAsset}`;
  }
  if (leg === 'principal') return transactionAssetKey(transaction);

  if (!transaction.chain && !transaction.contractAddress) {
    const raw = transaction.raw;
    const hasLegContract = leg === 'counter'
      ? raw?.counterContractAddress != null || raw?.counterMint != null || raw?.outputMint != null || raw?.toMint != null
      : raw?.feeContractAddress != null || raw?.feeMint != null;
    if (!hasLegContract) {
      const normalizedAsset = normalizeAssetSymbol(asset);
      if (!normalizedAsset) throw new Error(`${leg} asset is required`);
      return `asset:${normalizedAsset}`;
    }
  }

  const rawAddress = rawString(transaction, leg === 'counter'
    ? ['counterContractAddress', 'counterMint', 'outputMint', 'toMint']
    : ['feeContractAddress', 'feeMint']);
  const rawContractAddress = rawAddress ?? (asset.toUpperCase() === transaction.asset.toUpperCase()
      ? transaction.contractAddress
      : undefined);
  const contractAddress = heliusNativeSolContract(transaction, leg, asset, rawContractAddress);
  return assetKey(legIdentity(transaction, asset, contractAddress));
}
