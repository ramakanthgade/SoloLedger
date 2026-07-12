/**
 * Global import job store — persists across React tab navigation because it
 * lives at module level, not inside a React component.
 *
 * When a user starts a wallet import and navigates to Review mid-way,
 * the async work continues and the progress state is preserved.
 * When they return to Import, the component re-subscribes and sees live state.
 */
import { db, getLookupAddresses, upsertLookupAddress, deduplicateTransactions, filterAlreadyImported } from '@/lib/storage/db';
import { lookupManyAddresses, type LookupConfig, type ChainDef } from '@/lib/rpc/providers';
import { reprocessSwapDetectionInDb, reprocessDbtIncome } from '@/lib/rpc/reprocessSwaps';
import { isAbsorbedTradeLeg } from '@/lib/rpc/swapDetection';
import { detectDcaGroups, applyDcaClassification } from '@/lib/rpc/dcaDetection';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import type { TaxSettings } from '@/types/transaction';
import { recordNetworkActivity } from '@/lib/networkActivity';
import { isSaasMode } from '@/lib/saas/config';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';

// ---- State shape ----

export type ImportPhase = 'idle' | 'importing' | 'classifying' | 'pricing';

export interface ImportJobState {
  active: boolean;
  phase: ImportPhase;
  progress: { done: number; total: number } | null;
  chainLabel: string;
  addresses: string[];
  result: {
    imported: number;
    pricesUpdated: number;
    swapsDetected: number;
  } | null;
  warnings: string[];
  failed: { address: string; message: string }[];
  error: string | null;
}

const IDLE: ImportJobState = {
  active: false,
  phase: 'idle',
  progress: null,
  chainLabel: '',
  addresses: [],
  result: null,
  warnings: [],
  failed: [],
  error: null
};

// ---- Store ----

type Listener = (state: ImportJobState) => void;

class ImportJobStore {
  private state: ImportJobState = { ...IDLE };
  private listeners = new Set<Listener>();

  get(): ImportJobState {
    return this.state;
  }

  private patch(update: Partial<ImportJobState>) {
    this.state = { ...this.state, ...update };
    for (const l of this.listeners) l(this.state);
  }

  reset() {
    this.patch({ ...IDLE });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Internal helpers used only by runWalletImport below.
  _setPhase(phase: ImportPhase, progress: ImportJobState['progress'] = null) {
    this.patch({ phase, progress, active: true });
  }
  _setProgress(progress: ImportJobState['progress']) {
    this.patch({ progress });
  }
  _finish(result: ImportJobState['result'], warnings: string[], failed: ImportJobState['failed']) {
    this.patch({ active: false, phase: 'idle', progress: null, result, warnings, failed, error: null });
  }
  _error(msg: string) {
    this.patch({ active: false, phase: 'idle', progress: null, error: msg });
  }
}

export const importJob = new ImportJobStore();

// ---- React hook ----

import { useEffect, useState } from 'react';

export function useImportJob(): ImportJobState {
  const [state, setState] = useState<ImportJobState>(() => importJob.get());
  useEffect(() => importJob.subscribe(setState), []);
  return state;
}

// ---- Main import function (runs independently of any React component) ----

/** Resolve the Helius after-signature cursor for incremental sync. */
async function resolveSyncCursor(chainId: string, address: string): Promise<string | undefined> {
  const row = await db.lookupAddresses.get(`${chainId}:${address}`);
  if (row?.lastSyncedSignature) return row.lastSyncedSignature;

  const existingTxs = await db.transactions
    .filter(
      (t) =>
        t.walletAddress?.toLowerCase() === address.toLowerCase() &&
        !!t.sourceRef &&
        t.source.startsWith('rpc:')
    )
    .toArray();
  if (existingTxs.length === 0) return undefined;

  const newestBySig = new Map<string, number>();
  for (const t of existingTxs) {
    const prev = newestBySig.get(t.sourceRef!) ?? 0;
    if (t.timestamp > prev) newestBySig.set(t.sourceRef!, t.timestamp);
  }
  let bestSig: string | undefined;
  let bestTs = 0;
  for (const [sig, ts] of newestBySig) {
    if (ts > bestTs) {
      bestTs = ts;
      bestSig = sig;
    }
  }
  return bestSig;
}

export async function runWalletImport(
  addresses: string[],
  chain: ChainDef,
  settings: TaxSettings,
  config: LookupConfig,
  /**
   * Set to true when syncing an existing wallet.
   * Uses incremental fetch (after-signature) to get only NEW transactions
   * since the last import — avoids duplicating existing rows.
   */
  isSync = false
): Promise<void> {
  const existing = await getLookupAddresses();
  const existingIds = new Set(existing.map((r) => `${r.chain}:${r.address.toLowerCase()}`));

  let fresh: string[];
  const warnings: string[] = [];

  if (isSync) {
    // Sync: fetch ONLY new transactions since the last known one.
    // Find the most recent transaction signature for each address.
    fresh = addresses;
  } else {
    const alreadyKnown = addresses.filter((a) => existingIds.has(`${chain.id}:${a.toLowerCase()}`));
    fresh = addresses.filter((a) => !existingIds.has(`${chain.id}:${a.toLowerCase()}`));
    for (const a of alreadyKnown) {
      warnings.push(`${a.slice(0, 8)}…${a.slice(-4)}: already imported — use Sync to refresh.`);
    }
    if (fresh.length === 0) {
      importJob._finish({ imported: 0, pricesUpdated: 0, swapsDetected: 0 }, warnings, []);
      return;
    }
  }

  // --- Phase 1: Import from RPC ---
  importJob._setPhase('importing');
  recordNetworkActivity();

  let transactions: Awaited<ReturnType<typeof lookupManyAddresses>>['transactions'] = [];
  let failed: Awaited<ReturnType<typeof lookupManyAddresses>>['failed'] = [];
  let apiWarnings: string[] = [...warnings];

  // For incremental sync: use stored cursor so Helius returns only NEW txs.
  let syncConfig: LookupConfig = config;
  if (isSync && fresh.length === 1) {
    const addr = fresh[0];
    const afterSignature = await resolveSyncCursor(chain.id, addr);
    const existingTxs = await db.transactions
      .filter(
        (t) =>
          t.walletAddress?.toLowerCase() === addr.toLowerCase() &&
          !!t.sourceRef &&
          t.source.startsWith('rpc:')
      )
      .toArray();
    const skipSignatures = new Set(
      existingTxs.map((t) => t.sourceRef!).filter(Boolean)
    );
    syncConfig = {
      ...config,
      afterSignature,
      incrementalOnly: true,
      skipSignatures
    };
  }

  try {
    const result = await lookupManyAddresses(
      fresh,
      syncConfig,
      (done, total) => importJob._setProgress({ done, total })
    );
    transactions = result.transactions;
    failed = result.failed;
    apiWarnings = [
      ...warnings,
      ...(isSync && syncConfig.afterSignature
        ? [`Syncing new transactions after ${syncConfig.afterSignature.slice(0, 8)}…`]
        : []),
      ...result.warnings.map((w) => `${w.address}: ${w.message}`)
    ];
  } catch (err) {
    importJob._error(err instanceof Error ? err.message : 'Import failed.');
    return;
  }

  // --- Protect trades + skip rows already in DB ---
  let txsToStore = transactions;
  let newlyStored = 0;
  if (transactions.length > 0) {
    const existingTrades = await db.transactions
      .filter((t) => t.type === 'trade' && !!t.sourceRef)
      .toArray();
    const tradeBySourceRef = new Map(
      existingTrades.map((t) => [t.sourceRef!, t] as const)
    );
    txsToStore = transactions.filter((t) => {
      if (!t.sourceRef) return true;
      const trade = tradeBySourceRef.get(t.sourceRef);
      if (!trade) return true;
      if (t.type === 'fee' || t.type === 'income') return true;
      if (t.type === 'trade') return false;
      if (
        (t.type === 'transfer_in' || t.type === 'transfer_out') &&
        isAbsorbedTradeLeg(t, trade)
      ) {
        return false;
      }
      return true;
    });
    txsToStore = await filterAlreadyImported(txsToStore);
    newlyStored = txsToStore.length;
    if (txsToStore.length > 0) {
      await db.transactions.bulkPut(txsToStore);
    }
  }

  await Promise.all(
    fresh.map((addr) => upsertLookupAddress(chain.id, addr, newlyStored))
  );

  // --- Phase 2: Classification + DCA auto-detection ---
  importJob._setPhase('classifying');
  let swapsDetected = 0;

  if (txsToStore.length > 0) {
    // Phase 2a: Reclassify DBT income (always free, no API)
    await reprocessDbtIncome();

    // Phase 2b: Local swap merge (always) + optional Noves for legacy sources.
    const swapResult = await reprocessSwapDetectionInDb(
      settings.novesApiKey,
      (done, total) => importJob._setProgress({ done, total })
    );
    swapsDetected = swapResult.tradesCreated;
    if (swapResult.tradesCreated > 0 || swapResult.reclassified > 0) {
      apiWarnings.unshift(swapResult.message);
    }

    // Phase 2c: DCA auto-classification (always run — works for Helius/Moralis AND legacy sources)
    // Re-reads the DB after Phase 2a/2b so newly classified income rows are available.
    importJob._setProgress({ done: 0, total: 1 });
    const allAfterClassification = await db.transactions.toArray();
    const dcaGroups = detectDcaGroups(allAfterClassification);
    if (dcaGroups.length > 0) {
      // Pass Alchemy key so exact DBT amounts are fetched on-chain per fill tx
      const dcaApplied = await applyDcaClassification(
        dcaGroups,
        settings.alchemyApiKey ?? (isSaasMode() ? SAAS_PROXY_KEY : undefined)
      );
      swapsDetected += dcaApplied;
      if (dcaApplied > 0) {
        apiWarnings.unshift(
          `Auto-classified ${dcaApplied} DCA order${dcaApplied === 1 ? '' : 's'}: ` +
            `deposit marked non-taxable, fills classified as trades. Fetch prices to calculate P&L.`
        );
      }
    }
    importJob._setProgress(null);
  }

  // --- Phase 3: Auto price fetch ---
  importJob._setPhase('pricing');
  let pricesUpdated = 0;
  if (txsToStore.length > 0) {
    const priceResult = await fetchMissingPricesForAllTransactions(
      settings,
      (done, total) => importJob._setProgress({ done, total })
    );
    pricesUpdated = priceResult.updated;
    if (priceResult.updated > 0) {
      apiWarnings.unshift(
        `Fetched prices for ${priceResult.updated} transaction${priceResult.updated === 1 ? '' : 's'}.` +
          (priceResult.failed > 0 ? ` ${priceResult.failed} could not be priced.` : '')
      );
    }
  }

  // Dedup after every import in case wallet was synced before
  const dupsRemoved = await deduplicateTransactions();
  if (dupsRemoved > 0) {
    apiWarnings.unshift(`Removed ${dupsRemoved} duplicate transaction${dupsRemoved === 1 ? '' : 's'} (re-sync detected).`);
  }

  // Refresh wallet tx counts + sync cursor after dedup
  await Promise.all(fresh.map((addr) => upsertLookupAddress(chain.id, addr, newlyStored)));

  if (isSync && newlyStored === 0) {
    apiWarnings.unshift('No new transactions found since last sync.');
  }

  importJob._finish(
    { imported: newlyStored, pricesUpdated, swapsDetected },
    apiWarnings,
    failed
  );
}
