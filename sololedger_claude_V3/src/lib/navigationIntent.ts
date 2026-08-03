import { canonicalWalletAddress, canonicalWalletIdentity, normalizeChainIdentity } from './ledger/chainNamespace';

export type ConnectionWorkspaceTab = 'overview' | 'reconciliation' | 'sync-history';
export type TransactionDetailTab = 'details' | 'ledger' | 'cost';

export type ConnectionSourceTarget =
  | { kind: 'exchange'; connectionId: string }
  | { kind: 'csv'; importId: string }
  | { kind: 'wallet'; chain: string; address: string };

export type TransactionSourceTarget = ConnectionSourceTarget | { kind: 'manual'; singletonId: 'manual' };

export type ReconciliationFocus =
  | { kind: 'none' }
  | { kind: 'asset'; scopeId: string; accountClass: string; assetKey: string }
  | { kind: 'opening'; scopeId: string; accountClass: string; assetKey: string; action: 'add' | 'edit'; openingId?: string };

/** Tab and focus are correlated so impossible combinations cannot compile. */
export type SourceNavigationIntent =
  | { id: string; destination: 'connections'; target: ConnectionSourceTarget; workspaceTab: 'overview'; focus: { kind: 'none' } | { kind: 'sync' } | { kind: 'import' } }
  | { id: string; destination: 'connections'; target: ConnectionSourceTarget; workspaceTab: 'reconciliation'; focus: ReconciliationFocus }
  | { id: string; destination: 'connections'; target: ConnectionSourceTarget; workspaceTab: 'sync-history'; focus: { kind: 'none' } };

export interface TransactionScopeFilter {
  /** Durable resolved account scope. Never a display/source label. */
  scopeId?: string;
  accountClass?: string;
  sourceTarget: TransactionSourceTarget;
  assetKey?: string;
  needsPrice?: boolean;
  needsReview?: boolean;
}

export type TransactionNavigationIntent =
  | { id: string; destination: 'transactions'; transactionId: string; detailTab?: TransactionDetailTab; focus: 'transaction' | 'detail-panel'; filter?: never }
  | { id: string; destination: 'transactions'; transactionId?: never; detailTab?: never; filter: TransactionScopeFilter; focus: 'filters' };

export type NavigationIntent = SourceNavigationIntent | TransactionNavigationIntent;
export type NavigationIntentInput = NavigationIntent extends infer T
  ? T extends NavigationIntent ? Omit<T, 'id'> : never
  : never;

export interface NavigableConnectionCard {
  id: string;
  kind: 'exchange-api' | 'file' | 'wallet' | 'manual';
  exchange?: { id: string };
  csvImport?: { id: string };
  walletRows?: readonly { chain: string; address: string }[];
}

export function normalizeSourceTarget<T extends TransactionSourceTarget>(target: T): T {
  if (target.kind !== 'wallet') return target;
  return {
    kind: 'wallet', chain: normalizeChainIdentity(target.chain),
    address: canonicalWalletAddress(target.chain, target.address)
  } as T;
}

/** Exact persisted identity resolution. Display labels are deliberately absent. */
export function resolveSourceTarget(target: ConnectionSourceTarget, cards: readonly NavigableConnectionCard[]): NavigableConnectionCard | undefined {
  const normalized = normalizeSourceTarget(target);
  if (normalized.kind === 'exchange') return cards.find((card) => card.kind === 'exchange-api' && card.exchange?.id === normalized.connectionId);
  if (normalized.kind === 'csv') return cards.find((card) => card.kind === 'file' && card.csvImport?.id === normalized.importId);
  const identity = canonicalWalletIdentity(normalized.chain, normalized.address);
  return cards.find((card) => card.kind === 'wallet' && card.walletRows?.some((row) => canonicalWalletIdentity(row.chain, row.address) === identity));
}

let nextIntentOrdinal = 0;
export function createNavigationIntent<T extends NavigationIntentInput>(intent: T): T & { id: string } {
  nextIntentOrdinal += 1;
  return { ...intent, id: `navigation-${Date.now()}-${nextIntentOrdinal}` };
}
