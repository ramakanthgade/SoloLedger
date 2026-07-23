/**
 * Exchange Auto-Sync — public surface (contract C3 of the v1.1 plan).
 * The UI (Section C) imports ONLY from this barrel.
 */
import type { Transaction } from '@/types/transaction';

export type {
  ExchangeId,
  NewConnectionInput,
  ExchangeConnectionView,
  InitialSyncPreview,
  ExchangeSyncJobState
} from './types';
export { SYNC_EXCHANGES } from './types';

export {
  listConnections,
  addConnection,
  deleteConnectionAndTransactions
} from './connections';
export { testConnection } from './engine';
export {
  runInitialSync,
  commitInitialSync,
  discardInitialSync,
  syncNow,
  useExchangeSyncJob
} from './syncJob';

// Re-export the Transaction type the preview carries (contract convenience).
export type { Transaction };

/**
 * Pinned explainer copy (Section B owns the string; Section C imports it).
 * Shown by AutoSyncPanel in local/BYOK modes.
 */
export const AUTO_SYNC_HOSTED_ONLY =
  "Auto-sync needs Hosted mode. Exchanges don't allow apps to call them directly from your browser, so auto-sync runs through SoloLedger's secure relay when you're signed in. Your API keys never leave this device — they're stored only in this browser and are used here to sign each request; the relay just passes the signed request along.";
