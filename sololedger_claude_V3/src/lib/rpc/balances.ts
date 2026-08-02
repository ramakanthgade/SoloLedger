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
import {
  appendFailedWalletBalanceCoverage,
  commitWalletBalanceOperation,
  db,
  getLookupAddresses,
  reserveWalletBalanceOperation,
  type WalletBalanceOperationReservation
} from '@/lib/storage/db';
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
import type { EndpointCoverageOutcome } from '@/lib/reconcile/sourceCoverage';
import { assetKey as canonicalAssetKey } from '@/lib/ledger/assetKey';
import { canonicalWalletAddress } from '@/lib/ledger/chainNamespace';

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
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const MAX_ALCHEMY_TOKEN_PAGES = 100;

interface ProviderBalanceResult {
  balances: FetchedBalance[];
  endpointOutcomes: EndpointCoverageOutcome[];
  warnings: string[];
  status: 'complete' | 'partial' | 'failed';
  provider: string;
  operationName: string;
}

function walletEndpoint(chain: string, asset: string, operation: string): string {
  return `${chain}:wallet:${asset}:${operation}`;
}

function requestOutcome(
  endpoint: string,
  status: 'complete' | 'failed',
  warning?: string
): EndpointCoverageOutcome {
  return { endpoint, accountClass: 'wallet', required: true, status, warning };
}

function providerResult(
  balances: FetchedBalance[],
  endpointOutcomes: EndpointCoverageOutcome[],
  provider: string,
  operationName: string
): ProviderBalanceResult {
  const completeCount = endpointOutcomes.filter((outcome) => outcome.status === 'complete').length;
  const status = completeCount === endpointOutcomes.length
    ? 'complete' : completeCount === 0 ? 'failed' : 'partial';
  return {
    balances, endpointOutcomes, provider, operationName, status,
    warnings: endpointOutcomes.flatMap((outcome) => outcome.warning ? [outcome.warning] : [])
  };
}

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
  const chain = data?.chain_stats;
  const mempool = data?.mempool_stats;
  if (!chain || typeof chain !== 'object' || !mempool || typeof mempool !== 'object') {
    throw new Error('Explorer API returned a malformed address result.');
  }
  const values = [chain.funded_txo_sum, chain.spent_txo_sum, mempool.funded_txo_sum, mempool.spent_txo_sum];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    throw new Error('Explorer API returned malformed balance totals.');
  }
  const sats =
    (chain.funded_txo_sum - chain.spent_txo_sum) + (mempool.funded_txo_sum - mempool.spent_txo_sum);
  if (!Number.isFinite(sats) || sats < 0) throw new Error('Explorer API returned an invalid balance.');
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
  if (!data || typeof data !== 'object') throw new Error('Alchemy returned a malformed JSON-RPC response.');
  if (data.error) throw new Error(data.error.message ?? `Alchemy error ${data.error.code ?? ''}`.trim());
  if (!Object.prototype.hasOwnProperty.call(data, 'result') || data.result == null) {
    throw new Error(`Alchemy ${method} returned a missing result.`);
  }
  return data.result;
}

function hexToAmount(hex: unknown, decimals: number): number {
  if (typeof hex !== 'string' || !/^0x[0-9a-f]+$/i.test(hex) ||
    !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error('Provider returned a malformed hexadecimal balance.');
  }
  const amount = Number(BigInt(hex)) / 10 ** decimals;
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Provider returned a non-finite balance.');
  return amount;
}

/** contract → display symbol, from the app's own imported tx history. */
async function txHistorySymbolMap(chain: string, address: string): Promise<Map<string, string>> {
  const canonicalAddress = canonicalWalletAddress(chain, address);
  const map = new Map<string, string>();
  const txs = await db.transactions
    .filter((t) => t.chain === chain && t.walletAddress != null &&
      canonicalWalletAddress(chain, t.walletAddress) === canonicalAddress && !!t.contractAddress)
    .toArray();
  for (const t of txs) {
    const key = canonicalAssetKey({ asset: t.asset, chain, contractAddress: t.contractAddress });
    if (!map.has(key)) map.set(key, t.asset);
  }
  return map;
}

async function fetchBalanceOperation(
  chain: ChainDef,
  address: string,
  settings: TaxSettings
): Promise<ProviderBalanceResult> {
  if (chain.provider === 'blockstream') {
    const endpoint = walletEndpoint(chain.id, canonicalAssetKey({ asset: chain.asset, chain: chain.id }), 'address');
    try {
      const balances = await fetchBitcoinBalance(address, chain.asset);
      return providerResult(balances, [requestOutcome(endpoint, 'complete')], 'blockstream', 'GET /api/address/:address');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bitcoin balance request failed.';
      return providerResult([], [requestOutcome(endpoint, 'failed', message)], 'blockstream', 'GET /api/address/:address');
    }
  }

  const key = resolveAlchemyKey(settings);
  const provider = 'alchemy';
  if (!key) {
    const message = 'Add your Alchemy API key in Settings to fetch balances.';
    const operations = chain.provider === 'alchemy_solana'
      ? ['getBalance', `getTokenAccountsByOwner:${SPL_TOKEN_PROGRAM}`, `getTokenAccountsByOwner:${TOKEN_2022_PROGRAM}`]
      : ['eth_getBalance', 'alchemy_getTokenBalances'];
    return providerResult([], operations.map((operation) => requestOutcome(
      walletEndpoint(chain.id, operation.includes('Token') ? 'tokens' : 'native', operation), 'failed', message
    )), provider, operations.join('+'));
  }

  const url = alchemyRpcUrl(chain.alchemyNetwork ?? (chain.provider === 'alchemy_solana' ? 'solana-mainnet' : ''));
  const headers = alchemyHeaders(key);
  const balances: FetchedBalance[] = [];
  const outcomes: EndpointCoverageOutcome[] = [];

  if (chain.provider === 'alchemy_solana') {
    const nativeEndpoint = walletEndpoint(chain.id, canonicalAssetKey({ asset: chain.asset, chain: chain.id }), 'getBalance');
    try {
      const lamports = await alchemyCall(url, headers, 'getBalance', [address]);
      if (!lamports || typeof lamports !== 'object' ||
        typeof (lamports as { value?: unknown }).value !== 'number' ||
        !Number.isSafeInteger((lamports as { value: number }).value) || (lamports as { value: number }).value < 0) {
        throw new Error('getBalance returned a malformed lamport value.');
      }
      const value = (lamports as { value: number }).value;
      balances.push({ asset: chain.asset, amount: value / 1e9 });
      outcomes.push(requestOutcome(nativeEndpoint, 'complete'));
    } catch (error) {
      outcomes.push(requestOutcome(nativeEndpoint, 'failed', error instanceof Error ? error.message : 'getBalance failed'));
    }

    const byMint = new Map<string, number>();
    for (const programId of [SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
      const tokenEndpoint = walletEndpoint(chain.id, 'tokens', `getTokenAccountsByOwner:${programId}`);
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await alchemyCall(url, headers, 'getTokenAccountsByOwner', [
          address, { programId }, { encoding: 'jsonParsed' }
        ]);
        if (!result || typeof result !== 'object' || !Array.isArray((result as { value?: unknown }).value)) {
          throw new Error('getTokenAccountsByOwner returned a malformed account list.');
        }
        const programBalances = new Map<string, number>();
        for (const account of (result as { value: unknown[] }).value) {
          const info = (account as { account?: { data?: { parsed?: { info?: unknown } } } })
            ?.account?.data?.parsed?.info as { tokenAmount?: { uiAmount?: unknown }; mint?: unknown } | undefined;
          const amount = info?.tokenAmount?.uiAmount;
          if (typeof info?.mint !== 'string' || !info.mint.trim() || typeof amount !== 'number' ||
            !Number.isFinite(amount) || amount < 0) {
            throw new Error('getTokenAccountsByOwner returned malformed parsed token data.');
          }
          const programAmount = (programBalances.get(info.mint) ?? 0) + amount;
          if (!Number.isFinite(programAmount)) throw new Error('Token account totals are non-finite.');
          programBalances.set(info.mint, programAmount);
        }
        for (const [mint, amount] of programBalances) {
          const total = (byMint.get(mint) ?? 0) + amount;
          if (!Number.isFinite(total)) throw new Error('Aggregated token totals are non-finite.');
          byMint.set(mint, total);
        }
        outcomes.push(requestOutcome(tokenEndpoint, 'complete'));
      } catch (error) {
        outcomes.push(requestOutcome(tokenEndpoint, 'failed',
          error instanceof Error ? error.message : 'token accounts request failed'));
      }
    }
    const historySymbols = await txHistorySymbolMap(chain.id, address);
    for (const [mint, amount] of byMint) {
      if (amount === 0) continue;
      const key = canonicalAssetKey({ asset: 'TOKEN', chain: chain.id, contractAddress: mint });
      balances.push({
        asset: resolveSolanaMintSymbol(mint) ?? historySymbols.get(key) ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
        contractAddress: mint,
        amount
      });
    }
    return providerResult(balances, outcomes, provider,
      'getBalance+getTokenAccountsByOwner(SPL)+getTokenAccountsByOwner(Token-2022)');
  }

  const nativeEndpoint = walletEndpoint(chain.id, canonicalAssetKey({ asset: chain.asset, chain: chain.id }), 'eth_getBalance');
  try {
    const nativeHex = (await alchemyCall(url, headers, 'eth_getBalance', [address, 'latest'])) as string;
    balances.push({ asset: chain.asset, amount: hexToAmount(nativeHex, 18) });
    outcomes.push(requestOutcome(nativeEndpoint, 'complete'));
  } catch (error) {
    outcomes.push(requestOutcome(nativeEndpoint, 'failed', error instanceof Error ? error.message : 'native balance request failed'));
  }

  const tokenEndpoint = walletEndpoint(chain.id, 'tokens', 'alchemy_getTokenBalances');
  const tokenRows: Array<{ contractAddress: string; tokenBalance: string }> = [];
  let pageKey: string | undefined;
  let pages = 0;
  let paginationRequired = false;
  let tokenPageError: string | undefined;
  do {
    try {
      if (pages >= MAX_ALCHEMY_TOKEN_PAGES) {
        throw new Error(`alchemy_getTokenBalances exceeded the ${MAX_ALCHEMY_TOKEN_PAGES}-page safety limit.`);
      }
      const params: unknown[] = [address, 'erc20'];
      if (pageKey) params.push({ pageKey });
      // eslint-disable-next-line no-await-in-loop
      const tokenResult = await alchemyCall(url, headers, 'alchemy_getTokenBalances', params);
      if (!tokenResult || typeof tokenResult !== 'object' ||
        !Array.isArray((tokenResult as { tokenBalances?: unknown }).tokenBalances)) {
        throw new Error('alchemy_getTokenBalances returned a malformed token list.');
      }
      const pageRows = (tokenResult as { tokenBalances: unknown[] }).tokenBalances.map((value) => {
      const token = value as { contractAddress?: unknown; tokenBalance?: unknown };
      if (typeof token.contractAddress !== 'string' || !/^0x[0-9a-f]{40}$/i.test(token.contractAddress) ||
        typeof token.tokenBalance !== 'string' || !/^0x[0-9a-f]+$/i.test(token.tokenBalance)) {
        throw new Error('alchemy_getTokenBalances returned a malformed token balance.');
      }
      return { contractAddress: token.contractAddress, tokenBalance: token.tokenBalance };
      });
      tokenRows.push(...pageRows);
      pages++;
      const next = (tokenResult as { pageKey?: unknown }).pageKey;
      if (next != null && (typeof next !== 'string' || !next.trim())) {
        throw new Error('alchemy_getTokenBalances returned a malformed pageKey.');
      }
      pageKey = typeof next === 'string' ? next : undefined;
      if (pageKey) paginationRequired = true;
    } catch (error) {
      tokenPageError = error instanceof Error ? error.message : 'token balance page failed';
      break;
    }
  } while (pageKey);
  outcomes.push({
    ...requestOutcome(tokenEndpoint, tokenPageError ? 'failed' : 'complete', tokenPageError),
    paginationRequired,
    paginationExhausted: !tokenPageError && pageKey == null,
    pages
  });

  try {
    const held = [...new Map(tokenRows
      .filter((token) => BigInt(token.tokenBalance) > 0n)
      .map((token) => [token.contractAddress.toLowerCase(), token])).values()];
    const historySymbols = await txHistorySymbolMap(chain.id, address);
    for (const token of held.slice(0, MAX_TOKEN_METADATA_LOOKUPS)) {
      const contract = token.contractAddress!;
      const identity = canonicalAssetKey({ asset: 'TOKEN', chain: chain.id, contractAddress: contract });
      const metadataEndpoint = walletEndpoint(chain.id, identity, 'alchemy_getTokenMetadata');
      try {
        // eslint-disable-next-line no-await-in-loop
        const metadata = await alchemyCall(url, headers, 'alchemy_getTokenMetadata', [contract]);
        if (!metadata || typeof metadata !== 'object' ||
          !Number.isSafeInteger((metadata as { decimals?: unknown }).decimals) ||
          (metadata as { decimals: number }).decimals < 0 || (metadata as { decimals: number }).decimals > 255 ||
          ((metadata as { symbol?: unknown }).symbol != null && typeof (metadata as { symbol?: unknown }).symbol !== 'string')) {
          throw new Error('Token metadata is malformed or omitted decimals.');
        }
        const typedMetadata = metadata as { symbol?: string; decimals: number };
        balances.push({
          asset: typedMetadata.symbol?.trim() || historySymbols.get(identity) ||
            `${contract.slice(0, 6)}…${contract.slice(-4)}`,
          contractAddress: contract,
          amount: hexToAmount(token.tokenBalance, typedMetadata.decimals)
        });
        outcomes.push(requestOutcome(metadataEndpoint, 'complete'));
      } catch (error) {
        outcomes.push(requestOutcome(metadataEndpoint, 'failed', error instanceof Error ? error.message : 'token metadata request failed'));
      }
    }
    if (held.length > MAX_TOKEN_METADATA_LOOKUPS) {
      outcomes.push(requestOutcome(walletEndpoint(chain.id, 'tokens', 'metadata-limit'), 'failed',
        `Token metadata request limit exceeded (${held.length}).`));
    }
  } catch (error) {
    outcomes.push(requestOutcome(walletEndpoint(chain.id, 'tokens', 'token-processing'), 'failed',
      error instanceof Error ? error.message : 'token balance processing failed'));
  }
  return providerResult(balances, outcomes, provider, 'eth_getBalance+alchemy_getTokenBalances+alchemy_getTokenMetadata');
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
  const canonicalAddress = canonicalWalletAddress(chain, address);
  const fetchedKeys = new Set(
    fetched.map((balance) => canonicalAssetKey({
      asset: balance.asset, chain, contractAddress: balance.contractAddress
    }))
  );
  const txs = await db.transactions
    .filter((t) => t.chain === chain && t.walletAddress != null &&
      canonicalWalletAddress(chain, t.walletAddress) === canonicalAddress && !t.isSpam)
    .toArray();
  const candidates = new Map<string, { asset: string; contractAddress?: string; nft: boolean }>();
  for (const t of txs) {
    const key = canonicalAssetKey({ asset: t.asset, chain, contractAddress: t.contractAddress });
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
  if (chain.provider !== 'blockstream' && chain.provider !== 'alchemy_evm' && chain.provider !== 'alchemy_solana') {
    throw new Error(`Balance fetch is not available for ${chain.label} yet.`);
  }
  const result = await fetchBalanceOperation(chain, address, settings);
  if (result.status !== 'complete') throw new Error(result.warnings[0] ?? 'Balance provider result was incomplete.');
  return result.balances;
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
    let reservation: WalletBalanceOperationReservation | undefined;
    let endpointOutcomes: EndpointCoverageOutcome[] = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      reservation = await reserveWalletBalanceOperation(chain.id, address);
      // eslint-disable-next-line no-await-in-loop
      const result = await fetchBalanceOperation(chain, address, settings);
      endpointOutcomes = result.endpointOutcomes;
      const capturedAt = Date.now();
      if (result.status === 'failed') {
        const message = result.warnings[0] ?? 'Balance fetch failed.';
        // eslint-disable-next-line no-await-in-loop
        await appendFailedWalletBalanceCoverage({
          operation: reservation,
          endpointOutcomes,
          completedAt: capturedAt,
          failureKind: 'provider',
          message
        });
        outcome.failed.push({ address, message });
      } else {
        // Absence proves zero only when every configured provider request
        // succeeded in this same generation.
        // eslint-disable-next-line no-await-in-loop
        const zeros = result.status === 'complete'
          ? await txHistoryZeroFill(chain.id, address, result.balances) : [];
        // eslint-disable-next-line no-await-in-loop
        const committed = await commitWalletBalanceOperation({
          operation: reservation,
          rows: [...result.balances, ...zeros],
          provider: result.provider,
          operationName: result.operationName,
          endpointOutcomes,
          status: result.status,
          asOf: capturedAt,
          capturedAt,
          warnings: result.warnings
        });
        if (!committed) throw new Error('Wallet changed after this refresh started — refresh again.');
        outcome.updated++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Balance fetch failed.';
      if (reservation) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await appendFailedWalletBalanceCoverage({
            operation: reservation,
            endpointOutcomes,
            completedAt: Date.now(),
            failureKind: 'operation',
            message
          });
        } catch {
          // Preserve the provider/operation failure when evidence persistence is unavailable.
        }
      }
      if (!outcome.failed.some((failure) => failure.address === address && failure.message === message)) {
        outcome.failed.push({ address, message });
      }
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
