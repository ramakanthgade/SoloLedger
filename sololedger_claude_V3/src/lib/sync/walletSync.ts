import { db, getLookupAddress, upsertLookupAddress, countWalletTransactions, type LookupAddressRow } from '@/lib/storage/db';
import { CHAINS, type ChainId, type LookupConfig } from '@/lib/rpc/providers';
import { syncSolanaWallet } from '@/lib/rpc/solanaSync';
import { syncEvmWallet } from '@/lib/rpc/evmSync';
import { syncBitcoinWallet } from '@/lib/rpc/bitcoinSync';
import { withStableRpcIds, dedupeTransactions } from '@/lib/sync/dedupe';
import { applyMissingPrices } from '@/lib/pricing/fetchMissingPrices';
import type { TaxSettings, Transaction } from '@/types/transaction';
import { fetchEtherscanCompatible } from '@/lib/rpc/etherscanSync';

export type SyncMode = 'incremental' | 'full';

export interface SyncProgress {
  phase: 'fetching' | 'pricing' | 'done';
  address: string;
  detail?: string;
  addressesDone?: number;
  addressesTotal?: number;
}

export interface SyncWalletResult {
  address: string;
  imported: number;
  priced: number;
  signaturesOrTxsFetched?: number;
  warnings: string[];
  error?: string;
}

export interface SyncBatchResult {
  results: SyncWalletResult[];
  totalImported: number;
  totalPriced: number;
}

async function getKnownEvmHashes(chain: string, address: string): Promise<Set<string>> {
  const rows = await db.transactions.filter((t) => t.walletAddress === address && t.chain === chain).toArray();
  const hashes = new Set<string>();
  for (const t of rows) {
    if (t.sourceRef) hashes.add(t.sourceRef);
  }
  return hashes;
}

export async function syncWalletAddress(params: {
  chainId: ChainId;
  address: string;
  mode: SyncMode;
  settings: TaxSettings;
  config?: Partial<LookupConfig>;
  onProgress?: (progress: SyncProgress) => void;
}): Promise<SyncWalletResult> {
  const { chainId, address, mode, settings, config, onProgress } = params;
  const chain = CHAINS.find((c) => c.id === chainId);
  if (!chain) return { address, imported: 0, priced: 0, warnings: [], error: 'Unknown chain.' };

  const existing = await getLookupAddress(chainId, address);
  const warnings: string[] = [];

  try {
    onProgress?.({ phase: 'fetching', address, detail: mode === 'full' ? 'Fetching full history…' : 'Checking for new transactions…' });

    let transactions: Transaction[] = [];
    let newestCursor: string | undefined;
    let signaturesOrTxsFetched: number | undefined;

    if (chain.provider === 'blockstream') {
      const result = await syncBitcoinWallet(address, chain.asset, {
        mode,
        untilCursor: mode === 'incremental' ? existing?.newestCursor : undefined,
        onProgress: (n) => onProgress?.({ phase: 'fetching', address, detail: `${n} Bitcoin txs processed` })
      });
      transactions = result.transactions;
      newestCursor = result.newestCursor;
      signaturesOrTxsFetched = transactions.length;
    } else if (chain.provider === 'alchemy_solana') {
      if (!settings.alchemyApiKey) throw new Error('Add your Alchemy API key in Settings first.');
      const result = await syncSolanaWallet(address, settings.alchemyApiKey, {
        mode,
        untilCursor: mode === 'incremental' ? existing?.newestCursor : undefined,
        onProgress: (n) => onProgress?.({ phase: 'fetching', address, detail: `${n} Solana signatures processed` })
      });
      transactions = result.transactions;
      newestCursor = result.newestCursor ?? existing?.newestCursor;
      signaturesOrTxsFetched = result.signaturesFetched;
    } else if (chain.provider === 'alchemy_evm') {
      if (!settings.alchemyApiKey) throw new Error('Add your Alchemy API key in Settings first.');
      const knownHashes = mode === 'incremental' ? await getKnownEvmHashes(chainId, address) : undefined;
      const result = await syncEvmWallet(
        address,
        chain.alchemyNetwork!,
        settings.alchemyApiKey,
        chain.asset,
        chainId,
        {
          mode,
          knownHashes,
          onProgress: (n) => onProgress?.({ phase: 'fetching', address, detail: `${n} EVM transfers processed` })
        }
      );
      transactions = result.transactions;
      newestCursor = result.newestCursor ?? existing?.newestCursor;
    } else if (chain.provider === 'etherscan_compatible') {
      const baseUrl = config?.customBaseUrl ?? settings.customExplorerBaseUrl;
      if (!baseUrl) throw new Error('Enter an explorer base URL.');
      const result = await fetchEtherscanCompatible(
        address,
        baseUrl,
        config?.customApiKey ?? settings.customExplorerApiKey ?? '',
        config?.customAsset ?? 'TOKEN'
      );
      transactions = result.transactions;
      warnings.push(...result.warnings.map((w) => w.message));
    }

    const stable = dedupeTransactions(withStableRpcIds(transactions));
    if (stable.length > 0) await db.transactions.bulkPut(stable);

    const totalCount = await countWalletTransactions(chainId, address);
    await upsertLookupAddress(chainId, address, {
      txCount: totalCount,
      newestCursor: newestCursor ?? existing?.newestCursor,
      fullHistoryComplete: mode === 'full' ? true : existing?.fullHistoryComplete
    });

    let priced = 0;
    if (settings.priceApiEnabled && settings.autoPriceOnSync && stable.length > 0) {
      onProgress?.({ phase: 'pricing', address, detail: 'Fetching prices…' });
      await new Promise((r) => setTimeout(r, 1000));
      const priceResult = await applyMissingPrices(stable, settings);
      priced = priceResult.priced;
      warnings.push(...priceResult.errors);
    }

    onProgress?.({ phase: 'done', address });

    return {
      address,
      imported: stable.length,
      priced,
      signaturesOrTxsFetched,
      warnings
    };
  } catch (err) {
    return {
      address,
      imported: 0,
      priced: 0,
      warnings,
      error: err instanceof Error ? err.message : 'Sync failed.'
    };
  }
}

export async function syncWalletAddresses(params: {
  chainId: ChainId;
  addresses: string[];
  mode: SyncMode;
  settings: TaxSettings;
  config?: Partial<LookupConfig>;
  onProgress?: (progress: SyncProgress) => void;
}): Promise<SyncBatchResult> {
  const results: SyncWalletResult[] = [];
  let totalImported = 0;
  let totalPriced = 0;

  for (let i = 0; i < params.addresses.length; i++) {
    const address = params.addresses[i].trim();
    if (!address) continue;

    const result = await syncWalletAddress({
      chainId: params.chainId,
      address,
      mode: params.mode,
      settings: params.settings,
      config: params.config,
      onProgress: (p) =>
        params.onProgress?.({
          ...p,
          addressesDone: i,
          addressesTotal: params.addresses.length
        })
    });

    results.push(result);
    totalImported += result.imported;
    totalPriced += result.priced;

    if (i < params.addresses.length - 1) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  return { results, totalImported, totalPriced };
}

/** Incremental sync for every saved wallet — intended to run when the app opens. */
export async function syncAllSavedWalletsOnOpen(
  settings: TaxSettings,
  onProgress?: (progress: SyncProgress) => void
): Promise<SyncBatchResult | null> {
  if (!settings.rpcLookupEnabled || !settings.syncOnOpen) return null;

  const { getLookupAddresses } = await import('@/lib/storage/db');
  const saved: LookupAddressRow[] = await getLookupAddresses();
  if (saved.length === 0) return null;

  const results: SyncWalletResult[] = [];
  let totalImported = 0;
  let totalPriced = 0;

  for (let i = 0; i < saved.length; i++) {
    const row = saved[i];
    const result = await syncWalletAddress({
      chainId: row.chain as ChainId,
      address: row.address,
      mode: 'incremental',
      settings,
      onProgress: (p) =>
        onProgress?.({
          ...p,
          addressesDone: i + 1,
          addressesTotal: saved.length
        })
    });
    results.push(result);
    totalImported += result.imported;
    totalPriced += result.priced;
    if (i < saved.length - 1) await new Promise((r) => setTimeout(r, 300));
  }

  return { results, totalImported, totalPriced };
}
