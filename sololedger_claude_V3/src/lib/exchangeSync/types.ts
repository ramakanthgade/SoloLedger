/**
 * Exchange Auto-Sync — shared types (contract C3 of the v1.1 plan).
 *
 * Pure type/constant module: NO ccxt, db, or saas imports so it can be pulled
 * into any bundle context without dragging the lazy ccxt graph along.
 */
import type { Transaction } from '@/types/transaction';

/** The five exchanges supported by auto-sync in v1. (ONE name — no aliases.) */
export type ExchangeId = 'binance' | 'coinbase' | 'kraken' | 'okx' | 'kucoin';

export const SYNC_EXCHANGES: readonly ExchangeId[] = [
  'binance',
  'coinbase',
  'kraken',
  'okx',
  'kucoin'
] as const;

/** Per-kind sync cursors (epoch ms) persisted on the connection row. */
export interface ExchangeSyncCursors {
  trades?: number;
  deposits?: number;
  withdrawals?: number;
}

export interface NewConnectionInput {
  exchange: ExchangeId;
  label?: string;
  apiKey: string;
  secret: string;
  passphrase?: string;
}

/**
 * Classified sync error kinds. `not_hosted` means the app is in local/BYOK
 * mode (auto-sync needs Hosted mode); `relay_*` kinds come from the tunnel's
 * `x-sololedger-error` header (relay-origin failures); the rest are
 * exchange-origin ccxt errors mapped to plain-language buckets.
 */
export type SyncErrorKind =
  | 'not_hosted'
  | 'relay_auth'
  | 'relay_subscription'
  | 'relay_disabled'
  | 'relay_payload'
  | 'relay_unavailable'
  | 'invalid_key'
  | 'permission'
  | 'rate_limit'
  | 'network'
  | 'region_blocked'
  | 'unknown';

/** Result of a completed sync run (commit mode). */
export interface SyncRunResult {
  imported: number;
  pricesUpdated: number;
  isFirstSync: boolean;
}

/** REDACTED connection view — credentials never reach the UI. */
export interface ExchangeConnectionView {
  id: string;
  exchange: ExchangeId;
  label?: string;
  createdAt: number;
  lastSyncAt: number | null;
  txCount: number;
  lastError: string | null;
}

/**
 * First-sync staged preview. `transactions` are staged in the module-level
 * job store, NOT persisted, until the user confirms (`commitInitialSync`).
 */
export interface InitialSyncPreview {
  connectionId: string;
  exchange: ExchangeId;
  transactions: Transaction[]; // staged, NOT persisted
  warnings: string[];
  missingPriceCount: number;
  distinctAssets: number;
  /** Staged rows already in DB (filterAlreadyImported check at stage time). */
  duplicatesSkipped: number;
  /** min/max staged timestamps (ms), null when nothing was staged. */
  dateRange: { from: number; to: number } | null;
  /** e.g. { buy: 200, sell: 80, transfer_in: 20, transfer_out: 12 } */
  typeBreakdown: Record<string, number>;
}

/** Module-level job state (mirrors importJob.ts) — survives tab navigation. */
export interface ExchangeSyncJobState {
  active: boolean;
  connectionId: string | null;
  connectionLabel: string;
  phase: 'idle' | 'validating' | 'fetching' | 'saving' | 'pricing';
  progress: { done: number; total: number } | null;
  result: { imported: number; pricesUpdated: number; isFirstSync: boolean } | null;
  /** Staged first-sync preview (survives tab navigation). */
  preview: InitialSyncPreview | null;
  warnings: string[];
  error: string | null;
}
