/**
 * Moralis Wallet History client for EVM chains.
 *
 * Primary EVM data source — returns decoded, categorized transactions with
 * automatic spam detection across 30+ chains.
 *
 * Endpoint: GET https://deep-index.moralis.io/api/v2.2/wallets/{address}/history
 * Docs: https://docs.moralis.com/data-api/evm/wallet/wallet-history
 *
 * Key advantages over raw Alchemy:
 *   - `category` field: token swap, nft sale, staking, airdrop, etc.
 *   - `possible_spam: true/false` on each ERC-20 transfer
 *   - `summary` human-readable description
 *   - `from_address_label` / `to_address_label` for known contracts (Uniswap, etc.)
 *   - No need for Noves calls on EVM chains covered here
 */

import { makeId } from '@/lib/parsers/types';
import type { Transaction, TxType, FlagReason } from '@/types/transaction';
import { classifyFromMoralis } from '@/lib/rpc/classificationEngine';
import { isSaasMode, getApiBase } from '@/lib/saas/config';
import { saasProxyFetch } from '@/lib/saas/api';
import { CHAINS, type ChainId } from '@/lib/rpc/providers';
import { recordNetworkActivity, resolveMode } from '@/lib/networkActivity';

const MORALIS_BASE = 'https://deep-index.moralis.io/api/v2.2';

/** SoloLedger ChainId → Moralis chain slug. */
const MORALIS_CHAIN: Partial<Record<ChainId, string>> = {
  ethereum: 'eth',
  polygon: 'polygon',
  arbitrum: 'arbitrum',
  base: 'base',
  bsc: 'bsc',
  optimism: 'optimism',
  avalanche: 'avalanche',
  fantom: 'fantom',
  celo: 'celo',
  zksync: 'zksync',
  linea: 'linea',
  scroll: 'scroll',
  blast: 'blast',
  mantle: 'mantle',
  aurora: 'aurora',
  cronos: 'cronos',
  gnosis: 'gnosis',
  moonbeam: 'moonbeam',
  moonriver: 'moonriver',
  metis: 'metis',
  opbnb: 'opbnb'
};

export function getMoralisChain(chainId: ChainId): string | null {
  return MORALIS_CHAIN[chainId] ?? null;
}

/** Moralis chain slug → SoloLedger ChainId (exact inverse of MORALIS_CHAIN). */
export const MORALIS_SLUG_TO_CHAIN: Readonly<Record<string, ChainId>> = Object.freeze(
  Object.fromEntries(
    Object.entries(MORALIS_CHAIN).map(([chainId, slug]) => [slug, chainId as ChainId])
  )
);

/**
 * Chains the app can actually IMPORT for an EVM address out of the box:
 * CHAINS registry entries with a working EVM provider path (`alchemy_evm`,
 * which routes Moralis-first). Excludes `starknet` (provider `unsupported`),
 * `custom_evm`, and chains that only work via the manual etherscan-compatible
 * path (aurora/moonriver) — those stay reachable through the manual dropdown.
 */
const IMPORTABLE_EVM_CHAINS: ReadonlySet<ChainId> = new Set(
  CHAINS.filter((c) => c.provider === 'alchemy_evm').map((c) => c.id)
);

/**
 * Resolve a Moralis chain slug (e.g. "eth", "polygon") to an app ChainId the
 * wallet-import pipeline can handle, or null when the chain is unknown to us
 * or not importable (starknet/custom_evm/etherscan-only chains).
 */
export function chainIdFromMoralisSlug(slug: string): ChainId | null {
  const chainId = MORALIS_SLUG_TO_CHAIN[slug.trim().toLowerCase()];
  return chainId && IMPORTABLE_EVM_CHAINS.has(chainId) ? chainId : null;
}

/** One entry of the Moralis /wallets/{address}/chains response. */
interface MoralisActiveChainEntry {
  chain?: string;
  chain_id?: string;
  /** Empty string when the wallet has no activity on this chain. */
  first_transaction?: string | { block_timestamp?: string } | null;
  /** Empty string when the wallet has no activity on this chain. */
  last_transaction?: string | { block_timestamp?: string } | null;
}

export interface WalletActiveChains {
  /** Importable app chains with real activity, in CHAINS registry order. */
  chains: ChainId[];
  /** Raw Moralis slugs that reported activity (before importable filtering). */
  activeSlugs: string[];
}

/**
 * Detect which EVM chains a wallet has real activity on, in ONE Moralis call:
 * GET /api/v2.2/wallets/{address}/chains. Entries whose first/last transaction
 * fields are empty strings are inactive and filtered out. Same routing pattern
 * as fetchMoralisEvm: the SaaS proxy in hosted mode (no user key needed),
 * direct-with-key otherwise.
 *
 * Throws on HTTP/network failure — callers treat that as "detection
 * unavailable" and fall back to the manual chain dropdown.
 */
export async function fetchWalletActiveChains(
  address: string,
  apiKey: string
): Promise<WalletActiveChains> {
  const url = isSaasMode()
    ? `${getApiBase()}/api/proxy/moralis/api/v2.2/wallets/${address}/chains`
    : `${MORALIS_BASE}/wallets/${address}/chains`;

  recordNetworkActivity(resolveMode(isSaasMode()));
  const res = isSaasMode()
    ? await saasProxyFetch(url.replace(getApiBase(), ''))
    : await fetch(url, { headers: { 'X-API-Key': apiKey, accept: 'application/json' } });

  if (!res.ok) throw new Error(`Moralis chain detection returned ${res.status}`);

  const data = await res.json();
  const entries: MoralisActiveChainEntry[] = data?.active_chains ?? [];
  const activeSlugs = entries
    .filter((e) => Boolean(e.first_transaction) && Boolean(e.last_transaction))
    .map((e) => String(e.chain ?? '').trim().toLowerCase())
    .filter(Boolean);

  const resolved = new Set<ChainId>();
  for (const slug of activeSlugs) {
    const chainId = chainIdFromMoralisSlug(slug);
    if (chainId) resolved.add(chainId);
  }
  // Stable display order = CHAINS registry order.
  const chains = CHAINS.filter((c) => resolved.has(c.id)).map((c) => c.id);
  return { chains, activeSlugs };
}

interface MoralisErc20Transfer {
  token_name: string;
  token_symbol: string;
  token_logo?: string;
  from_address: string;
  to_address: string;
  address: string;          // contract address
  value_formatted: string;
  possible_spam: boolean;
  verified_contract?: boolean;
}

export interface MoralisNativeTransfer {
  from_address?: string;
  to_address?: string;
  value_formatted: string;
  direction: 'send' | 'receive';
  token_symbol: string;
}

export interface MoralisTransaction {
  hash: string;
  block_timestamp: string;
  from_address: string;
  to_address: string;
  value: string;           // native value in wei
  receipt_status: string;  // "1" = success
  category: string;        // token swap, nft sale, send, receive, airdrop, etc.
  summary: string;
  possible_spam: boolean;
  erc20_transfers: MoralisErc20Transfer[];
  native_transfers: MoralisNativeTransfer[];
  nft_transfers: any[];
  from_address_label?: string;
  to_address_label?: string;
}

export function moralisTxToRows(
  mtx: MoralisTransaction,
  walletAddress: string,
  nativeAsset: string,
  chainId: ChainId
): Transaction[] {
  if (mtx.receipt_status !== '1') return []; // failed transactions
  const ts = new Date(mtx.block_timestamp).getTime();
  const walletLower = walletAddress.toLowerCase();
  const rows: Transaction[] = [];

  const classified = classifyFromMoralis(mtx.category, mtx.summary, mtx.possible_spam);

  // ── Token swap → single trade row ──────────────────────────────────────
  if (classified?.type === 'trade' || mtx.category === 'token swap') {
    const sent = mtx.erc20_transfers.filter(
      (t) => t.from_address.toLowerCase() === walletLower && !t.possible_spam
    );
    const received = mtx.erc20_transfers.filter(
      (t) => t.to_address.toLowerCase() === walletLower && !t.possible_spam
    );

    if (sent.length > 0 && received.length > 0) {
      const s = sent[0];
      const r = received[0];
      rows.push({
        id: makeId('rpc'),
        timestamp: ts,
        type: 'trade',
        asset: s.token_symbol,
        amount: parseFloat(s.value_formatted),
        counterAsset: r.token_symbol,
        counterAmount: parseFloat(r.value_formatted),
        contractAddress: s.address,
        fiatCurrency: 'USD',
        fiatValue: undefined,
        source: 'rpc:moralis',
        sourceRef: mtx.hash,
        walletAddress,
        counterpartyAddress: mtx.to_address, // DEX router
        chain: chainId,
        notes: mtx.summary || classified?.notes,
        flags: ['missing_cost_basis'] as FlagReason[],
        isInternalTransfer: false
      });
      return rows;
    }
  }

  // ── ERC-20 transfers ───────────────────────────────────────────────────
  for (const t of mtx.erc20_transfers) {
    const isSend = t.from_address.toLowerCase() === walletLower;
    const isReceive = t.to_address.toLowerCase() === walletLower;
    if (!isSend && !isReceive) continue;

    const spamFlag = t.possible_spam;
    const txType: TxType =
      classified?.type === 'income' && isReceive
        ? 'income'
        : isSend
          ? 'transfer_out'
          : 'transfer_in';

    rows.push({
      id: makeId('rpc'),
      timestamp: ts,
      type: txType,
      asset: t.token_symbol || 'TOKEN',
      amount: parseFloat(t.value_formatted),
      contractAddress: t.address,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:moralis',
      sourceRef: mtx.hash,
      walletAddress,
      counterpartyAddress: isSend ? t.to_address : t.from_address,
      chain: chainId,
      notes: mtx.summary,
      flags: ['possible_internal_transfer', 'missing_cost_basis'] as FlagReason[],
      isInternalTransfer: false,
      isSpam: spamFlag || undefined
    });
  }

  // ── Native ETH/BNB/MATIC transfers ───────────────────────────────────
  for (const t of mtx.native_transfers) {
    const amount = parseFloat(t.value_formatted);
    if (amount < 1e-9) continue; // dust

    const from = t.from_address || mtx.from_address;
    const to = t.to_address || mtx.to_address;
    const isSend = from?.toLowerCase() === walletLower || t.direction === 'send';
    rows.push({
      id: makeId('rpc'),
      timestamp: ts,
      type: isSend ? 'transfer_out' : 'transfer_in',
      asset: t.token_symbol || nativeAsset,
      amount,
      fiatCurrency: 'USD',
      fiatValue: undefined,
      source: 'rpc:moralis',
      sourceRef: mtx.hash,
      walletAddress,
      counterpartyAddress: isSend ? to : from,
      chain: chainId,
      notes: mtx.summary,
      flags: ['possible_internal_transfer', 'missing_cost_basis'] as FlagReason[],
      isInternalTransfer: false
    });
  }

  // Fallback: native value if no transfers decoded
  if (rows.length === 0 && mtx.value && mtx.value !== '0') {
    const amount = Number(BigInt(mtx.value)) / 1e18;
    if (amount > 1e-9) {
      const isSend = mtx.from_address.toLowerCase() === walletLower;
      rows.push({
        id: makeId('rpc'),
        timestamp: ts,
        type: isSend ? 'transfer_out' : 'transfer_in',
        asset: nativeAsset,
        amount,
        fiatCurrency: 'USD',
        fiatValue: undefined,
        source: 'rpc:moralis',
        sourceRef: mtx.hash,
        walletAddress,
        counterpartyAddress: isSend ? mtx.to_address : mtx.from_address,
        chain: chainId,
        notes: mtx.summary,
        flags: ['possible_internal_transfer', 'missing_cost_basis'] as FlagReason[],
        isInternalTransfer: false
      });
    }
  }

  return rows;
}

export interface MoralisLookupResult {
  transactions: Transaction[];
  warnings: string[];
}

/**
 * Fetch and parse full EVM transaction history via Moralis Wallet History API.
 * Returns decoded + spam-flagged rows. Paginates up to `maxPages` (default 5 = 500 txs).
 */
export async function fetchMoralisEvm(
  address: string,
  chainId: ChainId,
  nativeAsset: string,
  apiKey: string,
  maxPages = 5
): Promise<MoralisLookupResult> {
  const moralisChain = getMoralisChain(chainId);
  if (!moralisChain) {
    return { transactions: [], warnings: [`Moralis: chain ${chainId} not supported, using fallback.`] };
  }

  const transactions: Transaction[] = [];
  const warnings: string[] = [];
  let cursor: string | undefined;
  let page = 0;

  while (page < maxPages) {
    let url =
      isSaasMode()
        ? `${getApiBase()}/api/proxy/moralis/api/v2.2/wallets/${address}/history?chain=${moralisChain}&order=DESC&limit=100`
        : `${MORALIS_BASE}/wallets/${address}/history?chain=${moralisChain}&order=DESC&limit=100`;
    if (cursor) url += `&cursor=${cursor}`;

    recordNetworkActivity(resolveMode(isSaasMode()));
    const res = isSaasMode()
      ? await saasProxyFetch(url.replace(getApiBase(), ''))
      : await fetch(url, { headers: { 'X-API-Key': apiKey, accept: 'application/json' } });

    if (res.status === 401) { warnings.push('Moralis: invalid API key — check Settings.'); break; }
    if (res.status === 429) { warnings.push('Moralis: rate limited — try again later.'); break; }
    if (!res.ok) { warnings.push(`Moralis: returned ${res.status}`); break; }

    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    const result: MoralisTransaction[] = data?.result ?? [];

    for (const mtx of result) {
      const rows = moralisTxToRows(mtx, address, nativeAsset, chainId);
      transactions.push(...rows);
    }

    cursor = data?.cursor;
    if (!cursor || result.length < 100) break;
    page++;

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
  }

  return { transactions, warnings };
}
