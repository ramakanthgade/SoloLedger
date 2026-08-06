import { canonicalWalletAddress, canonicalWalletChainScope, chainNamespace } from '@/lib/ledger/chainNamespace';
import { isValidWalletAddress } from '@/lib/rpc/walletAddressValidation';

export type AccountIdentityKind = 'wallet' | 'exchange' | 'csv';
export type AccountOwnershipStatus = 'owned' | 'not_owned' | 'unknown';
export type AccountOwnershipOrigin = 'user' | 'legacy' | 'migration' | 'import';

export interface AccountIdentityRow {
  id: string;
  kind: AccountIdentityKind;
  canonicalKey: string;
  ownershipStatus: AccountOwnershipStatus;
  ownershipConfirmedAt?: number;
  ownershipOrigin?: AccountOwnershipOrigin;
  ownershipDismissedAt?: number;
  label?: string;
  walletAppId?: string;
  providerId?: string;
  parserId?: string;
  createdAt: number;
  updatedAt: number;
  lifecycleRevision: number;
}

export interface AccountOwnershipUpdate {
  status: AccountOwnershipStatus;
  origin: AccountOwnershipOrigin;
  confirmedAt?: number;
  dismissedAt?: number;
}

export function walletAccountCanonicalKey(chain: string, address: string): string {
  const canonicalAddress = canonicalWalletAddress(chain, address);
  const namespace = chainNamespace(chain);
  if (namespace === 'evm') {
    if (!isValidWalletAddress(namespace, canonicalAddress)) throw new Error('EVM account requires a 20-byte hexadecimal address.');
    return `wallet:evm:${canonicalAddress}`;
  }
  if (!isValidWalletAddress(namespace, canonicalAddress)) {
    throw new Error('Wallet account requires a supported canonical non-EVM address.');
  }
  return `wallet:${canonicalWalletChainScope(chain)}:${canonicalAddress}`;
}

export function exchangeAccountCanonicalKey(connectionId: string): string {
  if (!connectionId.trim()) throw new Error('Exchange connection id is required.');
  return `exchange:${connectionId}`;
}

export function conservativeCsvAccountCanonicalKey(importId: string): string {
  if (!importId.trim()) throw new Error('CSV import id is required.');
  return `csv-account:${importId}`;
}

/** Explicit non-secret persistence/backup projection. Runtime-added fields are never copied. */
export function safeAccountIdentityProjection(row: AccountIdentityRow): AccountIdentityRow {
  return {
    id: row.id,
    kind: row.kind,
    canonicalKey: row.canonicalKey,
    ownershipStatus: row.ownershipStatus,
    ownershipConfirmedAt: row.ownershipConfirmedAt,
    ownershipOrigin: row.ownershipOrigin,
    ownershipDismissedAt: row.ownershipDismissedAt,
    label: row.label,
    walletAppId: row.walletAppId,
    providerId: row.providerId,
    parserId: row.parserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lifecycleRevision: row.lifecycleRevision
  };
}

export function newAccountIdentity(
  input: Pick<AccountIdentityRow, 'kind' | 'canonicalKey'> &
    Partial<Pick<AccountIdentityRow, 'label' | 'walletAppId' | 'providerId' | 'parserId'>>,
  now = Date.now()
): AccountIdentityRow {
  return {
    id: input.canonicalKey,
    kind: input.kind,
    canonicalKey: input.canonicalKey,
    ownershipStatus: 'unknown',
    ownershipOrigin: 'migration',
    label: input.label?.trim() || undefined,
    walletAppId: input.walletAppId?.trim() || undefined,
    providerId: input.providerId?.trim() || undefined,
    parserId: input.parserId?.trim() || undefined,
    createdAt: now,
    updatedAt: now,
    lifecycleRevision: 0
  };
}

export function applyOwnershipUpdate(
  row: AccountIdentityRow,
  update: AccountOwnershipUpdate,
  now = Date.now()
): AccountIdentityRow {
  const confirmedAt = update.status === 'unknown' ? undefined : update.confirmedAt ?? now;
  return {
    ...row,
    ownershipStatus: update.status,
    ownershipOrigin: update.origin,
    ownershipConfirmedAt: confirmedAt,
    ownershipDismissedAt: update.status === 'unknown' ? update.dismissedAt ?? now : undefined,
    updatedAt: now,
    lifecycleRevision: row.lifecycleRevision + 1
  };
}

export function assertValidAccountIdentity(row: AccountIdentityRow): void {
  if (typeof row.id !== 'string' || typeof row.kind !== 'string' ||
    typeof row.canonicalKey !== 'string' || typeof row.ownershipStatus !== 'string') {
    throw new Error('Invalid account identity shape.');
  }
  const walletParts = row.canonicalKey.split(':');
  const walletNamespace = walletParts[1];
  const walletChain = walletParts[2];
  const walletAddress = walletParts.slice(3).join(':');
  const validNonEvmChain = walletNamespace === 'bitcoin'
    ? walletChain === 'bitcoin' || walletChain === 'btc'
    : walletNamespace === 'solana'
      ? walletChain === 'solana' || walletChain === 'sol'
      : walletNamespace === 'starknet' && (walletChain === 'starknet' || walletChain === 'starknet_mainnet');
  const hasValidCanonicalKey = row.kind === 'wallet'
    ? walletNamespace === 'evm'
      ? walletParts.length === 3 && /^0x[0-9a-f]{40}$/.test(walletParts[2])
      : walletParts.length === 4 && validNonEvmChain &&
        isValidWalletAddress(walletNamespace, walletAddress)
    : row.kind === 'exchange'
      ? /^exchange:.+$/.test(row.canonicalKey)
      : row.kind === 'csv' && /^csv-account:[^\s:]+$/.test(row.canonicalKey);
  const hasValidOptionalStrings = [
    row.ownershipOrigin, row.label, row.walletAppId, row.providerId, row.parserId
  ].every((value) => value == null || typeof value === 'string');
  if (!row.id.trim() || row.id !== row.canonicalKey ||
    !['wallet', 'exchange', 'csv'].includes(row.kind) ||
    !hasValidCanonicalKey ||
    !hasValidOptionalStrings ||
    !['owned', 'not_owned', 'unknown'].includes(row.ownershipStatus) ||
    (row.ownershipOrigin != null && !['user', 'legacy', 'migration', 'import'].includes(row.ownershipOrigin)) ||
    !Number.isFinite(row.createdAt) || !Number.isFinite(row.updatedAt) || row.updatedAt < row.createdAt ||
    !Number.isSafeInteger(row.lifecycleRevision) || row.lifecycleRevision < 0 ||
    (row.ownershipConfirmedAt != null && !Number.isFinite(row.ownershipConfirmedAt)) ||
    (row.ownershipDismissedAt != null && !Number.isFinite(row.ownershipDismissedAt)) ||
    (row.ownershipStatus === 'unknown' && row.ownershipConfirmedAt != null) ||
    (row.ownershipStatus !== 'unknown' && (row.ownershipConfirmedAt == null || row.ownershipOrigin == null)) ||
    (row.ownershipStatus !== 'unknown' && row.ownershipDismissedAt != null)) {
    throw new Error('Invalid account identity shape.');
  }
}
