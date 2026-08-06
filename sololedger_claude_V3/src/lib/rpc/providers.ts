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
import {
  collectSequentialCursor,
  type PaginationEvidence
} from '@/lib/rpc/pagination';

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
  // Wave 1 — Alchemy Enhanced API verified 2026-07-21 (plan v7.1).
  | 'abstract'
  | 'apechain'
  | 'anime'
  | 'berachain'
  | 'hyperevm'
  | 'ink'
  | 'lens'
  | 'monad'
  | 'mythos'
  | 'robinhood'
  | 'rootstock'
  | 'ronin'
  | 'shape'
  | 'settlus'
  | 'soneium'
  | 'story'
  | 'unichain'
  | 'worldchain'
  | 'zora'
  | 'zetachain'
  // Wave 2 — Alchemy RPC-only; Etherscan V2 fallback (plan v7.1).
  | 'fraxtal'
  | 'sei'
  | 'sonic'
  | 'plasma'
  | 'stable'
  | 'megaeth'
  | 'katana'
  | 'custom_evm';

export interface ChainDef {
  id: ChainId;
  label: string;
  asset: string;
  provider: 'blockstream' | 'alchemy_evm' | 'alchemy_solana' | 'etherscan_compatible' | 'unsupported';
  alchemyNetwork?: string; // Alchemy's network slug, e.g. "eth-mainnet"
  needsKey: boolean;
}

/**
 * Chains hidden from actionable import choices. Fantom is removed
 * (2026-07-21, user decision): no wallet-data provider serves it — Moralis
 * dropped it product-wide, Alchemy never offered fantom-mainnet, Etherscan
 * V2 has no chainid 250. The CHAINS registry entry STAYS so legacy Fantom
 * data still classifies/prices, and a legacy Fantom wallet hitting Sync gets
 * a calm "not available yet" message (see lookupOneAddress in providers.ts).
 * StarkNet is also hidden because its registry entry is pricing/display-only:
 * no non-EVM wallet-history provider is wired yet.
 */
export const DROPDOWN_HIDDEN_CHAINS: ReadonlySet<ChainId> = new Set(['fantom', 'starknet']);

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
  // ---- Plan v7.1 (2026-07-21): 27 verified-importable mainnet chains ----
  // Wave 1 — Alchemy Enhanced API works (primary path, same as current chains).
  { id: 'abstract', label: 'Abstract', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'abstract-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'apechain', label: 'ApeChain', asset: 'APE', provider: 'alchemy_evm', alchemyNetwork: 'apechain-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'anime', label: 'Animechain', asset: 'ANIME', provider: 'alchemy_evm', alchemyNetwork: 'anime-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'berachain', label: 'Berachain', asset: 'BERA', provider: 'alchemy_evm', alchemyNetwork: 'berachain-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  // Alchemy's slug really is hyperliquid-mainnet (chainid 999).
  { id: 'hyperevm', label: 'HyperEVM (Hyperliquid)', asset: 'HYPE', provider: 'alchemy_evm', alchemyNetwork: 'hyperliquid-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'ink', label: 'Ink', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'ink-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'lens', label: 'Lens', asset: 'GHO', provider: 'alchemy_evm', alchemyNetwork: 'lens-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'monad', label: 'Monad', asset: 'MON', provider: 'alchemy_evm', alchemyNetwork: 'monad-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'mythos', label: 'Mythos', asset: 'MYTH', provider: 'alchemy_evm', alchemyNetwork: 'mythos-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'robinhood', label: 'Robinhood Chain', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'robinhood-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'rootstock', label: 'Rootstock', asset: 'RBTC', provider: 'alchemy_evm', alchemyNetwork: 'rootstock-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'ronin', label: 'Ronin', asset: 'RON', provider: 'alchemy_evm', alchemyNetwork: 'ronin-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'shape', label: 'Shape', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'shape-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'settlus', label: 'Settlus', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'settlus-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'soneium', label: 'Soneium', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'soneium-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'story', label: 'Story', asset: 'IP', provider: 'alchemy_evm', alchemyNetwork: 'story-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'unichain', label: 'Unichain', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'unichain-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'worldchain', label: 'World Chain', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'worldchain-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'zora', label: 'Zora', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'zora-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  { id: 'zetachain', label: 'ZetaChain', asset: 'ZETA', provider: 'alchemy_evm', alchemyNetwork: 'zetachain-mainnet', needsKey: true }, // Enhanced API verified 2026-07-21
  // Wave 2 — Alchemy RPC-only; imports work via the any-Alchemy-failure →
  // Etherscan V2 fallback (same path as mantle).
  { id: 'fraxtal', label: 'Fraxtal', asset: 'FRAX', provider: 'alchemy_evm', alchemyNetwork: 'frax-mainnet', needsKey: true }, // Alchemy RPC-only; Etherscan V2 fallback (verified 2026-07-21)
  { id: 'sei', label: 'Sei', asset: 'SEI', provider: 'alchemy_evm', alchemyNetwork: 'sei-mainnet', needsKey: true }, // Alchemy RPC-only; Etherscan V2 fallback (verified 2026-07-21)
  { id: 'sonic', label: 'Sonic', asset: 'S', provider: 'alchemy_evm', alchemyNetwork: 'sonic-mainnet', needsKey: true }, // Alchemy RPC-only; Etherscan V2 fallback (verified 2026-07-21)
  { id: 'plasma', label: 'Plasma', asset: 'XPL', provider: 'alchemy_evm', alchemyNetwork: 'plasma-mainnet', needsKey: true }, // Alchemy RPC-only; Etherscan V2 fallback (verified 2026-07-21)
  { id: 'stable', label: 'Stable', asset: 'USDT0', provider: 'alchemy_evm', alchemyNetwork: 'stable-mainnet', needsKey: true }, // Alchemy RPC-only; Etherscan V2 fallback (verified 2026-07-21)
  { id: 'megaeth', label: 'MegaETH', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'megaeth-mainnet', needsKey: true }, // Alchemy RPC-only; Etherscan V2 fallback (verified 2026-07-21)
  { id: 'katana', label: 'Katana', asset: 'ETH', provider: 'alchemy_evm', alchemyNetwork: 'katana-mainnet', needsKey: true }, // Alchemy RPC-only; Etherscan V2 fallback (verified 2026-07-21)
  { id: 'custom_evm', label: 'Other EVM chain (Etherscan-compatible)', asset: '', provider: 'etherscan_compatible', needsKey: true }
];

/** Registry-derived EVM classification shared by catalog/form behavior. */
export function isEvmChain(chain: Pick<ChainDef, 'provider'>): boolean {
  return chain.provider === 'alchemy_evm' || chain.provider === 'etherscan_compatible';
}

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
  solana: 'solana',
  // Plan v7.1 chains — each slug verified against CoinGecko /asset_platforms
  // (matched on chain_identifier) 2026-07-21. anime, mythos and settlus have
  // no CoinGecko asset platform — token-contract pricing does not apply
  // there (native-coin pricing is unaffected).
  abstract: 'abstract',
  apechain: 'apechain',
  // anime: no CoinGecko asset platform
  berachain: 'berachain',
  hyperevm: 'hyperevm',
  ink: 'ink',
  lens: 'lens',
  monad: 'monad',
  // mythos: no CoinGecko asset platform
  robinhood: 'robinhood',
  rootstock: 'rootstock',
  ronin: 'ronin',
  shape: 'shape',
  // settlus: no CoinGecko asset platform
  soneium: 'soneium',
  story: 'story',
  unichain: 'unichain',
  worldchain: 'world-chain',
  zora: 'zora-network',
  zetachain: 'zetachain',
  fraxtal: 'fraxtal',
  sei: 'sei-v2',
  sonic: 'sonic',
  plasma: 'plasma',
  stable: 'stable',
  megaeth: 'megaeth',
  katana: 'katana'
};

export interface LookupWarning {
  address: string;
  message: string;
}

export interface LookupResult {
  transactions: Transaction[];
  warnings: LookupWarning[];
  streamOutcomes?: ProviderStreamOutcome[];
}

export interface ProviderStreamOutcome extends PaginationEvidence {
  endpoint: string;
  required: boolean;
}

// ---- Bitcoin: Blockstream/mempool.space-compatible, no key ----

/**
 * Convert one esplora-shaped tx row into a ledger Transaction for `address`.
 *
 * Amount semantics (round-4 fix — the phantom-holdings root cause):
 *  - Incoming: sum of outputs paying the address.
 *  - Outgoing: inputs FROM the address − outputs back to it (change) − the
 *    fee this address actually paid. The pre-fix code applied the INCOMING
 *    rule in both directions, so a batched exchange sweep — the watched
 *    address one of many vin entries (e.g. "65 inputs → Binance"), no vout
 *    returning to it — imported as a transfer_out of amount 0. The receive
 *    stayed on the ledger, the spend effectively vanished, and the address
 *    kept a phantom balance forever.
 *  - Fee attribution: the full tx fee is attributed ONLY when every input
 *    belongs to the address (a sole-input send: vin − change − fee is
 *    exactly what the recipient received). In a batched sweep the batching
 *    entity (the exchange) pays the shared fee out of its own outputs, so
 *    attributing any of it to one input would overstate what left the
 *    address — the fee stays 0 there and the amount is the full consumed
 *    UTXO value, netting the address to its true on-chain balance.
 */
export function parseBlockstreamTx(row: any, address: string, asset: string): Transaction {
  const satsFromAddr = (row.vin ?? []).reduce(
    (s: number, v: any) => (v.prevout?.scriptpubkey_address === address ? s + (v.prevout?.value ?? 0) : s),
    0
  );
  const satsToAddr = (row.vout ?? []).reduce(
    (s: number, o: any) => (o.scriptpubkey_address === address ? s + (o.value ?? 0) : s),
    0
  );
  const isOutgoing = satsFromAddr > 0;
  const soleInput =
    isOutgoing &&
    (row.vin ?? []).length > 0 &&
    (row.vin ?? []).every((v: any) => v.prevout?.scriptpubkey_address === address);
  const feeSats = typeof row.fee === 'number' && soleInput ? row.fee : 0;
  const netSats = isOutgoing
    ? Math.max(0, satsFromAddr - satsToAddr - feeSats)
    : satsToAddr;

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
    amount: netSats / 1e8,
    feeAsset: feeSats > 0 ? asset : undefined,
    feeAmount: feeSats > 0 ? feeSats / 1e8 : undefined,
    fiatCurrency: 'USD',
    fiatValue: undefined,
    source: 'rpc:blockstream',
    sourceRef: row.txid,
    walletAddress: address,
    counterpartyAddress: counterparty,
    chain: 'bitcoin',
    flags: ['possible_internal_transfer', 'missing_market_value'] as const,
    isInternalTransfer: false,
    raw: row
  } as Transaction;
}

/** Map esplora rows for one address (every returned row touches it by construction). */
export function parseBlockstreamTxs(rows: any[], address: string, asset: string): Transaction[] {
  return rows.map((row) => parseBlockstreamTx(row, address, asset));
}

/** Esplora chain pages contain at most 25 confirmed transactions. */
const BLOCKSTREAM_CONFIRMED_PAGE_SIZE = 25;
/** Large but finite safety budget; exhaustion is reported rather than hidden. */
const BLOCKSTREAM_MAX_PAGES = 100;

export async function fetchBitcoin(address: string, baseUrl: string, asset: string): Promise<LookupResult> {
  // Public explorer (no key, no SaaS proxy) → always a direct browser call.
  recordNetworkActivity(resolveMode(false));
  const collected = await collectSequentialCursor<any>({
    maxPages: BLOCKSTREAM_MAX_PAGES,
    itemKey: (row) => typeof row?.txid === 'string' ? row.txid : undefined,
    fetchPage: async (lastConfirmedTxid) => {
    const url = lastConfirmedTxid
      ? `${baseUrl}/address/${address}/txs/chain/${lastConfirmedTxid}`
      : `${baseUrl}/address/${address}/txs`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Explorer API returned ${res.status}`);
    const data: unknown = await res.json();
    if (!Array.isArray(data)) throw new Error('Explorer API returned malformed transaction history.');
    const confirmed = data.filter((row: any) => row?.status?.confirmed === true);
    const lastConfirmed = confirmed[confirmed.length - 1];
    return {
      items: data,
      // The initial endpoint may prepend mempool rows. Continuation depends on
      // the confirmed count, never the total response length.
      nextCursor: confirmed.length === BLOCKSTREAM_CONFIRMED_PAGE_SIZE && typeof lastConfirmed?.txid === 'string'
        ? lastConfirmed.txid : undefined
    };
  }});

  const outcome: ProviderStreamOutcome = {
    endpoint: 'blockstream:transactions', required: true, ...collected.evidence
  };
  return {
    transactions: parseBlockstreamTxs(collected.items, address, asset),
    warnings: partialPaginationWarning(address, 'Blockstream transaction', collected.evidence),
    streamOutcomes: [outcome]
  };
}

export function alchemyRpcUrl(network: string): string {
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

export function alchemyFetch(url: string, init: RequestInit): Promise<Response> {
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
 * is daily-quota-limited), plus the 14 plan-v7.1 chains below (abstract,
 * apechain, berachain, hyperevm, monad, unichain, worldchain and all seven
 * Wave-2 chains — fraxtal/sei/sonic/plasma/stable/megaeth/katana, which are
 * RPC-only on Alchemy so V2 IS their import path, same as mantle).
 * base/avalanche are PAID-plan-gated on V2 and already covered by Moralis +
 * Alchemy — deliberately NOT listed. No V2 ids exist for fantom/zksync/
 * scroll/aurora (unsupported chainid on V2).
 */
export const ETHERSCAN_V2_CHAIN_IDS: Partial<Record<ChainId, number>> = {
  ethereum: 1,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
  bsc: 56,
  celo: 42220,
  gnosis: 100,
  linea: 59144,
  blast: 81457,
  mantle: 5000,
  // Plan v7.1 additions (verified 2026-07-21) — Wave 1 chains that also
  // answer on the V2 free tier:
  abstract: 2741,
  apechain: 33139,
  berachain: 80094,
  hyperevm: 999,
  monad: 143,
  unichain: 130,
  worldchain: 480,
  // Wave 2 (Alchemy RPC-only — V2 is the import path):
  fraxtal: 252,
  sei: 1329,
  sonic: 146,
  plasma: 9745,
  stable: 988,
  megaeth: 4326,
  katana: 747474
};

function etherscanV2BaseUrl(chainId: ChainId): string | null {
  const id = ETHERSCAN_V2_CHAIN_IDS[chainId];
  return id != null ? `https://api.etherscan.io/v2/api?chainid=${id}` : null;
}

function isAlchemyRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('rate limit') || msg.includes('429') || msg.toLowerCase().includes('rate-limited');
}

export function alchemyHeaders(apiKey: string): HeadersInit {
  if (isSaasMode()) {
    return { 'Content-Type': 'application/json' };
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
}

function partialPaginationWarning(address: string, endpoint: string, evidence: PaginationEvidence): LookupWarning[] {
  if (evidence.status === 'complete') return [];
  return [{
    address,
    message: `${endpoint} history is partial (${evidence.termination}; ${evidence.pages} page${evidence.pages === 1 ? '' : 's'} retained).`
  }];
}

function alchemyTransferIdentity(row: any): string {
  if (row?.uniqueId != null) return String(row.uniqueId).toLowerCase();
  return [
    row?.hash, row?.category, row?.rawContract?.address, row?.from, row?.to,
    row?.value, row?.tokenId, row?.erc1155Metadata?.[0]?.tokenId,
    row?.erc1155Metadata?.[0]?.value
  ].map((value) => String(value ?? '').toLowerCase()).join(':');
}

function alchemyEventSourceRef(row: any): string {
  return `alchemy:event:${alchemyTransferIdentity(row)}`;
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
  const body = (direction: 'from' | 'to', pageKey?: string) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'alchemy_getAssetTransfers',
    params: [
      {
        [direction === 'from' ? 'fromAddress' : 'toAddress']: address,
        category: ['external', 'erc20', 'erc721', 'erc1155'],
        withMetadata: true,
        excludeZeroValue: true,
        maxCount: '0x64',
        ...(pageKey ? { pageKey } : {})
      }
    ]
  });

  const headers = alchemyHeaders(apiKey);
  const loadReceipt = createReceiptLoader((hash) => fetchEvmTransactionReceipt(url, hash, headers));
  const collectDirection = (direction: 'from' | 'to') => collectSequentialCursor<any, string>({
    maxPages: 100,
    itemKey: alchemyTransferIdentity,
    fetchPage: async (pageKey) => {
      const res = await alchemyFetch(url, {
        method: 'POST', headers, body: JSON.stringify(body(direction, pageKey))
      });
      const data = await res.json();
      if (!res.ok) throw new Error(alchemyErrorMessage(res.status, data));
      if (data.error) throw new Error(alchemyErrorMessage(data.error?.code ?? 0, { error: data.error }));
      if (!Array.isArray(data.result?.transfers)) throw new Error('Alchemy returned malformed transfer history.');
      return { items: data.result.transfers, nextCursor: data.result.pageKey };
    }
  });

  const [outgoing, incoming] = await Promise.all([
    collectDirection('from'),
    collectDirection('to')
  ]);

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
      sourceRef: t.category === 'external' ? t.hash : alchemyEventSourceRef(t),
      txHash: t.hash,
      walletAddress: address,
      counterpartyAddress: direction === 'transfer_in' ? t.from : t.to,
      contractAddress: t.rawContract?.address || undefined,
      chain: chainId,
      category: unified?.kind,
      legacyCategory: unified?.legacyKind,
      categoryOrigin: unified?.source === 'reward_registry_static' ? 'provider' : unified?.kind ? 'suggestion' : undefined,
      notes: unifiedIsIncome ? unified.label : decodedIsSpecific ? decoded.notes : unified?.label,
      flags: unified?.source === 'reward_registry_static'
        ? []
        : unified || decodedIsSpecific
          ? (['needs_review'] as FlagReason[])
        : ['possible_internal_transfer', 'missing_market_value'],
      isInternalTransfer: false,
      raw: t
    };
  };

  const combined = new Map<string, { row: any; direction: 'transfer_out' | 'transfer_in' }>();
  const isSelfTransfer = (row: any) =>
    typeof row?.from === 'string' && typeof row?.to === 'string' &&
    row.from.toLowerCase() === address.toLowerCase() && row.to.toLowerCase() === address.toLowerCase();
  for (const row of outgoing.items) {
    if (!isSelfTransfer(row)) combined.set(alchemyTransferIdentity(row), { row, direction: 'transfer_out' });
  }
  for (const row of incoming.items) {
    if (isSelfTransfer(row)) continue;
    const key = alchemyTransferIdentity(row);
    if (!combined.has(key)) combined.set(key, { row, direction: 'transfer_in' });
  }
  const transactions = await Promise.all(
    [...combined.values()].map(({ row, direction }) => toTx(row, direction))
  );
  const streamOutcomes: ProviderStreamOutcome[] = [
    { endpoint: 'alchemy_getAssetTransfers:outgoing', required: true, ...outgoing.evidence },
    { endpoint: 'alchemy_getAssetTransfers:incoming', required: true, ...incoming.evidence }
  ];
  const warnings = streamOutcomes.flatMap((outcome) =>
    partialPaginationWarning(address, outcome.endpoint, outcome));

  return { transactions, warnings, streamOutcomes };
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
        streamOutcomes: result.streamOutcomes,
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
        const result = await fetchEtherscanCompatible(address, baseUrl, rpcCredential(etherscanApiKey), asset, chainId);
        return {
          transactions: result.transactions,
          streamOutcomes: result.streamOutcomes,
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

export async function fetchAlchemySolana(address: string, apiKey: string): Promise<LookupResult> {
  const url = alchemyRpcUrl('solana-mainnet');
  const headers = alchemyHeaders(apiKey);

  const signaturePages = await collectSequentialCursor<{ signature: string; blockTime: number | null }>({
    maxPages: 100,
    itemKey: (row) => row.signature,
    fetchPage: async (before) => {
      const sigRes = await alchemyFetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
          params: [address, { limit: 1000, ...(before ? { before } : {}) }]
        })
      });
      const sigData = await sigRes.json();
      if (!sigRes.ok) throw new Error(alchemyErrorMessage(sigRes.status, sigData));
      if (sigData.error) throw new Error(alchemyErrorMessage(sigData.error.code ?? 0, sigData));
      if (!Array.isArray(sigData.result)) throw new Error('Alchemy returned malformed Solana signatures.');
      const rows = sigData.result as { signature: string; blockTime: number | null }[];
      if (rows.some((row) => typeof row?.signature !== 'string')) {
        throw new Error('Alchemy returned a malformed Solana signature row.');
      }
      return { items: rows, nextCursor: rows.length === 1000 ? rows[rows.length - 1].signature : undefined };
    }
  });

  const transactions: Transaction[] = [];
  let transactionFailures = 0;
  let firstTransactionFailure: string | undefined;

  for (const sig of signaturePages.items) {
    let txData: any;
    try {
      // eslint-disable-next-line no-await-in-loop
      const txRes = await alchemyFetch(url, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig.signature, { maxSupportedTransactionVersion: 0 }] })
      });
      // eslint-disable-next-line no-await-in-loop
      txData = await txRes.json();
      if (!txRes.ok || txData.error) throw new Error(
        alchemyErrorMessage(txRes.status, txData));
    } catch (error) {
      transactionFailures++;
      firstTransactionFailure ??= error instanceof Error ? error.message : 'getTransaction failed';
      continue;
    }
    const tx = txData.result;
    if (!tx) {
      transactionFailures++;
      firstTransactionFailure ??= `getTransaction returned no result for ${sig.signature}.`;
      continue;
    }
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
          flags: ['possible_internal_transfer', 'missing_market_value'],
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
        categoryOrigin: meta.isNft || reward ? 'provider' : undefined,
        notes: reward ? `${reward.label} — auto-classified as income` : undefined,
        flags: reward ? [] : ['possible_internal_transfer', 'missing_market_value'],
        isInternalTransfer: false,
        raw: tx
      });
    }
  }

  const signatureOutcome: ProviderStreamOutcome = {
    endpoint: 'alchemy:getSignaturesForAddress', required: true, ...signaturePages.evidence
  };
  const detailOutcome: ProviderStreamOutcome = transactionFailures === 0
    ? {
        endpoint: 'alchemy:getTransaction', required: true, status: 'complete',
        paginationRequired: false, paginationExhausted: true, pages: signaturePages.evidence.pages,
        termination: 'exhausted'
      }
    : {
        endpoint: 'alchemy:getTransaction', required: true, status: 'partial',
        paginationRequired: false, paginationExhausted: false, pages: signaturePages.evidence.pages,
        termination: 'partial_error', warning: `${transactionFailures} transaction detail request(s) failed. ${firstTransactionFailure}`
      };
  const streamOutcomes = [signatureOutcome, detailOutcome];
  return {
    transactions,
    streamOutcomes,
    warnings: streamOutcomes.flatMap((outcome) => partialPaginationWarning(address, outcome.endpoint, outcome))
  };
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

export async function fetchEtherscanCompatible(address: string, baseUrl: string, apiKey: string, asset: string, chainId?: ChainId): Promise<LookupResult> {
  // Hosted mode needs no user key — the relay injects the server-side
  // Etherscan key (see etherscanRequestUrl).
  if (!apiKey?.trim() && !isSaasMode()) {
    throw new Error('Add a free Etherscan API key in Settings (etherscan.io/apis).');
  }

  // Hosted users must never see raw upstream explorer bodies (they can leak
  // key references or deprecated-endpoint noise) — scrub to the calm message.
  const explorerError = (detail: string | undefined, fallback: string): Error =>
    new Error(isSaasMode() ? HOSTED_CHAIN_TEMPORARILY_UNAVAILABLE : detail || fallback);

  const commonParams = {
    module: 'account',
    address,
    startblock: '0',
    endblock: '99999999',
    offset: '1000',
    sort: 'desc'
  };

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
      sourceRef: isToken ? row.__soloLedgerEventKey || row.hash : row.hash,
      txHash: row.hash,
      walletAddress: addr,
      chain: chainId,
      counterpartyAddress: isOutgoing ? row.to : row.from,
      contractAddress: isToken ? row.contractAddress : undefined,
      flags: ['possible_internal_transfer', 'missing_market_value'] as const,
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

  type ExplorerRow = Record<string, string> & { __soloLedgerEventKey?: string };
  interface RangeCollection { items: ExplorerRow[]; partial?: string }
  const MAX_EXPLORER_REQUESTS = 200;
  const RESULT_WINDOW_PAGES = 10;
  const PAGE_SIZE = Number(commonParams.offset);

  const collectAction = async (action: 'txlist' | 'tokentx') => {
    let requests = 0;
    let validatedPages = 0;
    const rowIdentity = (row: ExplorerRow): string => {
      if (action === 'txlist') return `native:${row.hash}`.toLowerCase();
      if (row.logIndex != null && row.logIndex !== '') {
        return `token:${row.hash}:log:${row.logIndex}`.toLowerCase();
      }
      return [
        row.hash, row.blockNumber, row.transactionIndex, row.contractAddress,
        row.from, row.to, row.value, row.tokenID, row.tokenDecimal
      ].map((value) => String(value ?? '').toLowerCase()).join(':');
    };
    const mergeOverlappingRows = (...groups: readonly ExplorerRow[][]): ExplorerRow[] => {
      const maximumCounts = new Map<string, number>();
      const representatives = new Map<string, ExplorerRow[]>();
      for (const group of groups) {
        const groupCounts = new Map<string, number>();
        for (const row of group) {
          const key = rowIdentity(row);
          const count = (groupCounts.get(key) ?? 0) + 1;
          groupCounts.set(key, count);
          const rows = representatives.get(key) ?? [];
          if (rows.length < count) rows.push(row);
          representatives.set(key, rows);
        }
        for (const [key, count] of groupCounts) {
          maximumCounts.set(key, Math.max(maximumCounts.get(key) ?? 0, count));
        }
      }
      return [...maximumCounts.entries()].flatMap(([key, count]) =>
        (representatives.get(key) ?? []).slice(0, count));
    };
    const loadRange = async (startBlock: number, endBlock: number): Promise<RangeCollection> => {
      const windowRows: ExplorerRow[] = [];
      for (let page = 1; page <= RESULT_WINDOW_PAGES; page++) {
        if (++requests > MAX_EXPLORER_REQUESTS) {
          return { items: windowRows, partial: 'Explorer range request safety budget was reached.' };
        }
        const url = etherscanRequestUrl(baseUrl, {
          ...commonParams, action, startblock: String(startBlock), endblock: String(endBlock), page: String(page)
        }, apiKey);
        let res: Response;
        try {
          // eslint-disable-next-line no-await-in-loop
          res = await etherscanFetch(url);
        } catch (error) {
          if (requests === 1) throw error;
          return { items: windowRows, partial: error instanceof Error ? error.message : String(error) };
        }
        if (!res.ok) {
          // eslint-disable-next-line no-await-in-loop
          const message = await parseExplorerError(res);
          if (requests === 1) throw explorerError(message, `Explorer API returned ${res.status}`);
          return { items: windowRows, partial: message };
        }
        // eslint-disable-next-line no-await-in-loop
        let data: any;
        try {
          // eslint-disable-next-line no-await-in-loop
          data = await res.json();
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Explorer returned malformed JSON.';
          if (requests === 1) throw explorerError(message, 'Explorer returned malformed JSON.');
          return { items: windowRows, partial: message };
        }
        if (!Array.isArray(data.result)) {
          const detail = typeof data.result === 'string' ? data.result : data.message;
          if (/no transactions found/i.test(String(detail ?? ''))) return { items: windowRows };
          if (requests === 1) throw explorerError(detail, 'Explorer returned malformed transaction history.');
          return { items: windowRows, partial: detail || 'Explorer returned malformed transaction history.' };
        }
        validatedPages++;
        windowRows.push(...data.result);
        if (data.result.length < PAGE_SIZE) return { items: windowRows };
      }

      if (startBlock === endBlock) {
        return {
          items: windowRows,
          partial: `Block ${startBlock} alone exceeds the explorer 10,000-result window.`
        };
      }

      const observedBlocks = windowRows.map((row) => Number(row.blockNumber))
        .filter((block) => Number.isSafeInteger(block) && block >= startBlock && block <= endBlock);
      const observedMin = observedBlocks.length ? Math.min(...observedBlocks) : undefined;
      const observedMax = observedBlocks.length ? Math.max(...observedBlocks) : undefined;
      if (observedMin != null && observedMin === observedMax) {
        const upper = observedMax < endBlock ? await loadRange(observedMax + 1, endBlock) : { items: [] };
        const exactBlock = await loadRange(observedMax, observedMax);
        const lower = observedMax > startBlock ? await loadRange(startBlock, observedMax - 1) : { items: [] };
        const partial = upper.partial ?? exactBlock.partial ?? lower.partial;
        if (partial) {
          return {
            items: mergeOverlappingRows(windowRows, upper.items, exactBlock.items, lower.items),
            partial
          };
        }
        return {
          items: [...upper.items, ...exactBlock.items, ...lower.items],
          partial: undefined
        };
      }

      // Discard the saturated parent probe and recursively query two inclusive,
      // non-overlapping children. Every boundary block belongs to exactly one.
      const midpoint = Math.floor((startBlock + endBlock) / 2);
      const upper = await loadRange(midpoint + 1, endBlock);
      const lower = await loadRange(startBlock, midpoint);
      const partial = upper.partial ?? lower.partial;
      return {
        items: partial
          ? mergeOverlappingRows(windowRows, upper.items, lower.items)
          : [...upper.items, ...lower.items],
        partial
      };
    };

    const collected = await loadRange(Number(commonParams.startblock), Number(commonParams.endblock));
    const exact = new Set<string>();
    const occurrences = new Map<string, number>();
    const items: ExplorerRow[] = [];
    for (const row of collected.items) {
      if (action === 'txlist') {
        const key = `native:${row.hash}`.toLowerCase();
        if (exact.has(key)) continue;
        exact.add(key);
        row.__soloLedgerEventKey = key;
        items.push(row);
      } else if (row.logIndex != null && row.logIndex !== '') {
        const key = `token:${row.hash}:log:${row.logIndex}`.toLowerCase();
        if (exact.has(key)) continue;
        exact.add(key);
        row.__soloLedgerEventKey = key;
        items.push(row);
      } else {
        const composite = [
          row.hash, row.blockNumber, row.transactionIndex, row.contractAddress,
          row.from, row.to, row.value, row.tokenID, row.tokenDecimal
        ].map((value) => String(value ?? '').toLowerCase()).join(':');
        const occurrence = occurrences.get(composite) ?? 0;
        occurrences.set(composite, occurrence + 1);
        row.__soloLedgerEventKey = `token:${composite}:occurrence:${occurrence}`;
        items.push(row);
      }
    }
    return {
      items,
      evidence: collected.partial ? {
        status: 'partial' as const, paginationRequired: requests > 1,
        paginationExhausted: false, pages: validatedPages, termination: 'partial_error' as const,
        warning: collected.partial
      } : {
        status: 'complete' as const, paginationRequired: requests > 1,
        paginationExhausted: true, pages: validatedPages, termination: 'exhausted' as const
      }
    };
  };

  // Preserve the native stream as required/fatal on page one. Token history
  // remains best-effort, but now carries an explicit failed/partial outcome.
  const native = await collectAction('txlist');
  let token: Awaited<ReturnType<typeof collectAction>> | undefined;
  let tokenFailure: string | undefined;
  try {
    token = await collectAction('tokentx');
  } catch (error) {
    tokenFailure = error instanceof Error ? error.message : String(error);
  }

  const streamOutcomes: ProviderStreamOutcome[] = [
    { endpoint: 'etherscan:txlist', required: true, ...native.evidence },
    token
      ? { endpoint: 'etherscan:tokentx', required: true, ...token.evidence }
      : {
          endpoint: 'etherscan:tokentx', required: true, status: 'partial',
          paginationRequired: true, paginationExhausted: false, pages: 0,
          termination: 'partial_error', warning: tokenFailure
        }
  ];
  const warnings: LookupWarning[] = [
    ...partialPaginationWarning(address, 'Etherscan native transaction', native.evidence),
    ...(token
      ? partialPaginationWarning(address, 'Etherscan token transfer', token.evidence)
      : [{
          address,
          message: isSaasMode()
            ? 'Token transfer history is temporarily unavailable on the hosted service — native transactions were still imported.'
            : `Token transfer fetch failed: ${tokenFailure}`
        }])
  ];
  const transactions = [
    ...native.items.map((row) => toEtherscanTx(row, address, asset, false)),
    ...(token?.items ?? []).map((row) => toEtherscanTx(row, address, asset, true))
  ];

  return { transactions, warnings, streamOutcomes };
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

export async function fetchBlockscoutEthereum(address: string): Promise<LookupResult> {
  const addr = address.toLowerCase();
  type BlockscoutCursor = Record<string, string | number | boolean>;
  const collectPath = (path: string, itemKey: (row: any) => string | undefined) =>
    collectSequentialCursor<any, BlockscoutCursor>({
      maxPages: 100,
      itemKey,
      cursorKey: (cursor) => JSON.stringify(Object.entries(cursor).sort(([a], [b]) => a.localeCompare(b))),
      fetchPage: async (cursor) => {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(cursor ?? {})) query.set(key, String(value));
        const url = blockscoutUrl(`${path}${query.size ? `?${query.toString()}` : ''}`);
        recordNetworkActivity(resolveMode(false));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Blockscout returned ${res.status} for ${path}.`);
        const data = await res.json();
        if (!Array.isArray(data?.items)) throw new Error('Blockscout returned malformed history.');
        return { items: data.items, nextCursor: data.next_page_params ?? undefined };
      }
    });
  const [txSettled, tokenSettled] = await Promise.allSettled([
    collectPath(`/addresses/${address}/transactions`, (row) => `native:${row?.hash}`.toLowerCase()),
    collectPath(`/addresses/${address}/token-transfers`, (row) =>
      row?.log_index == null
        ? undefined
        : `token:${row?.transaction_hash}:${row.log_index}:${row?.token?.address_hash ?? ''}`.toLowerCase())
  ]);
  if (txSettled.status === 'rejected') {
    const failure = txSettled.reason;
    throw new Error(
      isNetworkFetchError(failure)
        ? 'Could not reach Blockscout (eth.blockscout.com). Check your internet connection and try again.'
        : failure instanceof Error ? failure.message : 'Blockscout request failed.'
    );
  }
  if (tokenSettled.status === 'rejected') {
    const failure = tokenSettled.reason;
    throw new Error(
      isNetworkFetchError(failure)
        ? 'Could not reach Blockscout (eth.blockscout.com). Check your internet connection and try again.'
        : failure instanceof Error ? failure.message : 'Blockscout request failed.'
    );
  }

  const txRows = txSettled.value.items;
  const tokenRows = tokenSettled.value.items;
  const transactions: Transaction[] = [];
  const seen = new Set<string>();

  for (const row of txRows) {
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
      txHash: row.hash,
      walletAddress: address,
      counterpartyAddress: from === addr ? row.to?.hash : row.from?.hash,
      chain: 'ethereum',
      flags: ['possible_internal_transfer', 'missing_market_value'],
      isInternalTransfer: false,
      raw: row
    });
  }

  const unindexedOccurrences = new Map<string, number>();
  for (const row of tokenRows) {
    const from = row.from?.hash?.toLowerCase();
    const to = row.to?.hash?.toLowerCase();
    if (!from || !to) continue;
    if (from !== addr && to !== addr) continue;
    const decimals = Number(row.token?.decimals ?? 18);
    const raw = BigInt(row.total?.value ?? row.value ?? '0');
    if (raw === 0n) continue;
    const composite = [
      row.transaction_hash, row.token?.address_hash, from, to,
      row.total?.value ?? row.value, row.token?.token_id
    ].map((value) => String(value ?? '').toLowerCase()).join(':');
    const occurrence = unindexedOccurrences.get(composite) ?? 0;
    unindexedOccurrences.set(composite, occurrence + 1);
    const key = row.log_index == null
      ? `token:${composite}:occurrence:${occurrence}`
      : `token:${row.transaction_hash}:${row.log_index}`;
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
      sourceRef: row.log_index == null
        ? `blockscout:event:${composite}:occurrence:${occurrence}`
        : `blockscout:event:${row.transaction_hash}:log:${row.log_index}`.toLowerCase(),
      txHash: row.transaction_hash,
      walletAddress: address,
      counterpartyAddress: from === addr ? row.to?.hash : row.from?.hash,
      contractAddress: row.token?.address_hash,
      chain: 'ethereum',
      flags: ['possible_internal_transfer', 'missing_market_value'],
      isInternalTransfer: false,
      raw: row
    });
  }

  const txOutcome: ProviderStreamOutcome = {
    endpoint: 'blockscout:transactions', required: true, ...txSettled.value.evidence
  };
  const tokenOutcome: ProviderStreamOutcome = {
    endpoint: 'blockscout:token-transfers', required: true, ...tokenSettled.value.evidence
  };
  const paginationWarnings = [txOutcome, tokenOutcome].flatMap((outcome) =>
    partialPaginationWarning(address, outcome.endpoint, outcome));
  return {
    transactions,
    streamOutcomes: [txOutcome, tokenOutcome],
    warnings: [
      ...paginationWarnings,
      ...(transactions.length
      ? [{ address, message: 'Fetched via Blockscout (free explorer, no API key needed).' }]
      : [{ address, message: 'No transactions found for this address on Ethereum mainnet.' }])
    ]
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
              warnings: result.warnings.map((msg) => ({ address, message: msg })),
              streamOutcomes: result.streamOutcomes
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
          100,
          config.afterSignature,
          config.skipSignatures
        );
        if (result.transactions.length > 0 || config.incrementalOnly) {
          return {
            ...withDexSwapDetection({
              transactions: result.transactions,
              warnings: result.warnings.map((msg) => ({ address, message: msg })),
              streamOutcomes: result.streamOutcomes
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
    await fetchEtherscanCompatible(address, config.customBaseUrl, config.customApiKey ?? '', config.customAsset || 'TOKEN', chain.id)
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
  streamOutcomes?: ProviderStreamOutcome[];
  perAddress: {
    address: string;
    count: number;
    newestSignature?: string;
    /** Structured history evidence scoped to this exact successful lookup. */
    streamOutcomes?: ProviderStreamOutcome[];
  }[];
}> {
  const transactions: Transaction[] = [];
  const warnings: LookupWarning[] = [];
  const failed: LookupWarning[] = [];
  const streamOutcomes: ProviderStreamOutcome[] = [];
  const perAddress: {
    address: string; count: number; newestSignature?: string; streamOutcomes?: ProviderStreamOutcome[];
  }[] = [];

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i].trim();
    if (!address) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await lookupOneAddress(address, config);
      transactions.push(...result.transactions);
      warnings.push(...result.warnings);
      streamOutcomes.push(...(result.streamOutcomes ?? []));
      perAddress.push({
        address,
        count: result.transactions.length,
        newestSignature: result.newestSignature,
        streamOutcomes: result.streamOutcomes
      });
    } catch (err) {
      failed.push({ address, message: err instanceof Error ? err.message : 'Lookup failed.' });
    }
    onProgress?.(i + 1, addresses.length);
    // eslint-disable-next-line no-await-in-loop
    if (i < addresses.length - 1) await new Promise((r) => setTimeout(r, 400));
  }

  return { transactions, warnings, failed, streamOutcomes, perAddress };
}
