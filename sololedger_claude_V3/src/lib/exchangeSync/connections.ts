/**
 * Exchange Auto-Sync — connection CRUD on the Dexie `exchangeConnections`
 * table. Credentials stay in this table (local-only); `listConnections()`
 * returns REDACTED views so the API key/secret never reach the UI layer.
 */
import { db, deleteDependentTaxArtifacts, type ExchangeConnectionRow } from '@/lib/storage/db';
import { makeId } from '@/lib/parsers/types';
import { binanceApiIdentity } from '@/lib/storage/binanceEconomicDedup';
import { validateConnection, type SyncEngineDeps } from './engine';
import type {
  ExchangeConnectionView,
  ExchangeCredentials,
  ExchangeCredentialsState,
  ExchangeId,
  NewConnectionInput
} from './types';
import { isEnabledExchangeId } from './types';
import { exchangeAccountCanonicalKey, newAccountIdentity } from '@/lib/accounts/accountIdentity';
import { cleanCounterpartsForDeletedTransactions } from '@/lib/internalTransfers/persistence';

type CredentialAwareConnectionRow = ExchangeConnectionRow & {
  apiKey?: string;
  secret?: string;
  passphrase?: string;
  credentialsState?: ExchangeCredentialsState;
  authorityGeneration?: number;
  revision?: number;
};

const REAUTHORIZATION_CHANGED_ERROR =
  'Connection changed while reauthorization was in progress — test the connection again.';

function credentialsState(row: CredentialAwareConnectionRow): ExchangeCredentialsState {
  if (!isEnabledExchangeId(row.exchange)) return 'deferred';
  // Pre-credential-state rows are existing authorized connections.
  return row.credentialsState ?? 'ready';
}

function trimCredentials(credentials: ExchangeCredentials): ExchangeCredentials {
  return {
    apiKey: credentials.apiKey.trim(),
    secret: credentials.secret.trim(),
    passphrase: credentials.passphrase?.trim() || undefined
  };
}

/** Non-secret compare token for staged work. Credential values never enter job metadata. */
export function connectionSourceToken(row: ExchangeConnectionRow): string {
  return JSON.stringify([
    row.id,
    row.revision ?? 0,
    row.credentialsState ?? 'ready'
  ]);
}

function connectionNonSecretState(row: ExchangeConnectionRow): string {
  const { apiKey: _apiKey, secret: _secret, passphrase: _passphrase, ...state } = row;
  return JSON.stringify(state);
}

/** Count transactions attributable to a connection (importBatchId stamping). */
export async function countConnectionTransactions(connectionId: string): Promise<number> {
  return db.transactions.where('importBatchId').equals(connectionId).count();
}

function toView(row: ExchangeConnectionRow, txCount: number): ExchangeConnectionView {
  const credentialAwareRow = row as CredentialAwareConnectionRow;
  return {
    id: row.id,
    exchange: row.exchange as ExchangeId,
    label: row.label,
    createdAt: row.createdAt,
    lastSyncAt: row.lastSyncAt ?? null,
    txCount,
    lastError: row.lastError ?? null,
    credentialsState: credentialsState(credentialAwareRow),
    cursors: { ...(row.cursors ?? {}) }
  };
}

/** List all saved connections as redacted views (useLiveQuery-compatible). */
export async function listConnections(): Promise<ExchangeConnectionView[]> {
  const rows = await db.exchangeConnections.toArray();
  rows.sort((a, b) => b.createdAt - a.createdAt);
  const views: ExchangeConnectionView[] = [];
  for (const row of rows) {
    views.push(toView(row, await countConnectionTransactions(row.id)));
  }
  return views;
}

/** Fetch the full row (credentials included) — engine/internal use only. */
export async function getConnectionRow(id: string): Promise<ExchangeConnectionRow | undefined> {
  return db.exchangeConnections.get(id);
}

/** Persist a new connection and return its redacted view. */
export async function addConnection(input: NewConnectionInput): Promise<ExchangeConnectionView> {
  if (!isEnabledExchangeId(input.exchange)) throw new Error('This exchange connector is deferred and cannot be connected. Import a file instead.');
  const id = makeId('exc');
  const accountIdentityId = exchangeAccountCanonicalKey(id);
  const row: CredentialAwareConnectionRow = {
    id,
    exchange: input.exchange,
    label: input.label?.trim() || undefined,
    apiKey: input.apiKey.trim(),
    secret: input.secret.trim(),
    passphrase: input.passphrase?.trim() || undefined,
    createdAt: Date.now(),
    cursors: {},
    status: 'idle',
    credentialsState: 'ready',
    authorityGeneration: 0,
    revision: 0,
    accountIdentityId
  };
  await db.transaction('rw', [db.exchangeConnections, db.accountIdentities], async () => {
    await db.accountIdentities.add(newAccountIdentity({
      kind: 'exchange', canonicalKey: accountIdentityId,
      label: row.label, providerId: input.exchange
    }, row.createdAt));
    await db.exchangeConnections.put(row as ExchangeConnectionRow);
  });
  return toView(row as ExchangeConnectionRow, 0);
}

/**
 * Test candidate credentials before atomically restoring an existing source.
 * No candidate value is written until validation has succeeded. The final
 * transaction re-reads and compares the complete source row so a concurrent
 * edit/delete cannot be overwritten.
 */
export async function reauthorizeConnection(
  existingId: string,
  credentials: ExchangeCredentials,
  deps: SyncEngineDeps = {}
): Promise<ExchangeConnectionView> {
  const existing = (await db.exchangeConnections.get(existingId)) as
    | CredentialAwareConnectionRow
    | undefined;
  if (!existing) throw new Error('Connection not found — it may have been removed.');
  if (!isEnabledExchangeId(existing.exchange)) throw new Error('This exchange connector is deferred and cannot be reauthorized. Import a file or remove it.');
  if (credentialsState(existing) !== 'reauthorization_required') {
    throw new Error('This connection does not require reauthorization.');
  }

  const candidate = trimCredentials(credentials);
  const expectedState = connectionNonSecretState(existing as ExchangeConnectionRow);

  await validateConnection(
    {
      exchange: existing.exchange as ExchangeId,
      apiKey: candidate.apiKey,
      secret: candidate.secret,
      passphrase: candidate.passphrase
    },
    deps
  );

  const updated = await db.transaction('rw', db.exchangeConnections, async () => {
    const current = (await db.exchangeConnections.get(existingId)) as
      | CredentialAwareConnectionRow
      | undefined;
    if (
      !current ||
      credentialsState(current) !== 'reauthorization_required' ||
      connectionNonSecretState(current as ExchangeConnectionRow) !== expectedState
    ) {
      throw new Error(REAUTHORIZATION_CHANGED_ERROR);
    }

    const next: CredentialAwareConnectionRow = {
      ...current,
      ...candidate,
      credentialsState: 'ready',
      ...(typeof current.revision === 'number' ? { revision: current.revision + 1 } : {})
    };
    await db.exchangeConnections.put(next as ExchangeConnectionRow);
    return next;
  });

  return toView(updated as ExchangeConnectionRow, await countConnectionTransactions(existingId));
}

/**
 * Delete a connection AND every transaction it imported, mirroring
 * `deleteCsvImportAndTransactions` (rows where `importBatchId === id`, plus
 * their specIdHints).
 */
export async function deleteConnectionAndTransactions(id: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.transactions, db.lots, db.disposals, db.exchangeConnections, db.exchangeBalances, db.specIdHints,
      db.authoritySnapshots, db.authorityAssets, db.sourceCoverage, db.openingBalances],
    async () => {
      // Discovery belongs inside the transaction so rows added by an in-flight
      // save cannot be orphaned between the read and destructive writes.
      const toDelete = await db.transactions.where('importBatchId').equals(id).toArray();
      const snapshots = await db.authoritySnapshots.where('sourceIdentityId').equals(id).toArray();
      const csvSurvivors = await db.transactions.filter((transaction) =>
        transaction.importBatchId !== id && transaction.dedupMatchedApiRow?.importBatchId === id
      ).toArray();
      const snapshotIds = snapshots.map((row) => row.snapshotId);
      const scopes = new Set(snapshots.map((row) => row.scopeId));
      scopes.add(`exchange:${id}`);

      if (toDelete.length > 0) {
        await deleteDependentTaxArtifacts(toDelete.map((t) => t.id));
        await cleanCounterpartsForDeletedTransactions(toDelete.map((t) => t.id));
        await db.transactions.bulkDelete(toDelete.map((t) => t.id));
        await db.specIdHints.bulkDelete(toDelete.map((t) => t.id));
      }
      const deletedAt = Date.now();
      for (const survivor of csvSurvivors) {
        const twin = survivor.dedupMatchedApiRow!;
        const apiIdentity = survivor.dedupMatchedApiId ?? binanceApiIdentity(twin);
        if (!apiIdentity) throw new Error('Cannot preserve deleted source evidence without an API identity.');
        const { dedupMatchedApiId: _bindingId, dedupMatchedApiRow: _bindingRow, ...withoutLiveBinding } = survivor;
        await db.transactions.put({
          ...withoutLiveBinding,
          deletedSourceEvidence: {
            kind: 'deleted_exchange_source', sourceIdentityId: id, transactionId: twin.id,
            source: twin.source, sourceRef: twin.sourceRef, apiIdentity, deletedAt
          }
        });
      }
      if (snapshotIds.length > 0) {
        await db.authorityAssets.where('snapshotId').anyOf(snapshotIds).delete();
        await db.authoritySnapshots.bulkDelete(snapshotIds);
      }
      await db.sourceCoverage.where('sourceIdentityId').equals(id).delete();
      for (const scopeId of scopes) await db.openingBalances.where('scopeId').equals(scopeId).delete();
      await db.exchangeBalances.where('connectionId').equals(id).delete();
      await db.exchangeConnections.delete(id);
    }
  );
}
