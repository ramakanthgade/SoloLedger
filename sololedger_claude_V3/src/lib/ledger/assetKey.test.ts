import { describe, expect, it } from 'vitest';
import { CHAINS, ETHERSCAN_V2_CHAIN_IDS, isEvmChain } from '@/lib/rpc/providers';
import type { Transaction } from '@/types/transaction';
import { assetKey, transactionAssetKey, transactionLegAssetKey } from './assetKey';
import {
  canonicalWalletChainScope,
  CHAIN_NATIVE_ASSETS,
  EVM_CHAIN_NUMERIC_IDS,
  REGISTERED_EVM_CHAINS
} from './chainNamespace';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

describe('assetKey', () => {
  it('rejects blank unchained symbols on optimized leg paths', () => {
    const base = {
      id: 'blank', timestamp: 1, type: 'trade', asset: 'BTC', amount: 1, fiatCurrency: 'INR',
      source: 'manual', flags: [], isInternalTransfer: false
    } as Transaction;
    expect(() => transactionAssetKey({ ...base, asset: '   ' })).toThrow('asset is required');
    expect(() => transactionLegAssetKey({ ...base, asset: 'BTC', counterAsset: '   ' }, 'counter'))
      .toThrow('counter asset is required');
    expect(() => transactionLegAssetKey({ ...base, asset: 'BTC', feeAsset: '   ' }, 'fee'))
      .toThrow('fee asset is required');
  });

  it('normalizes exchange/manual symbols', () => {
    expect(assetKey({ asset: ' usdt ' })).toBe('asset:USDT');
  });

  it('uses symbol custody identity for exchange legs while retaining wallet contract identity', () => {
    const transfer = {
      id: 'exchange-transfer', timestamp: 1, type: 'transfer_in', asset: ' req ', amount: 1,
      fiatCurrency: 'USD', source: 'binance_api', chain: 'ethereum', contractAddress: '0xReq',
      flags: [], isInternalTransfer: false
    } as Transaction;
    expect(transactionLegAssetKey(transfer, 'principal', { exchangeCustody: true })).toBe('asset:REQ');
    expect(transactionLegAssetKey(transfer, 'principal')).toBe('evm:1:0xreq');
  });

  it('keeps EVM chain and contract identity so same symbols never collide', () => {
    expect(assetKey({ asset: 'USDC', chain: 'ethereum', contractAddress: '0xAbC' }))
      .toBe('evm:1:0xabc');
    expect(assetKey({ asset: 'USDC', chain: 'polygon', contractAddress: '0xAbC' }))
      .toBe('evm:137:0xabc');
    expect(assetKey({ asset: 'USDC', chain: 'ethereum', contractAddress: '0xDef' }))
      .toBe('evm:1:0xdef');
  });

  it('uses explicit Bitcoin, Solana, EVM, and StarkNet namespaces', () => {
    expect(assetKey({ asset: 'ETH', chain: '1' })).toBe('evm:1:native');
    expect(assetKey({ asset: 'ETH', chain: 'ethereum' })).toBe('evm:1:native');
    expect(assetKey({ asset: 'SOL', chain: 'solana' })).toBe('solana:native');
    expect(assetKey({ asset: 'USDC', chain: 'solana', contractAddress: 'MintCaseSensitive' }))
      .toBe('solana:MintCaseSensitive');
    expect(assetKey({ asset: 'BTC', chain: 'bitcoin' })).toBe('bitcoin:native');
    expect(assetKey({ asset: 'STRK', chain: 'starknet' })).toBe('starknet:native');
    expect(assetKey({ asset: 'USDC', chain: 'starknet', contractAddress: '0xAbC' }))
      .toBe('starknet:0xabc');
  });

  it('keeps unknown/custom identities explicit and contract-unique', () => {
    expect(assetKey({ asset: 'COIN', chain: 'custom-chain' })).toBe('unsupported:custom_chain:native');
    expect(assetKey({ asset: 'COIN', chain: 'custom-chain', contractAddress: 'Contract-A' }))
      .toBe('unsupported:custom_chain:contract-a');
    expect(assetKey({ asset: 'COIN', chain: 'custom-chain', contractAddress: 'Contract-B' }))
      .toBe('unsupported:custom_chain:contract-b');
    expect(assetKey({ asset: 'TOKEN', chain: 'custom_evm', contractAddress: '0xAbC' }))
      .toBe('unsupported:custom_evm:missing_network:0xabc');
    expect(assetKey({ asset: 'TOKEN', chain: 'custom_evm', customNetworkId: 'eip155:777', contractAddress: '0xAbC' }))
      .toBe('evm:custom:eip155:777:0xabc');
  });

  it('canonicalizes named/numeric EVM identities and aliases', () => {
    expect(assetKey({ asset: 'ETH', chain: 'eth' })).toBe('evm:1:native');
    expect(assetKey({ asset: 'ETH', chain: 'ethereum' })).toBe('evm:1:native');
    expect(assetKey({ asset: 'ETH', chain: 'linea' })).toBe('evm:59144:native');
    expect(assetKey({ asset: 'ETH', chain: '59144' })).toBe('evm:59144:native');
    expect(assetKey({ asset: 'RON', chain: 'ronin' })).toBe('evm:2020:native');
    expect(assetKey({ asset: 'RON', chain: '2020' })).toBe('evm:2020:native');
    expect(canonicalWalletChainScope('ronin')).toBe(canonicalWalletChainScope('2020'));
  });

  it('uses Helius native-leg evidence without collapsing genuine WSOL', () => {
    const base: Transaction = {
      id: 'helius-sol', timestamp: 1, type: 'trade', asset: 'SOL', amount: 1,
      contractAddress: WSOL_MINT, counterAsset: 'USDC', counterAmount: 100,
      fiatCurrency: 'USD', source: 'rpc:helius', walletAddress: 'wallet', chain: 'solana',
      flags: [], isInternalTransfer: false
    };
    expect(transactionLegAssetKey({
      ...base,
      raw: { inputMint: WSOL_MINT, outputMint: 'UsdcMint', heliusNativeInput: true }
    }, 'principal')).toBe('solana:native');
    expect(transactionLegAssetKey({
      ...base, asset: 'USDC', contractAddress: 'UsdcMint', counterAsset: 'SOL',
      raw: { inputMint: 'UsdcMint', outputMint: WSOL_MINT, heliusNativeOutput: true }
    }, 'counter')).toBe('solana:native');
    expect(transactionLegAssetKey({
      ...base,
      raw: { inputMint: WSOL_MINT, outputMint: 'UsdcMint', heliusNativeInput: false }
    }, 'principal')).toBe(`solana:${WSOL_MINT}`);
  });

  it('never guesses a non-native counter token as native', () => {
    const base: Transaction = {
      id: 'swap', timestamp: 1, type: 'trade', asset: 'SOL', amount: 1,
      counterAsset: 'USDC', counterAmount: 10, fiatCurrency: 'USD', source: 'rpc:helius',
      walletAddress: 'wallet', chain: 'solana', flags: [], isInternalTransfer: false
    };
    expect(transactionLegAssetKey(base, 'counter')).toBe('unresolved:solana:solana:token:USDC');
    expect(transactionLegAssetKey({ ...base, raw: { counterMint: 'UsdcMint' } }, 'counter'))
      .toBe('solana:UsdcMint');

    const moralis = {
      ...base, asset: 'AAA', contractAddress: '0xaaa', counterAsset: 'BBB',
      chain: 'ethereum', source: 'rpc:moralis'
    };
    expect(transactionLegAssetKey(moralis, 'counter')).toBe('unresolved:evm:1:token:BBB');
    expect(transactionLegAssetKey({ ...moralis, raw: { counterContractAddress: '0xBbB' } }, 'counter'))
      .toBe('evm:1:0xbbb');
    expect(transactionLegAssetKey({ ...moralis, counterAsset: 'ETH' }, 'counter')).toBe('evm:1:native');
  });

  it('rejects an unscoped contract rather than falling back to symbol identity', () => {
    expect(() => assetKey({ asset: 'USDC', contractAddress: '0xabc' })).toThrow('requires chain');
  });

  it('stays aligned with the pure classifications in the provider registry', () => {
    const providerEvm = CHAINS.filter(isEvmChain).map((chain) => chain.id).sort();
    expect([...REGISTERED_EVM_CHAINS].sort()).toEqual(providerEvm);
    expect(Object.keys(EVM_CHAIN_NUMERIC_IDS).sort())
      .toEqual(providerEvm.filter((chain) => chain !== 'custom_evm'));
    for (const chain of CHAINS) expect(CHAIN_NATIVE_ASSETS[chain.id] ?? '').toBe(chain.asset.toUpperCase());
    for (const [chain, id] of Object.entries(ETHERSCAN_V2_CHAIN_IDS)) {
      expect(EVM_CHAIN_NUMERIC_IDS[chain]).toBe(String(id));
    }
  });
});
