/**
 * Global import job store — persists across React tab navigation because it
 * lives at module level, not inside a React component.
 *
 * When a user starts a wallet import and navigates to Review mid-way,
 * the async work continues and the progress state is preserved.
 * When they return to Import, the component re-subscribes and sees live state.
 */
import { db, getLookupAddresses, upsertLookupAddress, deduplicateTransactions } from '@/lib/storage/db';
import { lookupManyAddresses, type LookupConfig, type ChainDef } from '@/lib/rpc/providers';
import { reprocessSwapDetectionInDb, reprocessDbtIncome } from '@/lib/rpc/reprocessSwaps';
import { detectDcaGroups, applyDcaClassification } from '@/lib/rpc/dcaDetection';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import type { TaxSettings } from '@/types/transaction';

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

  let transactions: Awaited<ReturnType<typeof lookupManyAddresses>>['transactions'] = [];
  let perAddress: Awaited<ReturnType<typeof lookupManyAddresses>>['perAddress'] = [];
  let failed: Awaited<ReturnType<typeof lookupManyAddresses>>['failed'] = [];
  let apiWarnings: string[] = [...warnings];

  // For incremental sync: find the most recent transaction signature for each address.
  // Helius will return only transactions AFTER this signature — no duplicates.
  let syncConfig = config;
  if (isSync && fresh.length === 1) {
    const addr = fresh[0].toLowerCase();
    const existingTxs = await db.transactions
      .filter((t) => t.walletAddress?.toLowerCase() === addr && !!t.sourceRef && t.source.startsWith('rpc:'))
      .toArray();
    if (existingTxs.length > 0) {
      // Find the most recent transaction by timestamp, use its sourceRef as the cursor
      const mostRecent = existingTxs.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));
      if (mostRecent.sourceRef) {
        syncConfig = { ...config, afterSignature: mostRecent.sourceRef };
      }
    }
  }

  try {
    const result = await lookupManyAddresses(
      fresh,
      syncConfig,
      (done, total) => importJob._setProgress({ done, total })
    );
    transactions = result.transactions;
    perAddress = result.perAddress;
    failed = result.failed;
    apiWarnings = [...warnings, ...result.warnings.map((w) => `${w.address}: ${w.message}`)];
  } catch (err) {
    importJob._error(err instanceof Error ? err.message : 'Import failed.');
    return;
  }

  // --- Protect trades: don't overwrite Noves-classified transactions ---
  let txsToStore = transactions;
  if (transactions.length > 0) {
    const tradedSourceRefs = new Set(
      (await db.transactions.filter((t) => t.type === 'trade' && !!t.sourceRef).toArray()).map(
        (t) => t.sourceRef!
      )
    );
    txsToStore = transactions.filter(
      (t) => !t.sourceRef || !tradedSourceRefs.has(t.sourceRef)
    );
    await db.transactions.bulkPut(txsToStore);
  }

  await Promise.all(perAddress.map((p) => upsertLookupAddress(chain.id, p.address, p.count)));

  // --- Phase 2: Classification + DCA auto-detection ---
  importJob._setPhase('classifying');
  let swapsDetected = 0;

  if (txsToStore.length > 0) {
    // Phase 2a: Reclassify DBT income (always free, no API)
    await reprocessDbtIncome();

    // Phase 2b: Noves swap classification — ONLY for non-Helius/Moralis sources.
    // Helius and Moralis already return pre-classified transactions; calling Noves
    // again would be redundant and waste API credits.
    const hasRichSourceTxs = txsToStore.some(
      (t) => t.source === 'rpc:helius' || t.source === 'rpc:moralis'
    );
    const hasLegacyTxs = txsToStore.some(
      (t) => t.source.startsWith('rpc:') && t.source !== 'rpc:helius' && t.source !== 'rpc:moralis'
    );

    if (!hasRichSourceTxs || hasLegacyTxs) {
      // Only run Noves for Alchemy/Blockscout/Etherscan-sourced transactions
      const swapResult = await reprocessSwapDetectionInDb(
        settings.novesApiKey,
        (done, total) => importJob._setProgress({ done, total })
      );
      swapsDetected = swapResult.tradesCreated;
      if (swapResult.tradesCreated > 0 || swapResult.reclassified > 0) {
        apiWarnings.unshift(swapResult.message);
      }
    }

    // Phase 2c: DCA auto-classification (always run — works for Helius/Moralis AND legacy sources)
    // Re-reads the DB after Phase 2a/2b so newly classified income rows are available.
    importJob._setProgress({ done: 0, total: 1 });
    const allAfterClassification = await db.transactions.toArray();
    const dcaGroups = detectDcaGroups(allAfterClassification);
    if (dcaGroups.length > 0) {
      // Pass Alchemy key so exact DBT amounts are fetched on-chain per fill tx
      const dcaApplied = await applyDcaClassification(dcaGroups, settings.alchemyApiKey);
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
  if (settings.priceApiEnabled && txsToStore.length > 0) {
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

  importJob._finish(
    { imported: txsToStore.length, pricesUpdated, swapsDetected },
    apiWarnings,
    failed
  );
}
