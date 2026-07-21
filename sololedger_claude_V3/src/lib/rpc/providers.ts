/**
 * Wallet lookup providers. Design goal: as few keys as possible, and pull
 * everything at an address — native asset, every token/NFT it holds or has
 * moved, not just the chain's native coin.
 *
 * - Bitcoin uses Blockstream/mempool.space-compatible APIs — free, no key,
 *   no account. Every such service still sees the address you query; there
 *   is no way around that for any hosted explorer (see Settings for why).
 * - Ethereum uses Blockscout first (free, no key). Alchemy is optional fallback.
 * - Every other EVM chain here goes through Alchemy (one free key covers many chains).
 * - Etherscan-compatible is kept as a manual fallback for other EVM chains / custom explorers.
 */
import { resolveSolanaMintSymbol } from '@/lib/assets/solanaMints';
import { classifyRewardIncome } from '@/lib/assets/rewardRegistry';
import { classifyIncomingTransfer } from '@/lib/assets/unifiedAddressRegistry';
import { getAllocationContracts } from '@/lib/assets/coingeckoAllocations';
import { getBlockworksContracts } from '@/lib/assets/blockworksRegistry';
import { makeId } from '@/lib/parsers/types';
import { detectDexSwaps } from '@/lib/rpc/swapDetection';
import {
  decodeEvmReceiptForTransfer,
  fetchEvmTransactionReceipt,
  type EvmTxReceipt
} from '@/lib/rpc/evmDecoder';
import type { FlagReason, Transaction } from '@/types/transaction';
import { isSaasMode, getApiBase } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import { recordNetworkActivity, resolveMode } from '@/lib/networkActivity';

function hasRpcCredential(key?: string): boolean {
  if (isSaasMode()) return true;
  return Boolean(key?.trim());
}

function rpcCredential(key?: string): string {
  return key?.trim() || (isSaasMode() ? SAAS_PROXY_KEY : '');
}

export type ChainId =
  | 'bitcoin'
  | 'ethereum'
  | 'polygon'
  | 'arbitrum'
  | 'base'
  | 'bsc'
  | 'optimism'
  | 'avalanche'
  | 'fantom'
  | 'celo'
  | 'zksync'
  | 'linea'
  | 'scroll'
  | 'blast'
  | 'mantle'
  | 'starknet'
  | 'aurora'
  | 'cronos'
  | 'gnosis'
  | 'moonbeam'
  | 'moonriver'
  | 'metis'
  | 'opbnb'
  | 'solana'
  | 'custom_evm';

export interface ChainDef {
  id: ChainId;
  label: string;
  asset: string;
  provider: 'blockstream' | 'alchemy_evm' | 'alchemy_solana' | 'etherscan_compatible' | 'unsupported';
  alchemyNetwork?: string; // Alchemy's network slug, e.g. "eth-mainnet"
  needsKey: boolean;
}

export const CHAINS: ChainDef[] = [
  { id: 'bitcoin', label: 'Bitcoin', asset: 'BTC', provider: 'blockstream', needsKey: false },
  { id: 'ethereum', label: 'Ethereum', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'eth-mainnet', needsKey: true },
  { id: 'polygon', label: 'Polygon', asset: 'MATIC', provider: 'alchemy_evm', alchemyNetwork: 'polygon-mainnet', needsKey: true },
  { id: 'arbitrum', label: 'Arbitrum', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'arb-mainnet', needsKey: true },
  { id: 'base', label: 'Base', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'base-mainnet', needsKey: true },
  { id: 'optimism', label: 'Optimism', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'opt-mainnet', needsKey: true },
  { id: 'bsc', label: 'BNB Smart Chain', asset: 'BNB', provider: 'alchemy_evm', alchemyNetwork: 'bnb-mainnet', needsKey: true },
  { id: 'avalanche', label: 'Avalanche C-Chain', asset: 'AVAX', provider: 'alchemy_evm', alchemyNetwork: 'avax-mainnet', needsKey: true },
  { id: 'fantom', label: 'Fantom', asset: 'FTM', provider: 'alchemy_evm', alchemyNetwork: 'fantom-mainnet', needsKey: true },
  { id: 'celo', label: 'Celo', asset: 'CELO', provider: 'alchemy_evm', alchemyNetwork: 'celo-mainnet', needsKey: true },
  { id: 'zksync', label: 'zkSync Era', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'zksync-mainnet', needsKey: true },
  { id: 'linea', label: 'Linea', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'linea-mainnet', needsKey: true },
  { id: 'scroll', label: 'Scroll', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'scroll-mainnet', needsKey: true },
  { id: 'blast', label: 'Blast', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'blast-mainnet', needsKey: true },
  { id: 'mantle', label: 'Mantle', asset: 'MNT', provider: 'alchemy_evm', alchemyNetwork: 'mantle-mainnet', needsKey: true },
  // StarkNet is NOT an EVM chain, so there is no EVM sync wiring for it (no
  // alchemy_evm / Moralis / Noves path). It stays in the registry for display
  // + CoinGecko pricing; wallet sync is marked unsupported until a non-EVM
  // provider exists (the codebase has no non-EVM provider pattern beyond
  // Bitcoin blockstream and Solana).
  { id: 'starknet', label: 'StarkNet', asset: 'STRK', provider: 'unsupported', needsKey: false },
  // Aurora has no Alchemy network — fall back to the Etherscan-compatible
  // custom-explorer path (same pattern as custom_evm).
  { id: 'aurora', label: 'Aurora', asset: 'ETH', provider: 'etherscan_compatible', needsKey: true },
  { id: 'cronos', label: 'Cronos', asset: 'CRO', provider: 'alchemy_evm', alchemyNetwork: 'cronos-mainnet', needsKey: true },
  { id: 'gnosis', label: 'Gnosis', asset: 'xDAI', provider: 'alchemy_evm', alchemyNetwork: 'gnosis-mainnet', needsKey: true },
  { id: 'moonbeam', label: 'Moonbeam', asset: 'GLMR', provider: 'alchemy_evm', alchemyNetwork: 'moonbeam-mainnet', needsKey: true },
  // Moonriver has no Alchemy network (Moonbeam is supported; Moonriver is
  // not) — fall back to the Etherscan-compatible custom-explorer path.
  { id: 'moonriver', label: 'Moonriver', asset: 'MOVR', provider: 'etherscan_compatible', needsKey: true },
  { id: 'metis', label: 'Metis', asset: 'METIS', provider: 'alchemy_evm', alchemyNetwork: 'metis-mainnet', needsKey: true },
  { id: 'opbnb', label: 'opBNB', asset: 'BNB', provider: 'alchemy_evm', alchemyNetwork: 'opbnb-mainnet', needsKey: true },
  { id: 'solana', label: 'Solana', asset: 'SOL', provider: 'alchemy_solana', alchemyNetwork: 'solana-mainnet', needsKey: true },
  { id: 'custom_evm', label: 'Other EVM chain (Etherscan-compatible)', asset: '', provider: 'etherscan_compatible', needsKey: true }
];

/** CoinGecko "asset platform" slugs, for contract-address price lookups. */
export const COINGECKO_PLATFORM: Partial<Record<ChainId, string>> = {
  ethereum: 'ethereum',
  polygon: 'polygon-pos',
  arbitrum: 'arbitrum-one',
  base: 'base',
  optimism: 'optimistic-ethereum',
  bsc: 'binance-smart-chain',
  avalanche: 'avalanche',
  fantom: 'fantom',
  celo: 'celo',
  zksync: 'zksync',
  linea: 'linea',
  scroll: 'scroll',
  blast: 'blast',
  mantle: 'mantle',
  starknet: 'starknet',
  aurora: 'aurora',
  cronos: 'cronos',
  gnosis: 'xdai',
  moonbeam: 'moonbeam',
  moonriver: 'moonriver',
  metis: 'metis-andromeda',
  opbnb: 'opbnb',
  solana: 'solana'
};

export interface LookupWarning {
  address: string;
  message: string;
}

export interface LookupResult {
  transactions: Transaction[];
  warnings: LookupWarning[];
}

// ---- Bitcoin: Blockstream/mempool.space-compatible, no key ----
async function fetchBitcoin(address: string, baseUrl: string, asset: string): Promise<LookupResult> {
  // Public explorer (no key, no SaaS proxy) → always a direct browser call.
  recordNetworkActivity(resolveMode(false));
  const res = await fetch(`${baseUrl}/address/${address}/txs`);
  if (!res.ok) throw new Error(`Explorer API returned ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) return { transactions: [], warnings: [{ address, message: 'Unexpected response shape.' }] };

  const transactions: Transaction[] = data.map((row: any) => {
    const isOutgoing = row.vin?.some((v: any) => v.prevout?.scriptpubkey_address === address);
    const totalOut = (row.vout || []).reduce(
      (s: number, o: any) => (o.scriptpubkey_address === address ? s + o.value : s),
      0
    );
    // Best-effort single counterparty: the other address involved, if there's exactly one.
    const otherAddresses = new Set<string>();
    for (const v of row.vin ?? []) if (v.prevout?.scriptpubkey_address && v.prevout.scriptpubkey_address !== address) otherAddresses.add(v.prevout.scriptpubkey_address);
    for (const o of row.vout ?? []) if (o.scriptpubkey_address && o.scriptpubkey_address !== address) otherAddresses.add(o.scriptpubkey_address);
    const counterparty = otherAddresses.size === 1 ? [...otherAddresses][0] : undefined;

    return {
      id: makeId('rpc'),
      timestamp: (row.status?.block_time ?? Date.now() / 1000) * 1000,
      type: isOutgoing ? 'transfer_out' : 'transfer_in',
      asset,
      amount: totalOut / 1e8,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:blockstream',
      sourceRef: row.txid,
      walletAddress: address,
      counterpartyAddress: counterparty,
      chain: 'bitcoin',
      flags: ['possible_internal_transfer', 'missing_cost_basis'] as const,
      isInternalTransfer: false,
      raw: row
    } as Transaction;
  });

  return { transactions, warnings: [] };
}

function alchemyRpcUrl(network: string): string {
  if (isSaasMode()) {
    return `${getApiBase()}/api/proxy/alchemy/${network}`;
  }
  // When running via `npm run dev` / `npm run preview` on localhost, route through
  // Vite's same-origin proxy (see vite.config.ts). Direct browser → Alchemy calls
  // are blocked by CORS for some methods (e.g. alchemy_getAssetTransfers).
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return `/alchemy-rpc/${network}`;
    }
  }
  return `https://${network}.g.alchemy.com/v2`;
}

function alchemyFetch(url: string, init: RequestInit): Promise<Response> {
  if (isSaasMode()) {
    recordNetworkActivity(resolveMode(true));
    const path = url.replace(getApiBase(), '');
    return saasProxyFetch(path, init);
  }
  recordNetworkActivity(resolveMode(false));
  return fetch(url, init);
}

/**
 * Calm hosted-mode provider wording. Hosted users have no API key to fix —
 * provider failures (rate limits, disabled networks, upstream 403s) must
 * NEVER surface "check your API key" or raw upstream bodies (which can
 * mention keys) to them.
 */
const HOSTED_CHAIN_TEMPORARILY_UNAVAILABLE =
  'This chain is temporarily unavailable on the hosted service — please try again later.';

/**
 * Message for chains NO wallet-data provider serves at all (live-verified
 * 2026-07-21): fantom (dropped by Moralis product-wide, not offered by
 * Alchemy, chainid 250 unsupported on Etherscan V2) and aurora (dropped by
 * Moralis, no Alchemy network exists, chainid 1313161554 unsupported on V2).
 */
export function chainNotAvailableMessage(): string {
  return isSaasMode()
    ? 'This chain is not available on the hosted service yet — please use a CSV export instead.'
    : 'This chain is not available from any wallet-data provider right now — please use a CSV export instead.';
}

function alchemyErrorMessage(status: number, body?: { error?: { code?: number; message?: string } }): string {
  if (isSaasMode()) return HOSTED_CHAIN_TEMPORARILY_UNAVAILABLE;
  if (status === 429 || body?.error?.code === 429) {
    return (
      'Alchemy transfer lookup is rate-limited on the free plan (this can last hours during high traffic). ' +
      'Add a free Etherscan API key in Settings — it is used automatically as a fallback for Ethereum and other EVM chains. ' +
      'Get one at etherscan.io/apis'
    );
  }
  if (body?.error?.message) return body.error.message;
  return `Alchemy API returned ${status} — check your API key`;
}

/**
 * Etherscan multichain API v2 chain ids (one key covers all) — FALLBACK
 * coverage when a chain's primary providers fail. Live-verified 2026-07-21
 * on the relay key's free tier: celo/gnosis/linea/blast/mantle answer (celo
 * is daily-quota-limited). base/avalanche are PAID-plan-gated on V2 and
 * already covered by Moralis + Alchemy — deliberately NOT listed. No V2 ids
 * exist for fantom/zksync/scroll/aurora (unsupported chainid on V2).
 */
const ETHERSCAN_V2_CHAIN_IDS: Partial<Record<ChainId, number>> = {
  ethereum: 1,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  bsc: 56,
  celo: 42220,
  gnosis: 100,
  linea: 59144,
  blast: 81457,
  mantle: 5000
};

function etherscanV2BaseUrl(chainId: ChainId): string | null {
  const id = ETHERSCAN_V2_CHAIN_IDS[chainId];
  return id != null ? `https://api.etherscan.io/v2/api?chainid=${id}` : null;
}

function isAlchemyRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('rate limit') || msg.includes('429') || msg.toLowerCase().includes('rate-limited');
}

function alchemyHeaders(apiKey: string): HeadersInit {
  if (isSaasMode()) {
    return { 'Content-Type': 'application/json' };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
}

// ---- EVM chains via Alchemy's alchemy_getAssetTransfers (native + ERC20 + NFTs) ----
export async function fetchAlchemyEvmInner(
  address: string,
  network: string,
  apiKey: string,
  asset: string,
  chainId: ChainId
): Promise<LookupResult> {
  const url = alchemyRpcUrl(network);
  const body = (direction: 'from' | 'to') => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'alchemy_getAssetTransfers',
    params: [
      {
        [direction === 'from' ? 'fromAddress' : 'toAddress']: address,
        category: ['external', 'erc20', 'erc721', 'erc1155'],
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: '0x64'
      }
    ]
  });

  const headers = alchemyHeaders(apiKey);
  const loadReceipt = createReceiptLoader((hash) => fetchEvmTransactionReceipt(url, hash, headers));
  const [outgoingRes, incomingRes] = await Promise.all([
    alchemyFetch(url, { method: 'POST', headers, body: JSON.stringify(body('from')) }),
    alchemyFetch(url, { method: 'POST', headers, body: JSON.stringify(body('to')) })
  ]);

  const [outgoing, incoming] = await Promise.all([outgoingRes.json(), incomingRes.json()]);
  if (!outgoingRes.ok || !incomingRes.ok) {
    const status = outgoingRes.ok ? incomingRes.status : outgoingRes.status;
    throw new Error(alchemyErrorMessage(status, outgoing.error ? outgoing : incoming));
  }
  if (outgoing.error || incoming.error) {
    const err = outgoing.error ?? incoming.error;
    throw new Error(alchemyErrorMessage(err?.code ?? 0, { error: err }));
  }

  const toTx = async (t: any, direction: 'transfer_out' | 'transfer_in'): Promise<Transaction> => {
    const isNft = t.category === 'erc721' || t.category === 'erc1155';
    const ercContractAddress = t.category === 'erc20' && typeof t.rawContract?.address === 'string'
      ? t.rawContract.address
      : undefined;
    const unified = direction === 'transfer_in' && !isNft
      ? classifyIncomingTransfer({
          contractAddress: ercContractAddress,
          counterpartyAddress: t.from,
          chain: chainId,
          amount: Number(t.value) || undefined
        })
      : null;
    // Last resort when Moralis is unavailable: inspect the verified standard
    // receipt logs before accepting Alchemy's generic transfer classification.
    const receipt = ercContractAddress && t.hash ? await loadReceipt(t.hash) : null;
    const decoded = receipt
      ? decodeEvmReceiptForTransfer(
          receipt,
          address,
          {
            contractAddress: ercContractAddress,
            direction,
            from: t.from,
            to: t.to
          },
          { ...getAllocationContracts(), ...getBlockworksContracts() }
        )
      : null;
    const decodedIsSpecific = decoded && decoded.type !== 'transfer_in' && decoded.type !== 'transfer_out';
    const unifiedIsIncome = unified?.type === 'income';
    return {
      id: makeId('rpc'),
      timestamp: t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp).getTime() : Date.now(),
      type: unifiedIsIncome ? unified.type : decodedIsSpecific ? decoded.type : unified?.type ?? direction,
      asset: t.asset || (isNft ? (t.rawContract?.address ? `NFT ${String(t.rawContract.address).slice(0, 6)}` : 'NFT') : asset),
      amount: isNft ? (t.erc1155Metadata?.[0]?.value ? Number(t.erc1155Metadata[0].value) : 1) : Number(t.value) || 0,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:alchemy',
      sourceRef: t.hash,
      walletAddress: address,
      counterpartyAddress: direction === 'transfer_in' ? t.from : t.to,
      contractAddress: t.rawContract?.address || undefined,
      chain: chainId,
      category: unified?.kind,
      notes: unifiedIsIncome ? unified.label : decodedIsSpecific ? decoded.notes : unified?.label,
      flags: unified?.source === 'reward_registry_static'
        ? []
        : unified || decodedIsSpecific
          ? (['needs_review'] as FlagReason[])
        : ['possible_internal_transfer', 'missing_cost_basis'],
      isInternalTransfer: false,
      raw: t
    };
  };

  const transactions = await Promise.all([
    ...(outgoing.result?.transfers ?? []).map((t: any) => toTx(t, 'transfer_out')),
    ...(incoming.result?.transfers ?? []).map((t: any) => toTx(t, 'transfer_in'))
  ]);

  return { transactions, warnings: [] };
}

/** Promise cache guarantees one receipt request per transaction hash. */
export function createReceiptLoader(
  load: (hash: string) => Promise<EvmTxReceipt | null>
): (hash: string) => Promise<EvmTxReceipt | null> {
  const cache = new Map<string, Promise<EvmTxReceipt | null>>();
  return (hash) => {
    const key = hash.toLowerCase();
    let pending = cache.get(key);
    if (!pending) {
      pending = load(hash);
      cache.set(key, pending);
    }
    return pending;
  };
}

function isNetworkFetchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('Failed to fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('getaddrinfo') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ETIMEDOUT')
  );
}

async function fetchAlchemyEvm(
  address: string,
  network: string,
  apiKey: string,
  asset: string,
  chainId: ChainId,
  etherscanApiKey?: string
): Promise<LookupResult> {
  try {
    return await fetchAlchemyEvmInner(address, network, apiKey, asset, chainId);
  } catch (err) {
    // Ethereum keeps its free, key-less Blockscout fallback on rate-limit.
    if (chainId === 'ethereum' && isAlchemyRateLimitError(err)) {
      const result = await fetchBlockscoutEthereum(address);
      return {
        transactions: result.transactions,
        warnings: [
          {
            address,
            message:
              'Alchemy transfer lookup was rate-limited; fetched via Blockscout instead (native + ERC-20 transfers).'
          },
          ...result.warnings
        ]
      };
    }
    // Broadened 2026-07-21: ANY Alchemy failure (403 "network not enabled",
    // network/DNS error, rate limit on a non-Ethereum chain) falls back to
    // Etherscan V2 when the chain has a V2 id and an Etherscan key is
    // available — in hosted mode the relay supplies the key
    // (hasRpcCredential is always true there). The Moralis-dropped chains
    // (celo/blast/mantle/gnosis/linea) depend on this path.
    const baseUrl = etherscanV2BaseUrl(chainId);
    if (baseUrl && hasRpcCredential(etherscanApiKey)) {
      try {
        const result = await fetchEtherscanCompatible(address, baseUrl, rpcCredential(etherscanApiKey), asset);
        return {
          transactions: result.transactions,
          warnings: [
            {
              address,
              message: isAlchemyRateLimitError(err)
                ? 'Alchemy transfer lookup was rate-limited; fetched via Etherscan instead (native + ERC-20 transfers).'
                : 'Alchemy transfer lookup failed; fetched via Etherscan instead (native + ERC-20 transfers).'
            },
            ...result.warnings
          ]
        };
      } catch (etherscanErr) {
        if (isNetworkFetchError(etherscanErr)) {
          throw new Error(
            'Alchemy transfer lookup failed and Etherscan could not be reached from your network. ' +
              'Check your internet/DNS or try again later.'
          );
        }
        throw etherscanErr;
      }
    }
    throw err;
  }
}

// ---- Solana via Alchemy's Solana RPC + DAS (native SOL, SPL tokens, and NFTs) ----
const solanaAssetCache = new Map<string, { symbol: string; isNft: boolean }>();

async function getSolanaAssetMeta(apiKey: string, mint: string): Promise<{ symbol: string; isNft: boolean }> {
  if (solanaAssetCache.has(mint)) return solanaAssetCache.get(mint)!;
  const known = resolveSolanaMintSymbol(mint);
  if (known) {
    const meta = { symbol: known, isNft: false };
    solanaAssetCache.set(mint, meta);
    return meta;
  }
  try {
    const res = await alchemyFetch(alchemyRpcUrl('solana-mainnet'), {
      method: 'POST',
      headers: alchemyHeaders(apiKey),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } })
    });
    const data = await res.json();
    const asset = data.result;
    const symbol =
      asset?.content?.metadata?.symbol ||
      asset?.token_info?.symbol ||
      asset?.content?.metadata?.name ||
      `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    const isNft = !!asset?.interface && asset.interface !== 'FungibleToken' && asset.interface !== 'FungibleAsset';
    const meta = { symbol, isNft };
    solanaAssetCache.set(mint, meta);
    return meta;
  } catch {
    const meta = { symbol: `${mint.slice(0, 4)}…${mint.slice(-4)}`, isNft: false };
    solanaAssetCache.set(mint, meta);
    return meta;
  }
}

async function fetchAlchemySolana(address: string, apiKey: string): Promise<LookupResult> {
  const url = alchemyRpcUrl('solana-mainnet');
  const headers = alchemyHeaders(apiKey);

  const sigRes = await alchemyFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [address, { limit: 1000 }] })
  });
  const sigData = await sigRes.json();
  if (!sigRes.ok) throw new Error(alchemyErrorMessage(sigRes.status, sigData));
  if (sigData.error) throw new Error(alchemyErrorMessage(sigData.error.code ?? 0, sigData));
  const signatures: { signature: string; blockTime: number | null }[] = sigData.result ?? [];

  if (signatures.length === 0) return { transactions: [], warnings: [] };

  const transactions: Transaction[] = [];

  for (const sig of signatures) {
    // eslint-disable-next-line no-await-in-loop
    const txRes = await alchemyFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig.signature, { maxSupportedTransactionVersion: 0 }] })
    });
    // eslint-disable-next-line no-await-in-loop
    const txData = await txRes.json();
    const tx = txData.result;
    if (!tx) continue;
    const timestamp = (sig.blockTime ?? Date.now() / 1000) * 1000;

    // --- Native SOL balance delta ---
    const accountKeys: string[] = tx.transaction?.message?.accountKeys?.map((k: any) => (typeof k === 'string' ? k : k.pubkey)) ?? [];
    const allPreBalances: number[] = tx.meta?.preBalances ?? [];
    const allPostBalances: number[] = tx.meta?.postBalances ?? [];
    const idx = accountKeys.indexOf(address);
    if (idx !== -1) {
      const pre = allPreBalances[idx] ?? 0;
      const post = allPostBalances[idx] ?? 0;
      const delta = (post - pre) / 1e9;
      if (Math.abs(delta) > 0.000001) {
        // Find counterparty: the other account with the opposite SOL balance change
        let solCounterparty: string | undefined;
        for (let i = 0; i < accountKeys.length; i++) {
          if (i === idx) continue;
          const counterDelta = ((allPostBalances[i] ?? 0) - (allPreBalances[i] ?? 0)) / 1e9;
          if ((delta > 0 && counterDelta < -0.000001) || (delta < 0 && counterDelta > 0.000001)) {
            solCounterparty = accountKeys[i];
            break;
          }
        }
        transactions.push({
          id: makeId('rpc'),
          timestamp,
          type: delta > 0 ? 'transfer_in' : 'transfer_out',
          asset: 'SOL',
          amount: Math.abs(delta),
          fiatCurrency: 'USD',
          fiatValue: undefined,
          source: 'rpc:alchemy',
          sourceRef: sig.signature,
          walletAddress: address,
          counterpartyAddress: solCounterparty,
          chain: 'solana',
          flags: ['possible_internal_transfer', 'missing_cost_basis'],
          isInternalTransfer: false,
          raw: tx
        });
      }
    }

    // --- SPL token / NFT balance deltas (USDC, other tokens, NFTs) ---
    const allPreToken: any[] = tx.meta?.preTokenBalances ?? [];
    const allPostToken: any[] = tx.meta?.postTokenBalances ?? [];
    const pre = allPreToken.filter((b: any) => b.owner === address);
    const post = allPostToken.filter((b: any) => b.owner === address);
    const mints = new Set<string>([...pre.map((b: any) => b.mint), ...post.map((b: any) => b.mint)]);

    // eslint-disable-next-line no-await-in-loop
    for (const mint of mints) {
      const sumUi = (balances: any[], m: string) =>
        balances
          .filter((b: any) => b.mint === m)
          .reduce((s, b) => s + (b.uiTokenAmount?.uiAmount ?? 0), 0);
      const preAmt = sumUi(pre, mint);
      const postAmt = sumUi(post, mint);
      const delta = postAmt - preAmt;
      if (Math.abs(delta) < 1e-9) continue;

      // Find counterparty: the other owner whose balance of this mint changed in the opposite direction.
      // This captures vault addresses in DCA/recurring orders (e.g. Jupiter DCA vault → USDC sent to wallet).
      let tokenCounterparty: string | undefined;
      const allMintsForToken = [...allPreToken, ...allPostToken]
        .filter((b: any) => b.mint === mint && b.owner !== address)
        .map((b: any) => b.owner);
      for (const owner of new Set(allMintsForToken)) {
        const cPre = allPreToken.find((b: any) => b.mint === mint && b.owner === owner)?.uiTokenAmount?.uiAmount ?? 0;
        const cPost = allPostToken.find((b: any) => b.mint === mint && b.owner === owner)?.uiTokenAmount?.uiAmount ?? 0;
        const counterDelta = cPost - cPre;
        if ((delta > 0 && counterDelta < -1e-9) || (delta < 0 && counterDelta > 1e-9)) {
          tokenCounterparty = owner;
          break;
        }
      }

      // eslint-disable-next-line no-await-in-loop
      const meta = await getSolanaAssetMeta(apiKey, mint);

      // Auto-classify reward-token income (GEOD, DBT, …) via the reward registry.
      // Returns null when the sender isn't a known rewards wallet, so it stays a
      // plain transfer_in.
      const ownAddressSet = new Set([address.toLowerCase()]);
      const reward =
        delta > 0 &&
        tokenCounterparty &&
        !ownAddressSet.has(tokenCounterparty.toLowerCase())
          ? classifyRewardIncome(mint, tokenCounterparty)
          : null;

      transactions.push({
        id: makeId('rpc'),
        timestamp,
        type: reward ? 'income' : (delta > 0 ? 'transfer_in' : 'transfer_out'),
        asset: meta.symbol,
        amount: Math.abs(delta),
        fiatCurrency: 'USD',
        fiatValue: undefined,
        source: 'rpc:alchemy',
        sourceRef: sig.signature,
        walletAddress: address,
        counterpartyAddress: tokenCounterparty,
        contractAddress: mint,
        chain: 'solana',
        category: meta.isNft ? 'nft' : reward ? reward.kind : undefined,
        notes: reward ? `${reward.label} — auto-classified as income` : undefined,
        flags: reward ? [] : ['possible_internal_transfer', 'missing_cost_basis'],
        isInternalTransfer: false,
        raw: tx
      });
    }
  }

  return { transactions, warnings: [] };
}

// ---- Generic Etherscan-compatible fallback (BYO key/endpoint) ----
function etherscanRequestUrl(baseUrl: string, params: Record<string, string>, apiKey: string): string {
  // Hosted: route through the SoloLedger relay, which injects the server-side
  // key and forwards to the Etherscan multichain V2 endpoint. The FULL query
  // must survive — including the `chainid` embedded in a V2 base URL — while
  // no key material ever leaves the client.
  if (isSaasMode()) {
    const merged = new URLSearchParams();
    const qIndex = baseUrl.indexOf('?');
    if (qIndex >= 0) {
      for (const [k, v] of new URLSearchParams(baseUrl.slice(qIndex + 1))) merged.append(k, v);
    }
    for (const [k, v] of Object.entries(params)) merged.set(k, v);
    return `/api/proxy/etherscan?${merged.toString()}`;
  }
  const qs = new URLSearchParams({ ...params, apikey: apiKey });
  const sep = baseUrl.includes('?') ? '&' : '?';
  let url = `${baseUrl}${sep}${qs.toString()}`;
  // Same-origin proxy in dev avoids browser CORS blocks on explorer APIs.
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if ((host === 'localhost' || host === '127.0.0.1') && url.startsWith('https://api.etherscan.io')) {
      url = url.replace('https://api.etherscan.io', '/etherscan-api');
    }
  }
  return url;
}

/**
 * Etherscan-family transport: the SaaS relay in hosted mode (the server
 * injects the key), a direct browser call with the user's key otherwise.
 */
function etherscanFetch(url: string): Promise<Response> {
  recordNetworkActivity(resolveMode(isSaasMode()));
  return isSaasMode() ? saasProxyFetch(url) : fetch(url);
}

async function fetchEtherscanCompatible(address: string, baseUrl: string, apiKey: string, asset: string): Promise<LookupResult> {
  // Hosted mode needs no user key — the relay injects the server-side
  // Etherscan key (see etherscanRequestUrl).
  if (!apiKey?.trim() && !isSaasMode()) {
    throw new Error('Add a free Etherscan API key in Settings (etherscan.io/apis).');
  }

  const commonParams = {
    module: 'account',
    address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: '1000',
    sort: 'desc'
  };
  const nativeUrl = etherscanRequestUrl(baseUrl, { ...commonParams, action: 'txlist' }, apiKey);
  const tokenUrl = etherscanRequestUrl(baseUrl, { ...commonParams, action: 'tokentx' }, apiKey);

  function toEtherscanTx(row: Record<string, string>, addr: string, nativeAsset: string, isToken: boolean): Transaction {
    const decimals = isToken ? Number(row.tokenDecimal || '18') : 18;
    const valueRaw = BigInt(row.value || '0');
    const amount = Number(valueRaw) / 10 ** decimals;
    const isOutgoing = row.from?.toLowerCase() === addr.toLowerCase();
    return {
      id: makeId('rpc'),
      timestamp: Number(row.timeStamp) * 1000,
      type: isOutgoing ? 'transfer_out' : 'transfer_in',
      asset: isToken ? row.tokenSymbol || 'TOKEN' : nativeAsset,
      amount,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:etherscan_compatible',
      sourceRef: row.hash,
      walletAddress: addr,
      counterpartyAddress: isOutgoing ? row.to : row.from,
      contractAddress: isToken ? row.contractAddress : undefined,
      flags: ['possible_internal_transfer', 'missing_cost_basis'] as const,
      isInternalTransfer: false,
      raw: row
    } as Transaction;
  }

  const parseExplorerError = async (res: Response): Promise<string> => {
    try {
      const data = await res.json();
      const detail = typeof data?.result === 'string' ? data.result : data?.message;
      return detail || `Explorer API returned ${res.status}`;
    } catch {
      return `Explorer API returned ${res.status}`;
    }
  };

  // BYOK explorers are called directly with the user's key; hosted mode goes
  // through the relay (etherscanFetch handles both).
  const nativeRes = await etherscanFetch(nativeUrl);
  if (!nativeRes.ok) throw new Error(await parseExplorerError(nativeRes));
  const nativeData = await nativeRes.json();

  const tokenRes = await etherscanFetch(tokenUrl);
  const tokenData = tokenRes.ok ? await tokenRes.json() : { status: '0', result: [] };
  if (!tokenRes.ok) {
    // Token history is optional — native txs are still useful.
    const tokenErr = await parseExplorerError(tokenRes);
    const warnings: LookupWarning[] = [{ address, message: `Token transfer fetch failed: ${tokenErr}` }];
    const transactions: Transaction[] = Array.isArray(nativeData.result)
      ? nativeData.result.map((r: any) => toEtherscanTx(r, address, asset, false))
      : [];
    return { transactions, warnings };
  }

  const warnings: LookupWarning[] = [];
  if (nativeData.status !== '1' || !Array.isArray(nativeData.result)) {
    const detail = typeof nativeData.result === 'string' ? nativeData.result : nativeData.message;
    throw new Error(detail || 'Etherscan returned no native transactions for this address.');
  }

  const transactions: Transaction[] = [
    ...nativeData.result.map((r: any) => toEtherscanTx(r, address, asset, false)),
    ...(Array.isArray(tokenData.result) ? tokenData.result.map((r: any) => toEtherscanTx(r, address, asset, true)) : [])
  ];

  return { transactions, warnings };
}

// ---- Activity probes for chain auto-detect (Moralis-dropped chains) ----

/**
 * Single-call Alchemy activity probe: has the wallet ≥1 asset transfer in
 * `direction` on `network`? Uses alchemy_getAssetTransfers with maxCount 0x1
 * — the cheapest possible call. Throws on HTTP/API failure so the caller can
 * fall back to the Etherscan V2 probe (or drop the chain silently).
 */
export async function alchemyHasActivity(
  network: string,
  address: string,
  direction: 'from' | 'to',
  apiKey: string
): Promise<boolean> {
  const url = alchemyRpcUrl(network);
  const res = await alchemyFetch(url, {
    method: 'POST',
    headers: alchemyHeaders(apiKey),
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [
        {
          [direction === 'from' ? 'fromAddress' : 'toAddress']: address,
          category: ['external', 'erc20', 'erc721', 'erc1155'],
          maxCount: '0x1'
        }
      ]
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(alchemyErrorMessage(res.status, data ?? undefined));
  if (data?.error) throw new Error(alchemyErrorMessage(data.error.code ?? 0, data));
  return (data?.result?.transfers ?? []).length > 0;
}

export type ActivityProbeVerdict = 'outgoing' | 'incoming' | 'none';

/**
 * Etherscan V2 `txlist` activity probe (newest page only, offset 100):
 * 'outgoing' when the wallet SENT ≥1 listed tx, 'incoming' when it only
 * received, 'none' on an empty page. Returns null when the chain has no V2
 * id; throws on HTTP/network failure so auto-detect can fail the chain
 * silently.
 */
export async function etherscanV2HasActivity(
  chainId: ChainId,
  address: string,
  apiKey: string
): Promise<ActivityProbeVerdict | null> {
  const baseUrl = etherscanV2BaseUrl(chainId);
  if (!baseUrl) return null;
  const url = etherscanRequestUrl(baseUrl, {
    module: 'account',
    action: 'txlist',
    address,
    startblock: '0',
    endblock: '99999999',
    page: '1',
    offset: '100',
    sort: 'desc'
  }, apiKey);
  const res = await etherscanFetch(url);
  if (!res.ok) throw new Error(`Explorer API returned ${res.status}`);
  const data = await res.json().catch(() => null);
  const rows: { from?: string }[] = Array.isArray(data?.result) ? data.result : [];
  if (rows.length === 0) return 'none';
  const walletLower = address.toLowerCase();
  return rows.some((r) => r.from?.toLowerCase() === walletLower) ? 'outgoing' : 'incoming';
}

// ---- Ethereum via Blockscout (free, no API key — primary source for Ethereum) ----
// Blockscout allows browser CORS (Access-Control-Allow-Origin: *), so we call it directly
// instead of routing through the Vite dev proxy. That avoids ENOTFOUND proxy errors when a
// machine's DNS cannot resolve api.etherscan.io or when the Node proxy stack misbehaves.
const BLOCKSCOUT_ETHEREUM_API = 'https://eth.blockscout.com/api/v2';

function blockscoutUrl(path: string): string {
  return `${BLOCKSCOUT_ETHEREUM_API}${path}`;
}

/**
 * Best-effort fetch of an Ethereum transaction's from/to parties via Blockscout
 * (free, no key, CORS-open). Used to confirm address orientation for ambiguous
 * single-"Address" imports. Ethereum-only (sample data uses EVM `0x` hashes).
 * Returns `null` on any failure so callers can fall back to their baseline.
 */
export async function fetchBlockscoutTxParties(
  hash: string
): Promise<{ from?: string; to?: string } | null> {
  try {
    recordNetworkActivity(resolveMode(false));
    const res = await fetch(blockscoutUrl(`/transactions/${hash}`));
    if (!res.ok) return null;
    const data = await res.json();
    const from = data?.from?.hash ? String(data.from.hash).toLowerCase() : undefined;
    const to = data?.to?.hash ? String(data.to.hash).toLowerCase() : undefined;
    if (!from && !to) return null;
    return { from, to };
  } catch {
    return null;
  }
}

async function fetchBlockscoutEthereum(address: string): Promise<LookupResult> {
  const addr = address.toLowerCase();
  let txRes: Response;
  let tokenRes: Response;
  try {
    // Blockscout is a public explorer called directly (CORS-open, no key).
    recordNetworkActivity(resolveMode(false));
    [txRes, tokenRes] = await Promise.all([
      fetch(blockscoutUrl(`/addresses/${address}/transactions`)),
      fetch(blockscoutUrl(`/addresses/${address}/token-transfers`))
    ]);
  } catch (err) {
    throw new Error(
      isNetworkFetchError(err)
        ? 'Could not reach Blockscout (eth.blockscout.com). Check your internet connection and try again.'
        : err instanceof Error
          ? err.message
          : 'Blockscout request failed.'
    );
  }

  if (!txRes.ok && !tokenRes.ok) {
    throw new Error(
      `Blockscout returned ${txRes.status} for transaction history and ${tokenRes.status} for token transfers.`
    );
  }

  const txData = txRes.ok ? await txRes.json() : { items: [] };
  const tokenData = tokenRes.ok ? await tokenRes.json() : { items: [] };
  const transactions: Transaction[] = [];
  const seen = new Set<string>();

  for (const row of txData.items ?? []) {
    const from = row.from?.hash?.toLowerCase();
    const to = row.to?.hash?.toLowerCase();
    if (!from || !to) continue;
    if (from !== addr && to !== addr) continue;
    const valueWei = BigInt(row.value ?? '0');
    if (valueWei === 0n) continue;
    const key = `native:${row.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    transactions.push({
      id: makeId('rpc'),
      timestamp: row.timestamp ? new Date(row.timestamp).getTime() : Date.now(),
      type: from === addr ? 'transfer_out' : 'transfer_in',
      asset: 'ETH',
      amount: Number(valueWei) / 1e18,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:blockscout',
      sourceRef: row.hash,
      walletAddress: address,
      counterpartyAddress: from === addr ? row.to?.hash : row.from?.hash,
      chain: 'ethereum',
      flags: ['possible_internal_transfer', 'missing_cost_basis'],
      isInternalTransfer: false,
      raw: row
    });
  }

  for (const row of tokenData.items ?? []) {
    const from = row.from?.hash?.toLowerCase();
    const to = row.to?.hash?.toLowerCase();
    if (!from || !to) continue;
    if (from !== addr && to !== addr) continue;
    const decimals = Number(row.token?.decimals ?? 18);
    const raw = BigInt(row.total?.value ?? row.value ?? '0');
    if (raw === 0n) continue;
    const key = `token:${row.transaction_hash}:${row.log_index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    transactions.push({
      id: makeId('rpc'),
      timestamp: row.timestamp ? new Date(row.timestamp).getTime() : Date.now(),
      type: from === addr ? 'transfer_out' : 'transfer_in',
      asset: row.token?.symbol || 'TOKEN',
      amount: Number(raw) / 10 ** decimals,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:blockscout',
      sourceRef: row.transaction_hash,
      walletAddress: address,
      counterpartyAddress: from === addr ? row.to?.hash : row.from?.hash,
      contractAddress: row.token?.address_hash,
      chain: 'ethereum',
      flags: ['possible_internal_transfer', 'missing_cost_basis'],
      isInternalTransfer: false,
      raw: row
    });
  }

  return {
    transactions,
    warnings: transactions.length
      ? [{ address, message: 'Fetched via Blockscout (free explorer, no API key needed).' }]
      : [{ address, message: 'No transactions found for this address on Ethereum mainnet.' }]
  };
}

async function fetchEthereumAddress(address: string, config: LookupConfig): Promise<LookupResult> {
  const errors: string[] = [];

  try {
    return await fetchBlockscoutEthereum(address);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : 'Blockscout failed.');
  }

  // Ethereum no longer falls back to Etherscan automatically — many networks cannot resolve
  // api.etherscan.io (ENOTFOUND), which spams the Vite dev console without helping the user.
  // Blockscout is free and does not need an API key; Alchemy is the optional secondary source.

  if (config.alchemyApiKey) {
    try {
      return await fetchAlchemyEvm(
        address,
        'eth-mainnet',
        config.alchemyApiKey,
        'ETH',
        'ethereum',
        config.customApiKey
      );
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'Alchemy failed.');
    }
  }

  const hint = config.alchemyApiKey
    ? 'Blockscout and Alchemy both failed.'
    : 'Blockscout failed. Add an Alchemy API key in Settings for a secondary source.';
  throw new Error(`${hint} ${errors.join(' ')}`.trim());
}

export interface LookupConfig {
  chain: ChainDef;
  alchemyApiKey?: string;
  heliusApiKey?: string;
  moralisApiKey?: string;
  customBaseUrl?: string;
  customApiKey?: string;
  customAsset?: string;
  /**
   * For incremental sync: only fetch transactions NEWER than this signature.
   * When set, Helius uses `after-signature` with ascending sort.
   */
  afterSignature?: string;
  /** When true, do not fall back to Alchemy if Helius returns zero rows. */
  incrementalOnly?: boolean;
  /** Signatures already in DB — never re-import these on sync. */
  skipSignatures?: Set<string>;
}

function withDexSwapDetection(result: LookupResult): LookupResult {
  const { transactions } = detectDexSwaps(result.transactions);
  return { ...result, transactions };
}

/** Conservative fallback applied only after richer provider classification. */
export function applyUnifiedIncomingClassifications(transactions: Transaction[]): Transaction[] {
  return transactions.map((transaction) => {
    if (transaction.type !== 'transfer_in') return transaction;
    const match = classifyIncomingTransfer({
      contractAddress: transaction.contractAddress,
      counterpartyAddress: transaction.counterpartyAddress,
      chain: transaction.chain,
      amount: transaction.amount
    });
    if (!match) return transaction;
    return {
      ...transaction,
      type: match.type,
      category: match.kind,
      notes: match.label,
      flags: match.source === 'reward_registry_static' ? [] : ['needs_review']
    };
  });
}

async function lookupOneAddress(address: string, config: LookupConfig): Promise<LookupResult & { newestSignature?: string }> {
  const { chain } = config;
  if (chain.provider === 'unsupported') {
    throw new Error(`${chain.label} wallet sync is not supported yet — import a CSV export instead.`);
  }
  // Chains no wallet-data provider serves (live-verified 2026-07-21) — fail
  // with the calm "not available yet" message, never an API-key error:
  // - fantom: dropped by Moralis product-wide, not offered by Alchemy
  //   (fantom-mainnet does not exist), chainid 250 unsupported on Etherscan
  //   V2. Removed from the import dropdown — only legacy saved wallets still
  //   reach this path via Sync.
  // - aurora: dropped by Moralis, no Alchemy network exists, chainid
  //   1313161554 unsupported on Etherscan V2. Hosted mode only — in BYOK a
  //   user-pasted custom explorer URL can still serve it.
  if (chain.id === 'fantom' || (chain.id === 'aurora' && isSaasMode())) {
    throw new Error(chainNotAvailableMessage());
  }
  if (chain.provider === 'blockstream') {
    return fetchBitcoin(address, 'https://blockstream.info/api', chain.asset);
  }
  if (chain.provider === 'alchemy_evm') {
    // Moralis is the primary EVM source when key is provided — returns decoded + spam-flagged data
    if (hasRpcCredential(config.moralisApiKey)) {
      const { getMoralisChain, fetchMoralisEvm, MORALIS_DROPPED_CHAINS } = await import('@/lib/rpc/moralis');
      // Moralis dropped these chains product-wide (2026-07): /history
      // HTTP-400s `chain must be a valid enum value` for them, so skip the
      // wasted round-trip and go straight to the Alchemy/Etherscan path.
      const moralisChain = MORALIS_DROPPED_CHAINS.has(chain.id) ? null : getMoralisChain(chain.id);
      if (moralisChain) {
        try {
          const result = await fetchMoralisEvm(address, chain.id, chain.asset, rpcCredential(config.moralisApiKey));
          if (result.transactions.length > 0 || !hasRpcCredential(config.alchemyApiKey)) {
            return withDexSwapDetection({
              transactions: applyUnifiedIncomingClassifications(result.transactions),
              warnings: result.warnings.map((msg) => ({ address, message: msg }))
            });
          }
        } catch { /* fall through to Alchemy */ }
      }
    }
    if (chain.id === 'ethereum') {
      return withDexSwapDetection(await fetchEthereumAddress(address, config));
    }
    if (!hasRpcCredential(config.alchemyApiKey)) throw new Error('Add your Alchemy API key (or Moralis API key) in Settings first.');
    return withDexSwapDetection(
      await fetchAlchemyEvm(
        address,
        chain.alchemyNetwork!,
        rpcCredential(config.alchemyApiKey),
        chain.asset,
        chain.id,
        config.customApiKey
      )
    );
  }
  if (chain.provider === 'alchemy_solana') {
    // Helius is the primary Solana source when key is provided.
    // It returns pre-parsed type labels (SWAP, STAKE, NFT_SALE, etc.) including
    // Jupiter DCA fills with exact token amounts — eliminates need for Noves on Solana.
    let heliusError: string | undefined;
    if (hasRpcCredential(config.heliusApiKey)) {
      try {
        const { fetchHeliusSolana } = await import('@/lib/rpc/helius');
        const result = await fetchHeliusSolana(
          address,
          rpcCredential(config.heliusApiKey),
          config.afterSignature ? 10 : 20,
          config.afterSignature,
          config.skipSignatures
        );
        if (result.transactions.length > 0 || config.incrementalOnly) {
          return {
            ...withDexSwapDetection({
              transactions: result.transactions,
              warnings: result.warnings.map((msg) => ({ address, message: msg }))
            }),
            newestSignature: result.newestSignature
          };
        }
      } catch (err) {
        heliusError = err instanceof Error ? err.message : 'Helius lookup failed';
        // Fall through to Alchemy on full import only.
      }
    }
    if (config.incrementalOnly) {
      return {
        transactions: [],
        warnings: [
          {
            address,
            message: heliusError
              ? `Sync failed (${heliusError}). Try Remove + re-import, or check API keys.`
              : 'No new transactions since last sync.'
          }
        ]
      };
    }
    if (!hasRpcCredential(config.alchemyApiKey)) {
      throw new Error(
        heliusError
          ? `Helius failed (${heliusError}) and no Alchemy key is available. In SaaS mode set VITE_API_URL to https://sololedger-production.up.railway.app (hosted keys), or add keys to server/.env.`
          : 'Add your Helius API key (or Alchemy API key) in Settings first.'
      );
    }
    try {
      return withDexSwapDetection(await fetchAlchemySolana(address, rpcCredential(config.alchemyApiKey)));
    } catch (err) {
      const alchemyMsg = err instanceof Error ? err.message : 'Alchemy lookup failed';
      if (/401/.test(alchemyMsg)) {
        throw new Error(
          'Alchemy API returned 401 (unauthorized). Your app is calling an API server that has no valid Alchemy/Helius keys. ' +
            'For local SaaS testing use: set VITE_API_URL=https://sololedger-production.up.railway.app ' +
            '(keep the local server on :3001 for automatic portfolio ledger repair RPC). Or put HELIUS_API_KEY / ALCHEMY_API_KEY in sololedger_claude_V3/server/.env and restart the API.'
        );
      }
      throw heliusError ? new Error(`Helius: ${heliusError}; Alchemy: ${alchemyMsg}`) : err;
    }
  }
  if (!config.customBaseUrl) throw new Error('Enter an explorer base URL.');
  return withDexSwapDetection(
    await fetchEtherscanCompatible(address, config.customBaseUrl, config.customApiKey ?? '', config.customAsset || 'TOKEN')
  );
}

/**
 * Looks up many addresses on one chain in one job. Paces requests slightly
 * so a batch of addresses doesn't burst past free-tier rate limits.
 */
export async function lookupManyAddresses(
  addresses: string[],
  config: LookupConfig,
  onProgress?: (done: number, total: number) => void
): Promise<{
  transactions: Transaction[];
  warnings: LookupWarning[];
  failed: LookupWarning[];
  perAddress: { address: string; count: number; newestSignature?: string }[];
}> {
  const transactions: Transaction[] = [];
  const warnings: LookupWarning[] = [];
  const failed: LookupWarning[] = [];
  const perAddress: { address: string; count: number; newestSignature?: string }[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i].trim();
    if (!address) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await lookupOneAddress(address, config);
      transactions.push(...result.transactions);
      warnings.push(...result.warnings);
      perAddress.push({
        address,
        count: result.transactions.length,
        newestSignature: result.newestSignature
      });
    } catch (err) {
      failed.push({ address, message: err instanceof Error ? err.message : 'Lookup failed.' });
    }
    onProgress?.(i + 1, addresses.length);
    // eslint-disable-next-line no-await-in-loop
    if (i < addresses.length - 1) await new Promise((r) => setTimeout(r, 400));
  }

  return { transactions, warnings, failed, perAddress };
}
