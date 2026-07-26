/**
 * On-chain balance fetcher (round 4) — the truth anchor behind holdings
 * reconciliation. After a wallet sync, we ask each chain what the address
 * holds RIGHT NOW and store it in the `walletBalances` table; the dashboard
 * then reconciles tx-history-derived holdings against these numbers, so a
 * drained address (the phantom-BTC bug) reads 0 instead of a fiction.
 *
 * Transport reuses the exact provider plumbing the import path uses
 * (exported from providers.ts): the Vite `/alchemy-rpc` dev proxy and the
 * hosted SaaS relay for Alchemy calls, direct keyless Blockstream for
 * Bitcoin. Not to be confused with rpc/walletBalances.ts — the older
 * Portfolio-tab cross-check fetcher (Helius/Moralis), which never persists.
 *
 * Honesty rules:
 *  - A confirmed ZERO is stored (0 means "we checked — empty").
 *  - Assets present in the address's tx history but absent from the chain
 *    response get an explicit 0 row (that is what drains token phantoms).
 *  - A fetch failure NEVER touches previously stored balances and never
 *    fails the surrounding sync — the caller gets a per-address failure.
 */
import { db, replaceWalletBalances, getLookupAddresses } from '@/lib/storage/db';
import {
  alchemyFetch,
  alchemyHeaders,
  alchemyRpcUrl,
  CHAINS,
  type ChainDef
} from '@/lib/rpc/providers';
import { resolveSolanaMintSymbol } from '@/lib/assets/solanaMints';
import { recordNetworkActivity, resolveMode } from '@/lib/networkActivity';
import { isSaasMode } from '@/lib/saas/config';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import type { TaxSettings } from '@/types/transaction';

export interface FetchedBalance {
  asset: string;
  contractAddress?: string;
  amount: number;
}

export interface BalanceRefreshOutcome {
  /** Addresses whose balances were refreshed. */
  updated: number;
  /** Chains we cannot fetch balances for (no provider) — informational. */
  skipped: { address: string; chain: string; reason: string }[];
  /** Per-address fetch failures (prior balances kept). */
  failed: { address: string; message: string }[];
}

/** Cap on per-contract metadata lookups so a token-heavy wallet can't burst. */
const MAX_TOKEN_METADATA_LOOKUPS = 40;
/** Max tx-history assets zero-filled per address (safety bound). */
const MAX_ZERO_FILL = 100;

function resolveAlchemyKey(settings: TaxSettings): string | null {
  const own = settings.alchemyApiKey?.trim();
  if (own) return own;
  return isSaasMode() ? SAAS_PROXY_KEY : null;
}

// ─── Bitcoin (Blockstream, keyless) ─────────────────────────────────────────

async function fetchBitcoinBalance(address: string, nativeAsset: string): Promise<FetchedBalance[]> {
  recordNetworkActivity(resolveMode(false));
  const res = await fetch(`https://blockstream.info/api/address/${address}`);
  if (!res.ok) throw new Error(`Explorer API returned ${res.status}`);
  const data = await res.json();
  const chain = data?.chain_stats ?? {};
  const mempool = data?.mempool_stats ?? {};
  const sats =
    (Number(chain.funded_txo_sum ?? 0) - Number(chain.spent_txo_sum ?? 0)) +
    (Number(mempool.funded_txo_sum ?? 0) - Number(mempool.spent_txo_sum ?? 0));
  return [{ asset: nativeAsset, amount: sats / 1e8 }];
}

// ─── EVM (Alchemy: eth_getBalance + alchemy_getTokenBalances) ───────────────

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

async function alchemyCall(url: string, headers: HeadersInit, method: string, params: unknown[]): Promise<unknown> {
  const res = await alchemyFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const data = (await res.json()) as JsonRpcResponse;
  if (!res.ok) throw new Error(`Alchemy API returned ${res.status}`);
  if (data.error) throw new Error(data.error.message ?? `Alchemy error ${data.error.code ?? ''}`.trim());
  return data.result;
}

function hexToAmount(hex: string | null | undefined, decimals: number): number {
  if (!hex || hex === '0x' || hex === '0x0') return 0;
  try {
    return Number(BigInt(hex)) / 10 ** decimals;
  } catch {
    return 0;
  }
}

/** contract → display symbol, from the app's own imported tx history. */
async function txHistorySymbolMap(chain: string, address: string): Promise<Map<string, string>> {
  const lower = address.toLowerCase();
  const map = new Map<string, string>();
  const txs = await db.transactions
    .filter((t) => t.chain === chain && t.walletAddress?.toLowerCase() === lower && !!t.contractAddress)
    .toArray();
  for (const t of txs) {
    const key = t.contractAddress!.toLowerCase();
    if (!map.has(key)) map.set(key, t.asset);
  }
  return map;
}

async function fetchEvmBalances(
  chain: ChainDef,
  address: string,
  alchemyKey: string
): Promise<FetchedBalance[]> {
  const url = alchemyRpcUrl(chain.alchemyNetwork!);
  const headers = alchemyHeaders(alchemyKey);
  const balances: FetchedBalance[] = [];

  // Native coin (always stored — a confirmed 0 is data).
  const nativeHex = (await alchemyCall(url, headers, 'eth_getBalance', [address, 'latest'])) as string;
  balances.push({ asset: chain.asset, amount: hexToAmount(nativeHex, 18) });

  // Every ERC-20 the address currently holds, in ONE call.
  const tokenResult = (await alchemyCall(url, headers, 'alchemy_getTokenBalances', [address, 'erc20'])) as {
    tokenBalances?: { contractAddress?: string; tokenBalance?: string | null }[];
  };
  const held = (tokenResult?.tokenBalances ?? []).filter(
    (t) => t.contractAddress && t.tokenBalance && t.tokenBalance !== '0x0' && t.tokenBalance !== '0x'
  );

  const historySymbols = await txHistorySymbolMap(chain.id, address);
  let metadataLookups = 0;
  for (const tok of held.slice(0, MAX_TOKEN_METADATA_LOOKUPS)) {
    const contract = tok.contractAddress!;
    // Metadata (symbol + decimals) is required for an honest amount.
    // eslint-disable-next-line no-await-in-loop
    const meta = (await alchemyCall(url, headers, 'alchemy_getTokenMetadata', [contract]).catch(() => null)) as {
      symbol?: string;
      decimals?: number;
    } | null;
    metadataLookups++;
    const decimals = typeof meta?.decimals === 'number' ? meta.decimals : null;
    if (decimals == null) continue; // cannot compute an honest amount — skip
    const symbol =
      meta?.symbol?.trim() ||
      historySymbols.get(contract.toLowerCase()) ||
      `${contract.slice(0, 6)}…${contract.slice(-4)}`;
    balances.push({
      asset: symbol,
      contractAddress: contract,
      amount: hexToAmount(tok.tokenBalance, decimals)
    });
  }
  return balances;
}

// ─── Solana (Alchemy Solana RPC: getBalance + getTokenAccountsByOwner) ──────

async function fetchSolanaBalances(
  chain: ChainDef,
  address: string,
  alchemyKey: string
): Promise<FetchedBalance[]> {
  const url = alchemyRpcUrl(chain.alchemyNetwork ?? 'solana-mainnet');
  const headers = alchemyHeaders(alchemyKey);
  const balances: FetchedBalance[] = [];

  const lamports = (await alchemyCall(url, headers, 'getBalance', [address])) as { value?: number } | number;
  const lamportVal = typeof lamports === 'number' ? lamports : lamports?.value ?? 0;
  balances.push({ asset: chain.asset, amount: lamportVal / 1e9 });

  const tokenAccounts = (await alchemyCall(url, headers, 'getTokenAccountsByOwner', [
    address,
    { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
    { encoding: 'jsonParsed' }
  ])) as { value?: Array<{ account?: { data?: { parsed?: { info?: Record<string, unknown> } } } }> };

  const historySymbols = await txHistorySymbolMap(chain.id, address);
  for (const acct of tokenAccounts?.value ?? []) {
    const info = acct?.account?.data?.parsed?.info as
      | { tokenAmount?: { uiAmount?: number }; mint?: string }
      | undefined;
    if (!info?.mint) continue;
    const uiAmount = info.tokenAmount?.uiAmount ?? 0;
    if (uiAmount <= 0) continue;
    const mint = info.mint;
    const symbol =
      resolveSolanaMintSymbol(mint) ??
      historySymbols.get(mint.toLowerCase()) ??
      `${mint.slice(0, 4)}…${mint.slice(-4)}`;
    balances.push({ asset: symbol, contractAddress: mint, amount: uiAmount });
  }
  return balances;
}

// ─── Tx-history zero-fill (drains token phantoms on first refresh) ──────────

/**
 * Assets the address's stored tx history says it ever held, that a complete
 * successful fetch did NOT return → confirmed zero rows. NFT-ish entries are
 * excluded: the ERC-20/SPL balance calls say nothing about NFTs, so zeroing
 * them would be a lie. The chain's native asset is always covered by the
 * fetch itself.
 */
async function txHistoryZeroFill(
  chain: string,
  address: string,
  fetched: FetchedBalance[]
): Promise<FetchedBalance[]> {
  const lower = address.toLowerCase();
  const fetchedKeys = new Set(
    fetched.map((b) => (b.contractAddress ?? b.asset.toUpperCase()).toLowerCase())
  );
  const txs = await db.transactions
    .filter((t) => t.chain === chain && t.walletAddress?.toLowerCase() === lower && !t.isSpam)
    .toArray();
  const candidates = new Map<string, { asset: string; contractAddress?: string; nft: boolean }>();
  for (const t of txs) {
    const key = (t.contractAddress ?? t.asset.toUpperCase()).toLowerCase();
    if (fetchedKeys.has(key)) continue;
    const nft =
      t.category === 'nft' || t.type.startsWith('nft_') || t.asset.startsWith('NFT ');
    const existing = candidates.get(key);
    if (existing) {
      existing.nft = existing.nft && nft;
    } else {
      candidates.set(key, { asset: t.asset, contractAddress: t.contractAddress, nft });
    }
  }
  const zeros: FetchedBalance[] = [];
  for (const c of candidates.values()) {
    if (c.nft) continue;
    zeros.push({ asset: c.asset, contractAddress: c.contractAddress, amount: 0 });
    if (zeros.length >= MAX_ZERO_FILL) break;
  }
  return zeros;
}

// ─── Public ─────────────────────────────────────────────────────────────────

/** Fetch the current on-chain balances for one address on one chain. Throws on total failure. */
export async function fetchAddressBalances(
  chain: ChainDef,
  address: string,
  settings: TaxSettings
): Promise<FetchedBalance[]> {
  if (chain.provider === 'blockstream') {
    return fetchBitcoinBalance(address, chain.asset);
  }
  if (chain.provider === 'alchemy_evm') {
    const key = resolveAlchemyKey(settings);
    if (!key) throw new Error('Add your Alchemy API key in Settings to fetch balances.');
    return fetchEvmBalances(chain, address, key);
  }
  if (chain.provider === 'alchemy_solana') {
    const key = resolveAlchemyKey(settings);
    if (!key) throw new Error('Add your Alchemy API key in Settings to fetch balances.');
    return fetchSolanaBalances(chain, address, key);
  }
  throw new Error(`Balance fetch is not available for ${chain.label} yet.`);
}

/**
 * Refresh stored balances for explicit (chain, address) pairs. Per-address
 * isolated: one failure never affects the others, and prior stored balances
 * survive any failure. Zero-filled with tx-history-confirmed zeros on success.
 */
export async function refreshWalletBalancesForAddresses(
  entries: { chain: ChainDef; address: string }[],
  settings: TaxSettings
): Promise<BalanceRefreshOutcome> {
  const outcome: BalanceRefreshOutcome = { updated: 0, skipped: [], failed: [] };
  for (let i = 0; i < entries.length; i++) {
    const { chain, address } = entries[i];
    if (chain.provider !== 'blockstream' && chain.provider !== 'alchemy_evm' && chain.provider !== 'alchemy_solana') {
      outcome.skipped.push({ address, chain: chain.id, reason: 'no balance provider for this chain' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const fetched = await fetchAddressBalances(chain, address, settings);
      // eslint-disable-next-line no-await-in-loop
      const zeros = await txHistoryZeroFill(chain.id, address, fetched);
      // eslint-disable-next-line no-await-in-loop
      await replaceWalletBalances(chain.id, address, [...fetched, ...zeros], Date.now());
      outcome.updated++;
    } catch (err) {
      outcome.failed.push({
        address,
        message: err instanceof Error ? err.message : 'Balance fetch failed.'
      });
    }
    // eslint-disable-next-line no-await-in-loop
    if (i < entries.length - 1) await new Promise((r) => setTimeout(r, 250));
  }
  return outcome;
}

/** Refresh balances for every watched wallet address (detail view's Sync / post-sync hook). */
export async function refreshWalletBalances(settings: TaxSettings): Promise<BalanceRefreshOutcome> {
  const rows = await getLookupAddresses();
  const entries: { chain: ChainDef; address: string }[] = [];
  for (const row of rows) {
    const chain = CHAINS.find((c) => c.id === row.chain);
    if (chain) entries.push({ chain, address: row.address });
  }
  return refreshWalletBalancesForAddresses(entries, settings);
}
