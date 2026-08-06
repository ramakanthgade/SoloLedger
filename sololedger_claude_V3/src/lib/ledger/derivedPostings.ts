import type { Transaction } from '@/types/transaction';
import { exactActionDisplayQuantity, exactStoredDefiAction } from '@/lib/defi/actionEvidence';
import { isTransactionExcluded } from '@/lib/safety/assetSafety';
import { binanceApiIdentity } from '@/lib/storage/binanceEconomicDedup';
import { normalizeAssetSymbol, transactionLegAssetKey } from './assetKey';
import { canonicalWalletAddress, canonicalWalletChainScope } from './chainNamespace';

export type AccountClass =
  | 'spot' | 'funding' | 'margin' | 'futures' | 'options'
  | 'wallet' | 'manual' | 'unknown';
export type PostingRole = 'principal' | 'counter' | 'liability' | 'fee' | 'opening_balance';
export type PostingPhase = 0 | 10 | 20 | 30;

export interface TransactionEvidenceRef {
  kind: 'transaction';
  transactionId: string;
  role: 'direct' | 'survivor';
  source: string;
  sourceRef?: string;
  importBatchId?: string;
}

export interface SuppressedTwinEvidenceRef {
  kind: 'suppressed_twin';
  transactionId: string;
  source: string;
  sourceRef?: string;
  importBatchId: string;
  apiIdentity: string;
}

export interface DeletedSourceEvidenceRef {
  kind: 'deleted_source';
  sourceIdentityId: string;
  transactionId: string;
  source: string;
  sourceRef?: string;
  apiIdentity: string;
  deletedAt: number;
}

export interface OpeningBalanceEvidenceRef {
  kind: 'opening_balance';
  openingBalanceId: string;
  provenance: 'source_snapshot' | 'user_confirmed';
  evidenceRef?: string;
}

export type EvidenceRef =
  | TransactionEvidenceRef
  | SuppressedTwinEvidenceRef
  | DeletedSourceEvidenceRef
  | OpeningBalanceEvidenceRef;

export interface DerivedPosting {
  id: string;
  taxEventId: string;
  transactionId?: string;
  accountScopeId: string;
  accountClass: AccountClass;
  assetKey: string;
  asset: string;
  signedQuantity: number;
  role: PostingRole;
  postingPhase: PostingPhase;
  ordinal: number;
  effectiveAt: number;
  evidence: EvidenceRef[];
  taxableEffect: 'none' | 'source_transaction_only';
}

export interface ExchangeSourceIdentity {
  id: string;
  exchange: string;
  deletedAt?: number;
  provenAccountClasses?: AccountClass[];
}

export interface OpeningBalanceRow {
  id: string;
  logicalKey: string;
  scopeId: string;
  accountClass: AccountClass;
  assetKey: string;
  asset: string;
  absoluteQuantity: number;
  effectiveAt: number;
  provenance: 'source_snapshot' | 'user_confirmed';
  evidenceRef?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  supersededAt?: number;
}

export interface DerivedPostingContext {
  exchangeConnections: ExchangeSourceIdentity[];
  openingBalances?: OpeningBalanceRow[];
  /** Optional single-pass consumer used only when callers prove input ordering. */
  onTransactionPostings?: (
    transaction: Transaction,
    postings: readonly DerivedPosting[],
    start: number
  ) => void;
}

export type AccountScopeResolution =
  | { scopeStatus: 'resolved'; accountScopeId: string; accountClass: AccountClass; sourceIdentityId?: string }
  | { scopeStatus: 'unresolved'; accountScopeId: string; accountClass: AccountClass; reason: string }
  | { scopeStatus: 'source_deleted'; accountScopeId: string; accountClass: AccountClass; sourceIdentityId: string };

function parsedAccountClass(transaction: Transaction): AccountClass {
  if (transaction.parserAccountClass) return transaction.parserAccountClass;
  if (transaction.source === 'binance_options' || transaction.category?.startsWith('options_')) return 'options';
  if (transaction.instrumentClass === 'derivative' || transaction.category?.startsWith('perp')) return 'futures';
  const raw = transaction.raw;
  if (raw == null) {
    if (transaction.source.endsWith('_api')) return 'spot';
    if (transaction.source === 'manual') return 'manual';
    return 'unknown';
  }
  const rawAccount = raw.Account;
  const buyAccount = (raw.buy as Record<string, unknown> | undefined)?.Account;
  const spendAccount = (raw.spend as Record<string, unknown> | undefined)?.Account;
  const account = typeof rawAccount === 'string' ? rawAccount
    : typeof buyAccount === 'string' ? buyAccount
      : typeof spendAccount === 'string' ? spendAccount : '';
  const value = account.toLowerCase();
  if (value.includes('funding')) return 'funding';
  if (value.includes('margin')) return 'margin';
  if (value.includes('future')) return 'futures';
  if (value.includes('option')) return 'options';
  if (value.includes('spot')) return 'spot';
  if (transaction.source.endsWith('_api')) return 'spot';
  if (transaction.source === 'manual') return 'manual';
  return 'unknown';
}

function walletScope(transaction: Transaction): string | undefined {
  if (!transaction.walletAddress || !transaction.chain) return undefined;
  const customNetworkId = typeof transaction.raw?.customNetworkId === 'string'
    ? transaction.raw.customNetworkId
    : typeof transaction.raw?.chainId === 'string' ? transaction.raw.chainId : undefined;
  return `wallet:${canonicalWalletChainScope(transaction.chain, customNetworkId)}:${canonicalWalletAddress(transaction.chain, transaction.walletAddress)}`;
}

function connectionResolution(
  connection: ExchangeSourceIdentity,
  accountClass: AccountClass
): AccountScopeResolution {
  const accountScopeId = `exchange:${connection.id}`;
  return connection.deletedAt == null
    ? { scopeStatus: 'resolved', accountScopeId, accountClass, sourceIdentityId: connection.id }
    : { scopeStatus: 'source_deleted', accountScopeId, accountClass, sourceIdentityId: connection.id };
}

export function resolveAccountScope(
  transaction: Transaction,
  context: DerivedPostingContext,
  connectionById?: ReadonlyMap<string, ExchangeSourceIdentity>,
  liveBinanceConnections?: readonly ExchangeSourceIdentity[]
): AccountScopeResolution {
  const accountClass = parsedAccountClass(transaction);
  const explicitParserClass = transaction.parserAccountClass != null;
  const deletedSource = transaction.deletedSourceEvidence;
  if (deletedSource) {
    return {
      scopeStatus: 'source_deleted', accountScopeId: `exchange:${deletedSource.sourceIdentityId}`,
      accountClass: !explicitParserClass && accountClass === 'unknown' ? 'spot' : accountClass,
      sourceIdentityId: deletedSource.sourceIdentityId
    };
  }
  const directId = transaction.source.endsWith('_api') ? transaction.importBatchId : undefined;
  if (directId) {
    const connection = connectionById
      ? connectionById.get(directId)
      : context.exchangeConnections.find((row) => row.id === directId);
    if (connection) {
      const proven = connection.provenAccountClasses ?? (transaction.source === 'binance_api' ? ['spot'] : []);
      const directClass = proven.includes(accountClass)
        ? accountClass
        : proven.length === 1 ? proven[0] : accountClass;
      return connectionResolution(connection, directClass);
    }
    return {
      scopeStatus: 'source_deleted', accountScopeId: `exchange:${directId}`,
      accountClass, sourceIdentityId: directId
    };
  }

  const twinId = transaction.dedupMatchedApiRow?.importBatchId;
  if (twinId) {
    const connection = connectionById
      ? connectionById.get(twinId)
      : context.exchangeConnections.find((row) => row.id === twinId);
    const twinClass = !explicitParserClass && accountClass === 'unknown' ? 'spot' : accountClass;
    if (connection) return connectionResolution(connection, twinClass);
    return {
      scopeStatus: 'source_deleted', accountScopeId: `exchange:${twinId}`,
      accountClass: twinClass, sourceIdentityId: twinId
    };
  }

  const wallet = walletScope(transaction);
  if (wallet) {
    if (wallet.includes(':custom:unresolved:')) {
      return {
        scopeStatus: 'unresolved', accountScopeId: wallet, accountClass: 'wallet',
        reason: 'missing_custom_network_identity'
      };
    }
    return { scopeStatus: 'resolved', accountScopeId: wallet, accountClass: 'wallet' };
  }

  const eligibleBinanceCsv = transaction.source === 'binance' || transaction.source === 'binance_spot' ||
    transaction.source === 'binance_transfers';
  if (eligibleBinanceCsv) {
    const live = liveBinanceConnections ??
      context.exchangeConnections.filter((row) => row.exchange === 'binance' && row.deletedAt == null);
    if (live.length === 1) return connectionResolution(live[0], accountClass);
    if (live.length > 1) {
      return { scopeStatus: 'unresolved', accountScopeId: `unresolved:${transaction.id}`, accountClass, reason: 'multiple_binance_connections' };
    }
    if (transaction.importBatchId) {
      return {
        scopeStatus: 'resolved', accountScopeId: `file:${transaction.importBatchId}:${accountClass}`,
        accountClass
      };
    }
  }

  if (transaction.importBatchId) {
    const fileClass = accountClass === 'unknown' ? 'manual' : accountClass;
    return {
      scopeStatus: 'resolved', accountScopeId: `file:${transaction.importBatchId}:${fileClass}`,
      accountClass: fileClass
    };
  }
  if (transaction.source === 'manual') {
    return { scopeStatus: 'resolved', accountScopeId: 'manual', accountClass: 'manual' };
  }
  return {
    scopeStatus: 'unresolved', accountScopeId: `unresolved:${transaction.id}`,
    accountClass, reason: 'missing_ownership_evidence'
  };
}

interface PostingLeg {
  role: Exclude<PostingRole, 'opening_balance'>;
  phase: Exclude<PostingPhase, 0>;
  asset: string;
  assetKey: string;
  quantity: number;
  position: number;
}

interface DefiPostingAction {
  type: 'borrow' | 'repay' | 'borrowing_interest';
  protocolId: string;
  reserveKey: string;
  quantity: number;
}

function defiPostingAction(transaction: Transaction): DefiPostingAction | undefined {
  const value = exactStoredDefiAction(transaction.raw?.defiActionEvidence, transaction);
  const quantity = value ? exactActionDisplayQuantity(value) : undefined;
  if (!value || quantity == null || quantity <= 0 ||
      (value.type !== 'borrow' && value.type !== 'repay' &&
        !(value.type === 'interest' && value.interestKind === 'borrowing')) ||
      typeof value.postingAnchorEventId !== 'string' || !value.eventIds.includes(value.postingAnchorEventId)) return undefined;
  return {
    type: value.type === 'interest' ? 'borrowing_interest' : value.type,
    protocolId: value.protocolId, reserveKey: value.reserveKey, quantity
  };
}

function deletedTransactionEvidence(
  transaction: Transaction,
  deletedSource: NonNullable<Transaction['deletedSourceEvidence']>
): EvidenceRef[] {
  const direct: TransactionEvidenceRef = {
    kind: 'transaction', transactionId: transaction.id,
    role: 'survivor', source: transaction.source,
    sourceRef: transaction.sourceRef, importBatchId: transaction.importBatchId
  };
  return [direct, {
    kind: 'deleted_source', sourceIdentityId: deletedSource.sourceIdentityId,
    transactionId: deletedSource.transactionId, source: deletedSource.source,
    sourceRef: deletedSource.sourceRef, apiIdentity: deletedSource.apiIdentity,
    deletedAt: deletedSource.deletedAt
  }];
}

function transactionEvidence(transaction: Transaction): EvidenceRef[] {
  const twin = transaction.dedupMatchedApiRow;
  const direct: TransactionEvidenceRef = {
    kind: 'transaction', transactionId: transaction.id,
    role: twin ? 'survivor' : 'direct', source: transaction.source,
    sourceRef: transaction.sourceRef, importBatchId: transaction.importBatchId
  };
  if (!twin?.importBatchId) return [direct];
  const apiIdentity = binanceApiIdentity(twin);
  if (!apiIdentity) return [direct];
  return [direct, {
    kind: 'suppressed_twin', transactionId: twin.id, source: twin.source,
    sourceRef: twin.sourceRef, importBatchId: twin.importBatchId, apiIdentity
  }];
}

const POSITIVE_PRINCIPAL_TYPES = new Set<Transaction['type']>(
  ['buy', 'transfer_in', 'income', 'gift_received', 'nft_mint', 'nft_buy', 'defi_withdraw']
);
const NEGATIVE_PRINCIPAL_TYPES = new Set<Transaction['type']>(
  ['sell', 'transfer_out', 'gift_sent', 'fee', 'nft_sell', 'defi_deposit', 'trade']
);
const COUNTER_LEG_TYPES = new Set<Transaction['type']>(['buy', 'sell', 'trade', 'nft_buy', 'nft_sell']);

function signedPrincipal(transaction: Transaction): number {
  if (POSITIVE_PRINCIPAL_TYPES.has(transaction.type)) return Math.abs(transaction.amount);
  if (NEGATIVE_PRINCIPAL_TYPES.has(transaction.type)) return -Math.abs(transaction.amount);
  return 0;
}

function isExchangeCustodyScope(transaction: Transaction, scope: AccountScopeResolution): boolean {
  if (scope.accountScopeId.startsWith('exchange:')) return true;
  if (scope.accountScopeId.startsWith('wallet:')) return false;
  return transaction.source === 'binance' || transaction.source === 'binance_spot' ||
    transaction.source === 'binance_transfers' || transaction.source === 'binance_options';
}

function postingLegAssetKey(
  transaction: Transaction,
  leg: 'principal' | 'counter' | 'fee',
  scope: AccountScopeResolution
): string {
  return transactionLegAssetKey(transaction, leg, {
    exchangeCustody: isExchangeCustodyScope(transaction, scope)
  });
}

function legsFor(transaction: Transaction, scope: AccountScopeResolution): PostingLeg[] {
  if (isTransactionExcluded(transaction) ||
      (transaction.type === 'transfer_out' && transaction.outboundInitiation != null &&
        transaction.outboundInitiation !== 'wallet_initiated')) return [];
  const legs: PostingLeg[] = [];
  const defiAction = defiPostingAction(transaction);
  if (defiAction?.type === 'borrowing_interest') {
    return [{
      role: 'liability', phase: 20, asset: normalizeAssetSymbol(transaction.asset),
      assetKey: `liability:${defiAction.protocolId}:${defiAction.reserveKey}`,
      quantity: -defiAction.quantity, position: 0
    }];
  }
  if (transaction.type === 'fee') {
    const quantity = -Math.abs(transaction.amount);
    if (quantity !== 0 && Number.isFinite(quantity)) {
      legs.push({
        role: 'fee', phase: 30, asset: normalizeAssetSymbol(transaction.asset),
        assetKey: postingLegAssetKey(transaction, 'principal', scope), quantity, position: 0
      });
    }
    return legs;
  }
  const principal = defiAction?.type === 'borrow' ? defiAction.quantity
    : defiAction?.type === 'repay' ? -defiAction.quantity
      : signedPrincipal(transaction);
  if (principal !== 0 && Number.isFinite(principal)) {
    legs.push({
      role: 'principal', phase: 10, asset: normalizeAssetSymbol(transaction.asset),
      assetKey: postingLegAssetKey(transaction, 'principal', scope), quantity: principal, position: 0
    });
  }
  if (defiAction) {
    legs.push({
      role: 'liability', phase: 20, asset: normalizeAssetSymbol(transaction.asset),
      assetKey: `liability:${defiAction.protocolId}:${defiAction.reserveKey}`,
      quantity: defiAction.type === 'borrow' ? -defiAction.quantity : defiAction.quantity,
      position: 1
    });
  }
  if (
    transaction.counterAsset && transaction.counterAmount != null && Number.isFinite(transaction.counterAmount) &&
    COUNTER_LEG_TYPES.has(transaction.type)
  ) {
    const sign = transaction.type === 'buy' || transaction.type === 'nft_buy' ? -1 : 1;
    legs.push({
      role: 'counter', phase: 20, asset: normalizeAssetSymbol(transaction.counterAsset),
      assetKey: postingLegAssetKey(transaction, 'counter', scope),
      quantity: sign * Math.abs(transaction.counterAmount), position: 1
    });
  }
  if (transaction.feeAmount != null && transaction.feeAmount > 0 && Number.isFinite(transaction.feeAmount)) {
    legs.push({
      role: 'fee', phase: 30, asset: normalizeAssetSymbol(transaction.feeAsset ?? transaction.asset),
      assetKey: postingLegAssetKey(transaction, 'fee', scope), quantity: -Math.abs(transaction.feeAmount), position: 2
    });
  }
  return legs;
}

export function deriveTransactionPostings(
  transaction: Transaction,
  context: DerivedPostingContext
): DerivedPosting[] {
  const scope = resolveAccountScope(transaction, context);
  const evidence = transaction.deletedSourceEvidence
    ? deletedTransactionEvidence(transaction, transaction.deletedSourceEvidence)
    : transactionEvidence(transaction);
  const legs = legsFor(transaction, scope);
  const postings: DerivedPosting[] = [];
  let previousPhase: PostingPhase | undefined;
  let ordinal = 0;
  for (const leg of legs) {
    ordinal = previousPhase === leg.phase ? ordinal + 1 : 0;
    previousPhase = leg.phase;
    const id = `${transaction.id}:${leg.phase}:${ordinal}:${leg.assetKey}`;
    postings.push({
      id, taxEventId: transaction.id, transactionId: transaction.id,
      accountScopeId: scope.accountScopeId, accountClass: scope.accountClass,
      assetKey: leg.assetKey, asset: leg.asset, signedQuantity: leg.quantity,
      role: leg.role, postingPhase: leg.phase, ordinal, effectiveAt: transaction.timestamp,
      evidence, taxableEffect: 'source_transaction_only'
    });
  }
  return postings;
}

function appendTransactionPostings(
  target: DerivedPosting[],
  transaction: Transaction,
  context: DerivedPostingContext,
  connectionById: ReadonlyMap<string, ExchangeSourceIdentity>,
  liveBinanceConnections: readonly ExchangeSourceIdentity[]
): void {
  const scope = resolveAccountScope(transaction, context, connectionById, liveBinanceConnections);
  const evidence = transaction.deletedSourceEvidence
    ? deletedTransactionEvidence(transaction, transaction.deletedSourceEvidence)
    : transactionEvidence(transaction);
  let previousPhase: PostingPhase | undefined;
  let ordinal = 0;
  for (const leg of legsFor(transaction, scope)) {
    ordinal = previousPhase === leg.phase ? ordinal + 1 : 0;
    previousPhase = leg.phase;
    target.push({
      id: `${transaction.id}:${leg.phase}:${ordinal}:${leg.assetKey}`,
      taxEventId: transaction.id, transactionId: transaction.id,
      accountScopeId: scope.accountScopeId, accountClass: scope.accountClass,
      assetKey: leg.assetKey, asset: leg.asset, signedQuantity: leg.quantity,
      role: leg.role, postingPhase: leg.phase, ordinal, effectiveAt: transaction.timestamp,
      evidence, taxableEffect: 'source_transaction_only'
    });
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function comparePostings(a: DerivedPosting, b: DerivedPosting): number {
  return a.effectiveAt - b.effectiveAt ||
    compareText(a.taxEventId, b.taxEventId) ||
    a.postingPhase - b.postingPhase || a.ordinal - b.ordinal || compareText(a.id, b.id);
}

function sortPostingsIfNeeded(postings: DerivedPosting[]): DerivedPosting[] {
  for (let index = 1; index < postings.length; index++) {
    const previous = postings[index - 1];
    const current = postings[index];
    if (
      previous.effectiveAt > current.effectiveAt ||
      (previous.effectiveAt === current.effectiveAt && comparePostings(previous, current) > 0)
    ) return postings.sort(comparePostings);
  }
  return postings;
}

function openingPosting(row: OpeningBalanceRow): DerivedPosting {
  if (!Number.isFinite(row.absoluteQuantity) || row.absoluteQuantity < 0) {
    throw new Error(`invalid opening balance ${row.id}`);
  }
  return {
    id: `${row.id}:0:0:${row.assetKey}`, taxEventId: `opening:${row.id}`,
    accountScopeId: row.scopeId, accountClass: row.accountClass,
    assetKey: row.assetKey, asset: normalizeAssetSymbol(row.asset),
    signedQuantity: row.absoluteQuantity, role: 'opening_balance', postingPhase: 0,
    ordinal: 0, effectiveAt: row.effectiveAt,
    evidence: [{ kind: 'opening_balance', openingBalanceId: row.id, provenance: row.provenance, evidenceRef: row.evidenceRef }],
    taxableEffect: 'none'
  };
}

export function derivePostings(
  transactions: readonly Transaction[],
  context: DerivedPostingContext
): DerivedPosting[] {
  const sourcePostings: DerivedPosting[] = [];
  const connectionById = new Map(context.exchangeConnections.map((connection) => [connection.id, connection]));
  const liveBinanceConnections = context.exchangeConnections.filter(
    (connection) => connection.exchange === 'binance' && connection.deletedAt == null
  );
  for (const transaction of transactions) {
    const start = sourcePostings.length;
    appendTransactionPostings(sourcePostings, transaction, context, connectionById, liveBinanceConnections);
    context.onTransactionPostings?.(transaction, sourcePostings, start);
  }
  const openings = context.openingBalances ?? [];
  if (openings.length === 0) return sortPostingsIfNeeded(sourcePostings);
  const openingInstants = new Set<string>();
  for (const row of openings) {
    const instant = `${row.scopeId}|${row.accountClass}|${row.assetKey}|${row.effectiveAt}`;
    if (openingInstants.has(instant)) throw new Error(`ambiguous opening balance instant ${row.id}`);
    openingInstants.add(instant);
    if (sourcePostings.some((posting) =>
      posting.accountScopeId === row.scopeId && posting.accountClass === row.accountClass &&
      posting.assetKey === row.assetKey && posting.effectiveAt === row.effectiveAt
    )) throw new Error(`ambiguous opening balance instant ${row.id}`);
  }
  return [...sourcePostings, ...openings.map(openingPosting)].sort(comparePostings);
}
