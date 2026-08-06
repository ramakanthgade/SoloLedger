/**
 * Global import job store — persists across React tab navigation because it
 * lives at module level, not inside a React component.
 *
 * When a user starts a wallet import and navigates to Review mid-way,
 * the async work continues and the progress state is preserved.
 * When they return to Import, the component re-subscribes and sees live state.
 */
import {
  appendFailedWalletBalanceCoverage,
  db,
  getLookupAddresses,
  upsertLookupAddress,
  deduplicateTransactions,
  resolvePostDedupTransferSurvivorIds,
  filterAlreadyImported,
  reserveWalletBalanceOperation
} from '@/lib/storage/db';
import { lookupManyAddresses, type LookupConfig, type ChainDef, type ProviderStreamOutcome } from '@/lib/rpc/providers';
import { refreshWalletBalancesForAddresses } from '@/lib/rpc/balances';
import { refreshEthereumPositionAuthority } from '@/lib/defi/positionAuthority';
import { reprocessSwapDetectionInDb, reprocessRewardIncome } from '@/lib/rpc/reprocessSwaps';
import { applyDefiLlamaRewardSuggestions } from '@/lib/rpc/rewardSuggestions';
import { isAbsorbedTradeLeg } from '@/lib/rpc/swapDetection';
import { detectDcaGroups, applyDcaClassification } from '@/lib/rpc/dcaDetection';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import type { TaxSettings } from '@/types/transaction';
import { isSaasMode } from '@/lib/saas/config';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import { canonicalWalletAddress, canonicalWalletSourceRefKey } from '@/lib/ledger/chainNamespace';
import type { EndpointCoverageOutcome } from '@/lib/reconcile/sourceCoverage';
import { materializeImportedTransactionSafety } from '@/lib/safety/assetSafety';
import { runInternalTransferMatching } from '@/lib/internalTransfers/persistence';
import { applyClassificationEvidence } from '@/lib/taxonomy/classification';

// ---- State shape ----

export type ImportPhase = 'idle' | 'importing' | 'classifying' | 'pricing';

export interface ImportJobState {
  active: boolean;
  /** True for the full outer multi-chain batch, including between-chain gaps. */
  batchActive?: boolean;
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
  batchActive: false,
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
export type ImportOperationToken = symbol;

class ImportJobStore {
  private state: ImportJobState = { ...IDLE };
  private listeners = new Set<Listener>();
  private operations: ImportOperationToken[] = [];
  private operationWaiters = new Map<ImportOperationToken, {
    promise: Promise<void>;
    resolve: () => void;
  }>();

  get(): ImportJobState {
    return this.state;
  }

  private patch(update: Partial<ImportJobState>) {
    this.state = { ...this.state, ...update };
    for (const l of this.listeners) l(this.state);
  }

  reset() {
    const active = this.operations.length > 0;
    this.patch({ ...IDLE, active, batchActive: active });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Internal helpers used only by runWalletImport below.
  _setPhase(phase: ImportPhase, progress: ImportJobState['progress'] = null) {
    this.patch({ phase, progress, active: true });
  }
  _beginBatch(): ImportOperationToken {
    const token = Symbol('wallet-import-operation');
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.operationWaiters.set(token, { promise, resolve });
    this.operations.push(token);
    if (this.operations.length === 1) resolve();
    this.patch({ batchActive: true, active: true });
    return token;
  }
  _waitForBatch(token: ImportOperationToken): Promise<void> {
    return this.operationWaiters.get(token)?.promise ?? Promise.resolve();
  }
  _endBatch(token: ImportOperationToken) {
    const index = this.operations.indexOf(token);
    if (index === -1) return;
    const wasOwner = index === 0;
    this.operations.splice(index, 1);
    this.operationWaiters.delete(token);
    if (wasOwner) this.operationWaiters.get(this.operations[0])?.resolve();
    const batchActive = this.operations.length > 0;
    this.patch({ batchActive, active: batchActive, phase: 'idle', progress: null });
  }
  _setProgress(progress: ImportJobState['progress']) {
    this.patch({ progress });
  }
  _finish(result: ImportJobState['result'], warnings: string[], failed: ImportJobState['failed']) {
    this.patch({
      active: this.state.batchActive,
      phase: 'idle',
      progress: null,
      result,
      warnings,
      failed,
      error: null
    });
  }
  _error(msg: string) {
    this.patch({ active: this.state.batchActive, phase: 'idle', progress: null, error: msg });
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
  const identity = canonicalWalletAddress(chainId, address);
  const row = await db.lookupAddresses.get(`${chainId}:${identity}`) ??
    (await db.lookupAddresses.filter((candidate) => candidate.chain === chainId &&
      canonicalWalletAddress(chainId, candidate.address) === identity).first());
  if (chainId === 'solana' && row) {
    const latestCoverage = (await db.sourceCoverage
      .where('sourceIdentityId').equals(row.id).toArray())
      .sort((a, b) => b.generation - a.generation)[0];
    const incompleteInitialHistory = latestCoverage?.endpointOutcomes.some((outcome) =>
      outcome.required && outcome.endpoint.includes(':history:') && outcome.status !== 'complete');
    // A capped/failed initial backfill must be retried from the newest page;
    // advancing to an incremental cursor here would permanently strand the
    // older pages that were never imported.
    if (incompleteInitialHistory) return undefined;
  }
  if (row?.lastSyncedSignature) return row.lastSyncedSignature;

  const existingTxs = await db.transactions
    .filter(
      (t) =>
        t.chain === chainId && t.walletAddress != null &&
        canonicalWalletAddress(chainId, t.walletAddress) === identity &&
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

export interface WalletInitialIdentity {
  label?: string;
  walletAppId?: string;
}

export type WalletInitialIdentityResolver = (
  address: string
) => WalletInitialIdentity | undefined;

function identityForAddress(
  initialIdentity: WalletInitialIdentity | WalletInitialIdentityResolver | undefined,
  address: string
): WalletInitialIdentity | undefined {
  return typeof initialIdentity === 'function' ? initialIdentity(address) : initialIdentity;
}

async function runWalletImportCore(
  addresses: string[],
  chain: ChainDef,
  settings: TaxSettings,
  config: LookupConfig,
  /**
   * Set to true when syncing an existing wallet.
   * Uses incremental fetch (after-signature) to get only NEW transactions
   * since the last import — avoids duplicating existing rows.
   */
  isSync = false,
  initialIdentity?: WalletInitialIdentity | WalletInitialIdentityResolver
): Promise<void> {
  const existing = await getLookupAddresses();
  const existingIds = new Set(existing.map((row) =>
    `${row.chain}:${canonicalWalletAddress(row.chain, row.address)}`));

  let fresh: string[];
  const warnings: string[] = [];

  if (isSync) {
    // Sync: fetch ONLY new transactions since the last known one.
    // Find the most recent transaction signature for each address.
    // A queued on-open sync may hold a stale snapshot after the user removed
    // the wallet. Revalidate ownership after acquiring the shared operation
    // lock and never recreate a source that no longer exists.
    fresh = addresses.filter((address) =>
      existingIds.has(`${chain.id}:${canonicalWalletAddress(chain.id, address)}`));
    const removed = addresses.filter((address) =>
      !existingIds.has(`${chain.id}:${canonicalWalletAddress(chain.id, address)}`));
    for (const address of removed) {
      warnings.push(`${address.slice(0, 8)}…${address.slice(-4)}: wallet was removed — sync skipped.`);
    }
    if (fresh.length === 0) {
      importJob._finish({ imported: 0, pricesUpdated: 0, swapsDetected: 0 }, warnings, []);
      return;
    }
  } else {
    const alreadyKnown = addresses.filter((address) =>
      existingIds.has(`${chain.id}:${canonicalWalletAddress(chain.id, address)}`));
    fresh = addresses.filter((address) =>
      !existingIds.has(`${chain.id}:${canonicalWalletAddress(chain.id, address)}`));
    for (const a of alreadyKnown) {
      warnings.push(`${a.slice(0, 8)}…${a.slice(-4)}: already imported — use Sync to refresh.`);
    }
    if (fresh.length === 0) {
      importJob._finish({ imported: 0, pricesUpdated: 0, swapsDetected: 0 }, warnings, []);
      return;
    }
  }

  // --- Phase 1: Import from RPC ---
  // Network activity is now recorded at each transport chokepoint (see
  // src/lib/networkActivity.ts + rpc/* transports), so no ad-hoc call here.
  importJob._setPhase('importing');

  let transactions: Awaited<ReturnType<typeof lookupManyAddresses>>['transactions'] = [];
  let failed: Awaited<ReturnType<typeof lookupManyAddresses>>['failed'] = [];
  let perAddress: Awaited<ReturnType<typeof lookupManyAddresses>>['perAddress'] = [];
  let apiWarnings: string[] = [...warnings];

  // For incremental sync: use stored cursor so Helius returns only NEW txs.
  let syncConfig: LookupConfig = config;
  if (isSync && fresh.length === 1) {
    const addr = fresh[0];
    const afterSignature = await resolveSyncCursor(chain.id, addr);
    const existingTxs = await db.transactions
      .filter(
        (t) =>
          t.chain === chain.id && t.walletAddress != null &&
          canonicalWalletAddress(chain.id, t.walletAddress) === canonicalWalletAddress(chain.id, addr) &&
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
    perAddress = result.perAddress;
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
  let stagedCount = 0;
  let stagedIds: string[] = [];
  if (transactions.length > 0) {
    const existingTrades = await db.transactions
      .filter((t) => t.type === 'trade' && !!t.sourceRef)
      .toArray();
    const tradeBySourceRef = new Map(
      existingTrades.flatMap((t) => {
        const key = canonicalWalletSourceRefKey(t.chain, t.walletAddress, t.txHash ?? t.sourceRef);
        return key ? [[key, t] as const] : [];
      })
    );
    txsToStore = transactions.filter((t) => {
      const key = canonicalWalletSourceRefKey(t.chain, t.walletAddress, t.txHash ?? t.sourceRef);
      if (!key) return true;
      const trade = tradeBySourceRef.get(key);
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
    stagedCount = txsToStore.length;
    stagedIds = txsToStore.map((transaction) => transaction.id);
    if (txsToStore.length > 0) {
      txsToStore = txsToStore.map((transaction) => applyClassificationEvidence(transaction));
      const materialized = materializeImportedTransactionSafety(txsToStore);
      txsToStore = materialized.transactions;
      const { providerEvidence, automaticDecisions } = materialized;
      await db.transaction('rw', [db.transactions, db.providerEvidence, db.safetyDecisions], async () => {
        await db.transactions.bulkPut(txsToStore);
        if (providerEvidence.length > 0) await db.providerEvidence.bulkPut(providerEvidence);
        if (automaticDecisions.length > 0) await db.safetyDecisions.bulkPut(automaticDecisions);
      });
    }
  }

  // Only wallets whose lookup SUCCEEDED may land in the "Your wallets"
  // registry — a failed first import must stay retryable instead of getting
  // stuck behind "already imported — use Sync". (Sync of an existing wallet
  // keeps its row either way; a failed sync simply doesn't refresh it.)
  const failedAddrs = new Set(failed.map((failure) =>
    `${chain.id}:${canonicalWalletAddress(chain.id, failure.address)}`));
  const succeeded = fresh.filter((address) =>
    !failedAddrs.has(`${chain.id}:${canonicalWalletAddress(chain.id, address)}`));
  for (const address of succeeded) {
    const canonical = canonicalWalletAddress(chain.id, address);
    const evidence = perAddress.find((row) =>
      canonicalWalletAddress(chain.id, row.address) === canonical)?.streamOutcomes;
    if (!evidence?.length) {
      apiWarnings.push(`${address}: history completeness could not be structurally verified.`);
    } else if (evidence.some((outcome) => outcome.required && outcome.status !== 'complete')) {
      const detail = evidence.find((outcome) => outcome.required && outcome.status !== 'complete')?.warning;
      const message = detail
        ? `${address}: ${detail}`
        : `${address}: transaction history is partial; retry the lookup to complete it.`;
      if (!apiWarnings.includes(message)) apiWarnings.push(message);
    }
  }

  // A failed first import owns no source identity and therefore writes no
  // registry/evidence. A failed sync of an existing source still appends an
  // immutable history failure generation without touching prior balances.
  if (isSync) {
    for (const failure of failed) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const operation = await reserveWalletBalanceOperation(chain.id, failure.address);
        // eslint-disable-next-line no-await-in-loop
        await appendFailedWalletBalanceCoverage({
          operation,
          endpointOutcomes: [{
            endpoint: `${chain.id}:history:lookup`, accountClass: 'wallet', required: true,
            status: 'failed', warning: failure.message
          }],
          completedAt: Date.now(), failureKind: 'provider', message: failure.message
        });
      } catch {
        // The source may have been removed after lookup; never recreate it.
      }
    }
  }

  await Promise.all(
    succeeded.map((addr) => {
      const identity = identityForAddress(initialIdentity, addr);
      return identity
        ? upsertLookupAddress(chain.id, addr, stagedCount, undefined, identity)
        : upsertLookupAddress(chain.id, addr, stagedCount);
    })
  );

  // --- Phase 2: Classification + DCA auto-detection ---
importJob._setPhase('classifying');
  let swapsDetected = 0;

  if (txsToStore.length > 0) {
    // Phase 2a: Reclassify reward-token income (GEOD, DBT, …) — always free, no API
    await reprocessRewardIncome();

    // Phase 2a′: DefiLlama reward-income suggestions — gated behind priceApiEnabled.
    // This reaches out to the free, key-less DefiLlama pools endpoint, so it runs
    // ONLY when the user has already permitted network egress via "Live price
    // lookup" (a conscious, approved relaxation of the "no background network in
    // local mode" policy — see defiLlamaRewards.ts). Matches become income flagged
    // needs_review so the user can confirm each one in the Review tab.
    if (settings.priceApiEnabled) {
      // Wrap ONLY this phase: fetchSolanaRewardHints() can throw on a network
      // failure with no cache to fall back to. A DefiLlama outage must NOT strand
      // the import (leaving it stuck 'classifying' and skipping pricing) — treat
      // it as non-fatal and continue to swap detection + pricing.
      try {
        const llamaResult = await applyDefiLlamaRewardSuggestions();
        if (llamaResult.suggested > 0) {
          apiWarnings.unshift(llamaResult.message);
        }
      } catch (err) {
        apiWarnings.unshift(
          `DefiLlama reward suggestions skipped: ${
            err instanceof Error ? err.message : 'network error'
          }.`
        );
      }
    }

    // Phase 2b: Local swap merge (always) + optional Noves for legacy sources.
    const swapResult = await reprocessSwapDetectionInDb(
      settings.novesApiKey,
      (done, total) => importJob._setProgress({ done, total })
    );
    swapsDetected = swapResult.tradesCreated;
    if (swapResult.tradesCreated > 0 || swapResult.reclassified > 0) {
      apiWarnings.unshift(swapResult.message);
    }

    // Phase 2c: DCA auto-classification — HOSTED mode only. Hosted users get
    // recurring orders classified silently (detection is hardened: ≥2 fills,
    // deposit-before-fill ordering, Jupiter-verified on Solana). Local/BYOK
    // users see the Review-tab banner and trigger classification manually, so
    // no background network (Jupiter) fires without a user gesture.
    importJob._setProgress({ done: 0, total: 1 });
    if (isSaasMode()) {
      try {
        const allAfterClassification = await db.transactions.toArray();
        const dcaGroups = detectDcaGroups(allAfterClassification);
        if (dcaGroups.length > 0) {
          // Pass Alchemy key so exact DBT amounts are fetched on-chain per fill tx
          const dcaResult = await applyDcaClassification(
            dcaGroups,
            settings.alchemyApiKey ?? SAAS_PROXY_KEY
          );
          swapsDetected += dcaResult.applied;
          if (dcaResult.applied > 0) {
            apiWarnings.unshift(
              `Auto-classified ${dcaResult.applied} DCA order${dcaResult.applied === 1 ? '' : 's'}: ` +
                `deposit marked non-taxable, fills classified as trades.` +
                (dcaResult.estimated > 0
                  ? ` ${dcaResult.estimated} fill${dcaResult.estimated === 1 ? '' : 's'} use estimated amounts — flagged needs review.`
                  : '') +
                ` Fetch prices to calculate P&L.`
            );
          }
        }
      } catch {
        // Non-fatal: a DCA classification failure must never strand an import.
      }
    }
    importJob._setProgress(null);
  }

  // --- Phase 3: Auto price fetch ---
  // Only runs when the EFFECTIVE priceApiEnabled flag is on. `settings` here is
  // already the effective settings (WalletLookupPanel passes getEffectiveSettings()),
  // so in hosted mode this stays true; in local/BYOK it defaults to false and we
  // skip all network price/FX egress — unpriced rows surface as "price unavailable"
  // in ReviewTab.
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
  const imported = (await db.transactions.bulkGet(stagedIds)).filter(
    (transaction) => transaction != null
  ).length;

  // Refresh wallet tx counts + sync cursor after dedup (succeeded wallets only)
  await Promise.all(
    succeeded.map((addr) => {
      const identity = identityForAddress(initialIdentity, addr);
      return identity
        ? upsertLookupAddress(chain.id, addr, stagedCount, undefined, identity)
        : upsertLookupAddress(chain.id, addr, stagedCount);
    })
  );
  await runInternalTransferMatching(await resolvePostDedupTransferSurvivorIds(txsToStore));

  if (isSync && imported === 0) {
    apiWarnings.unshift('No new transactions found since last sync.');
  }

  // --- Phase 4: on-chain balance refresh (the reconciliation truth anchor) ---
  // Runs after every successful wallet import/sync so the dashboard can
  // reconcile tx-history holdings against what the chain says right now.
  // A balance-fetch failure must NEVER fail the sync — warn and keep the
  // previously stored balances.
  if (succeeded.length > 0) {
    try {
      const balanceOutcome = await refreshWalletBalancesForAddresses(
        succeeded.map((addr) => ({
          chain,
          address: addr,
          historyEndpointOutcomes: historyOutcomesForAddress(chain.id, addr, perAddress)
        })),
        settings
      );
      for (const f of balanceOutcome.failed) {
        apiWarnings.push(
          `${f.address.slice(0, 8)}…${f.address.slice(-4)}: balance refresh failed (${f.message}) — prior balances kept.`
        );
      }
    } catch (err) {
      apiWarnings.push(
        `Balance refresh failed (${err instanceof Error ? err.message : 'network error'}) — prior balances kept.`
      );
    }
    if (chain.id === 'ethereum') {
      for (const address of succeeded) {
        try {
          const outcome = await refreshEthereumPositionAuthority(address, settings);
          apiWarnings.push(...outcome.warnings);
        } catch (err) {
          apiWarnings.push(`${address.slice(0, 8)}…${address.slice(-4)}: protocol position refresh failed (${err instanceof Error ? err.message : 'network error'}) — prior complete positions kept.`);
        }
      }
    }
  }

  importJob._finish(
    { imported, pricesUpdated, swapsDetected },
    apiWarnings,
    failed
  );
}

function historyOutcomesForAddress(
  chainId: string,
  address: string,
  perAddress: Awaited<ReturnType<typeof lookupManyAddresses>>['perAddress']
): EndpointCoverageOutcome[] | undefined {
  const canonical = canonicalWalletAddress(chainId, address);
  const match = perAddress.find((row) => canonicalWalletAddress(chainId, row.address) === canonical);
  if (!match) return undefined;
  if (!match.streamOutcomes?.length) {
    return [{
      endpoint: `${chainId}:history:lookup`, accountClass: 'wallet', required: true,
      status: 'unknown', warning: 'History completeness was not structurally reported by the provider.'
    }];
  }
  return match.streamOutcomes.map((outcome: ProviderStreamOutcome) => ({
    endpoint: `${chainId}:history:${outcome.endpoint}`,
    accountClass: 'wallet',
    required: outcome.required,
    status: outcome.status,
    paginationRequired: outcome.paginationRequired,
    paginationExhausted: outcome.paginationExhausted,
    pages: outcome.pages,
    warning: outcome.warning
  }));
}

/** Every caller participates in the shared operation guard. */
export async function runWalletImport(
  addresses: string[],
  chain: ChainDef,
  settings: TaxSettings,
  config: LookupConfig,
  isSync = false,
  initialIdentity?: WalletInitialIdentity | WalletInitialIdentityResolver,
  operationToken?: ImportOperationToken
): Promise<void> {
  const ownedToken = operationToken ?? importJob._beginBatch();
  try {
    await importJob._waitForBatch(ownedToken);
    await runWalletImportCore(addresses, chain, settings, config, isSync, initialIdentity);
  } finally {
    if (!operationToken) importJob._endBatch(ownedToken);
  }
}
