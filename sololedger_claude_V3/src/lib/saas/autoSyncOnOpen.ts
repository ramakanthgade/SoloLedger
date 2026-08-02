/**
 * Paid-only auto-sync on app open (live-feedback round-4, item 3).
 *
 * The user's ask: "Wallets, blockchains and exchange accounts should
 * automatically sync whenever user opens the app — automatic sync enabled
 * only for paid users. For free users, only manual sync."
 *
 * `maybeAutoSyncOnOpen()` runs ONCE per app boot (wired from App.tsx after
 * the shell mounts + the per-user DB is ready) and ONLY when ALL of:
 *   - app mode is hosted (the exchange relay is hosted-only anyway —
 *     AUTO_SYNC_HOSTED_ONLY);
 *   - the session user has an ACTIVE PAID subscription
 *     (`subscriptionActive` and plan ≠ the free `local` tier in plans.ts);
 *   - at least one connection exists (exchange or watched wallet).
 *
 * Free / local / BYOK users: never auto-sync — the per-card manual Sync is
 * untouched.
 *
 * Every exchange connection (engine `syncNow`) and every wallet group (the
 * same incremental `runWalletImport(…, isSync=true)` the connection card's
 * Sync action uses) is synced SEQUENTIALLY and fail-soft: region_blocked
 * (Binance 451), invalid keys and network errors are caught per connection
 * and never block boot. Progress surfaces unobtrusively through the existing
 * toast system: one toast when the run starts, one summary toast at the end.
 * No new blocking UI.
 *
 * The toast host is self-contained (a lazily DOM-mounted ToastViewport using
 * the ui/toast components) so App.tsx only adds the single calling effect.
 */
import { createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Toast, ToastViewport } from '@/components/ui/toast';
import { listConnections, syncNow, type ExchangeConnectionView } from '@/lib/exchangeSync';
import { exchangeSyncJob } from '@/lib/exchangeSync/syncJob';
import { importJob, runWalletImport } from '@/lib/importJob';
import { walletConnectionGroupKey } from '@/lib/ledger/chainNamespace';
import { getLookupAddresses, type LookupAddressRow } from '@/lib/storage/db';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { buildLookupConfig } from '@/lib/saas/lookupConfig';
import { getMode } from '@/lib/saas/mode';
import { CHAINS } from '@/lib/rpc/providers';
import type { PublicUser } from '@/lib/saas/api';
import type { PlanId } from '@/lib/saas/plans';

/** The ₹0 tier in plans.ts — free users never auto-sync. */
export const FREE_PLAN_ID: PlanId = 'local';

export interface AutoSyncToast {
  tone: 'gain' | 'loss' | 'warn' | 'primary';
  title: string;
  description?: string;
}

/** Per-connection outcome: `imported` = newly saved transactions. */
export interface SyncUnitOutcome {
  imported: number;
  failed: boolean;
}

export interface AutoSyncOnOpenDeps {
  /** Override the hosted-mode check (defaults to `getMode() === 'hosted'`). */
  hosted?: boolean;
  listExchangeConnections?: () => Promise<ExchangeConnectionView[]>;
  listWalletRows?: () => Promise<LookupAddressRow[]>;
  syncExchange?: (id: string) => Promise<SyncUnitOutcome>;
  syncWalletGroup?: (rows: LookupAddressRow[]) => Promise<SyncUnitOutcome>;
  /** Toast sink — defaults to the self-contained DOM host below. */
  toast?: (t: AutoSyncToast) => void;
}

export interface AutoSyncOnOpenResult {
  /** True when a sync pass actually ran (even if some connections failed). */
  ran: boolean;
  reason?:
    | 'already-ran'
    | 'not-hosted'
    | 'no-user'
    | 'not-paid'
    | 'no-connections'
    | 'reauthorization-required';
  total?: number;
  synced?: number;
  failed?: number;
  newTransactions?: number;
}

// ── Self-contained toast host (lazy DOM singleton) ──────────────────────

interface ToastItem extends AutoSyncToast {
  id: number;
}

let toastItems: ToastItem[] = [];
let toastSeq = 0;
let toastRoot: Root | null = null;
let rerenderToasts: (() => void) | null = null;

function dismissToast(id: number): void {
  toastItems = toastItems.filter((x) => x.id !== id);
  rerenderToasts?.();
}

function AutoSyncToastHost() {
  const [, force] = useState(0);
  useEffect(() => {
    rerenderToasts = () => force((n) => n + 1);
    return () => {
      rerenderToasts = null;
    };
  }, []);
  return createElement(
    ToastViewport,
    null,
    ...toastItems.map((t) =>
      createElement(Toast, {
        key: t.id,
        tone: t.tone,
        title: t.title,
        description: t.description,
        onDismiss: () => dismissToast(t.id)
      })
    )
  );
}

function domToastSink(t: AutoSyncToast): void {
  if (typeof document === 'undefined') return;
  const id = ++toastSeq;
  toastItems = [...toastItems.slice(-2), { ...t, id }];
  if (!toastRoot) {
    const el = document.createElement('div');
    el.setAttribute('data-testid', 'autosync-toast-root');
    document.body.appendChild(el);
    toastRoot = createRoot(el);
    toastRoot.render(createElement(AutoSyncToastHost));
  }
  rerenderToasts?.();
  window.setTimeout(() => dismissToast(id), 6000);
}

// ── Default sync units (the same entries the Connections UI uses) ──────

/** Exchange connection — the engine's incremental `syncNow`. */
async function defaultSyncExchange(id: string): Promise<SyncUnitOutcome> {
  try {
    await syncNow(id);
    const st = exchangeSyncJob.get();
    return { imported: st.error ? 0 : (st.result?.imported ?? 0), failed: Boolean(st.error) };
  } catch {
    return { imported: 0, failed: true };
  }
}

/**
 * Wallet group — the connection card's Sync action: an incremental
 * `runWalletImport` per chain row of the group.
 */
async function defaultSyncWalletGroup(rows: LookupAddressRow[]): Promise<SyncUnitOutcome> {
  let imported = 0;
  let failed = false;
  const settings = await getEffectiveSettings();
  for (const row of rows) {
    const chain = CHAINS.find((c) => c.id === row.chain);
    if (!chain) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await runWalletImport([row.address], chain, settings, buildLookupConfig(chain, settings), true);
      const st = importJob.get();
      if (st.error) failed = true;
      else imported += st.result?.imported ?? 0;
    } catch {
      failed = true;
    }
  }
  return { imported, failed };
}

/** Match Connections grouping: EVM spans chains; non-EVM identity stays exact. */
function groupWalletRows(rows: LookupAddressRow[]): LookupAddressRow[][] {
  const byAddress = new Map<string, LookupAddressRow[]>();
  for (const row of rows) {
    const key = walletConnectionGroupKey(row.chain, row.address);
    const group = byAddress.get(key) ?? [];
    group.push(row);
    byAddress.set(key, group);
  }
  return [...byAddress.values()];
}

// ── Orchestrator ────────────────────────────────────────────────────────

/** Once-per-boot latch — collapses StrictMode/double-effect re-entry. */
let bootStarted = false;

/** Test hook: re-arm the once-per-boot latch. */
export function __resetAutoSyncOnOpenForTests(): void {
  bootStarted = false;
}

/**
 * Auto-sync every connection once per app boot, paid hosted users only.
 * Never throws — boot must never be blocked by a sync failure.
 */
export async function maybeAutoSyncOnOpen(
  user: PublicUser | null,
  deps: AutoSyncOnOpenDeps = {}
): Promise<AutoSyncOnOpenResult> {
  if (bootStarted) return { ran: false, reason: 'already-ran' };
  const hosted = deps.hosted ?? getMode() === 'hosted';
  if (!hosted) return { ran: false, reason: 'not-hosted' };
  if (!user) return { ran: false, reason: 'no-user' };
  if (!user.subscriptionActive || user.plan === FREE_PLAN_ID) {
    return { ran: false, reason: 'not-paid' };
  }

  const toast = deps.toast ?? domToastSink;
  const listExchanges = deps.listExchangeConnections ?? listConnections;
  const listWallets = deps.listWalletRows ?? getLookupAddresses;
  const syncExchange = deps.syncExchange ?? defaultSyncExchange;
  const syncWalletGroup = deps.syncWalletGroup ?? defaultSyncWalletGroup;

  // The check runs once per boot from here on, whatever the outcome.
  bootStarted = true;

  const [exchanges, walletRows] = await Promise.all([
    listExchanges().catch(() => [] as ExchangeConnectionView[]),
    listWallets().catch(() => [] as LookupAddressRow[])
  ]);
  // A restored source without usable credentials is intentionally not a sync
  // unit. Connections owns the reachable Reauthorize action; attempting it
  // here would turn an expected paused state into a misleading failed sync.
  const readyExchanges = exchanges.filter(
    (connection) => connection.credentialsState !== 'reauthorization_required'
  );
  const walletGroups = groupWalletRows(walletRows);
  const total = readyExchanges.length + walletGroups.length;
  if (total === 0) {
    return {
      ran: false,
      reason:
        exchanges.some((connection) => connection.credentialsState === 'reauthorization_required')
          ? 'reauthorization-required'
          : 'no-connections'
    };
  }

  toast({
    tone: 'primary',
    title: `Syncing ${total} connection${total === 1 ? '' : 's'}…`
  });

  let synced = 0;
  let failed = 0;
  let newTransactions = 0;
  const units: Array<() => Promise<SyncUnitOutcome>> = [
    ...readyExchanges.map((c) => () => syncExchange(c.id)),
    ...walletGroups.map((rows) => () => syncWalletGroup(rows))
  ];
  for (const unit of units) {
    try {
      // Sequential by design: the exchange job store is single-slot and the
      // wallet import job is global — parallel runs would no-op or trample.
      // eslint-disable-next-line no-await-in-loop
      const outcome = await unit();
      if (outcome.failed) failed += 1;
      else synced += 1;
      newTransactions += outcome.imported;
    } catch {
      // region_blocked (Binance 451), invalid keys, network errors — never
      // block boot, never spam; the summary toast counts them.
      failed += 1;
    }
  }

  if (failed === 0) {
    toast({
      tone: 'gain',
      title: `Synced ${synced} connection${synced === 1 ? '' : 's'} · ${newTransactions} new transaction${newTransactions === 1 ? '' : 's'}`
    });
  } else {
    toast({
      tone: 'warn',
      title: `Synced ${synced} of ${total} connections · ${newTransactions} new transaction${newTransactions === 1 ? '' : 's'}`,
      description: `${failed} couldn't sync — open Connections to retry`
    });
  }

  return { ran: true, total, synced, failed, newTransactions };
}
