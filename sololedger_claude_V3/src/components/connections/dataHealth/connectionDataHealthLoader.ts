import { buildCards } from '@/components/connections/connectionModel';
import {
  buildConnectionWorkspaceFromCard,
  buildConnectionWorkspaceSnapshot,
  prepareConnectionWorkspaceCollectionIndex
} from '@/components/connections/connectionWorkspaceModel';
import type { ExchangeConnectionView } from '@/lib/exchangeSync';
import { canonicalWalletAddress, normalizeChainIdentity } from '@/lib/ledger/chainNamespace';
import { resolveAccountScope } from '@/lib/ledger/derivedPostings';
import { isWalletDefiNetWorthV1Enabled } from '@/lib/features';
import { isTransactionExcluded } from '@/lib/safety/assetSafety';
import {
  buildCoherentDataHealthShadow,
  buildDataHealthModel,
  buildLocalDataHealthDiagnostics,
  type DataHealthModel,
  type LocalDataHealthDiagnostics
} from './dataHealthModel';
import type { DataHealthSnapshot } from './dataHealthSnapshot';

export function buildConnectionDataHealthModel(
  snapshot: DataHealthSnapshot,
  now: number
): DataHealthModel {
  const transactions = snapshot.transactions.filter((transaction) => !isTransactionExcluded(transaction));
  const transactionCountByImport = new Map<string, number>();
  for (const transaction of transactions) {
    if (!transaction.importBatchId) continue;
    transactionCountByImport.set(
      transaction.importBatchId,
      (transactionCountByImport.get(transaction.importBatchId) ?? 0) + 1
    );
  }

  const exchangeViews: ExchangeConnectionView[] = snapshot.exchangeConnections.map((connection) => ({
    id: connection.id,
    exchange: connection.exchange as ExchangeConnectionView['exchange'],
    label: connection.label,
    createdAt: connection.createdAt,
    lastSyncAt: connection.lastSyncAt ?? null,
    txCount: transactionCountByImport.get(connection.id) ?? 0,
    lastError: connection.lastError ?? null,
    credentialsState: connection.credentialsState ?? 'ready',
    cursors: { ...(connection.cursors ?? {}) }
  }));
  const manualCount = transactions.filter((transaction) =>
    transaction.source === 'manual' && transaction.importBatchId == null
  ).length;
  const csvImports = snapshot.csvImports.filter((row) => typeof row.fileName === 'string');
  const cards = buildCards({
    connections: exchangeViews,
    csvImports,
    wallets: snapshot.wallets,
    manualCount,
    syncingConnectionId: null,
    syncActive: false
  });
  const exchangeConnections = snapshot.exchangeConnections.map(({ id, exchange }) => ({ id, exchange }));
  const collectionIndex = prepareConnectionWorkspaceCollectionIndex({
    transactions,
    exchangeConnections,
    openingBalances: snapshot.openingBalances,
    snapshots: snapshot.authoritySnapshots,
    assets: snapshot.authorityAssets,
    sourceCoverage: snapshot.sourceCoverage,
    liveExchangeConnections: exchangeViews,
    liveCsvImports: csvImports,
    liveWalletRows: snapshot.wallets
  });

  const sourceInputs = cards.map((card) => {
    const workspace = buildConnectionWorkspaceFromCard({
      card,
      transactions,
      exchangeConnections,
      openingBalances: snapshot.openingBalances,
      snapshots: snapshot.authoritySnapshots,
      assets: snapshot.authorityAssets,
      sourceCoverage: snapshot.sourceCoverage,
      now,
      collectionIndex,
      liveExchangeConnections: exchangeViews,
      liveCsvImports: csvImports,
      liveWalletRows: snapshot.wallets
    });
    const target = card.kind === 'exchange-api'
      ? { kind: 'exchange' as const, connectionId: card.exchange!.id }
      : card.kind === 'file'
        ? { kind: 'csv' as const, importId: card.csvImport!.id }
        : card.kind === 'wallet'
          ? {
              kind: 'wallet' as const,
              chain: normalizeChainIdentity(card.walletRows![0].chain),
              address: canonicalWalletAddress(card.walletRows![0].chain, card.walletRows![0].address)
            }
          : { kind: 'manual' as const, singletonId: 'manual' as const };
    return { id: card.id, title: card.title, subtitle: card.subtitle, target, snapshot: workspace };
  });

  const deletedGroups = new Map<string, typeof transactions>();
  for (const transaction of transactions) {
    const deletedId = transaction.deletedSourceEvidence?.sourceIdentityId;
    if (!deletedId) continue;
    const rows = deletedGroups.get(deletedId) ?? [];
    rows.push(transaction);
    deletedGroups.set(deletedId, rows);
  }
  for (const [sourceIdentityId, rows] of deletedGroups) {
    const scopes = [...new Map(rows.map((transaction) => {
      const resolved = resolveAccountScope(transaction, { exchangeConnections });
      return [`${resolved.accountScopeId}\u001f${resolved.accountClass}`, {
        scopeId: resolved.accountScopeId,
        accountClass: resolved.accountClass,
        scopeStatus: resolved.scopeStatus
      }] as const;
    })).values()];
    const sourceName = rows[0]?.source.replace(/_api$/, '') ?? 'exchange';
    const workspace = buildConnectionWorkspaceSnapshot({
      id: `deleted:${sourceIdentityId}`,
      kind: 'exchange-api',
      sources: [{
        kind: 'exchange-api',
        sourceIdentityId,
        exchange: sourceName,
        transactionIds: rows.map((row) => row.id)
      }],
      scopes,
      transactions: rows,
      exchangeConnections,
      openingBalances: snapshot.openingBalances,
      snapshots: snapshot.authoritySnapshots,
      assets: snapshot.authorityAssets,
      sourceCoverage: snapshot.sourceCoverage,
      now
    });
    sourceInputs.push({
      id: `deleted:${sourceIdentityId}`,
      title: `Deleted source · ${sourceIdentityId}`,
      subtitle: 'Persisted transactions retain deleted-source evidence.',
      target: { kind: 'exchange', connectionId: sourceIdentityId },
      snapshot: workspace
    });
  }

  return buildDataHealthModel(sourceInputs);
}

export function buildConnectionDataHealthDiagnostics(
  snapshot: DataHealthSnapshot,
  currency: string,
  now: number
): LocalDataHealthDiagnostics {
  const shadow = buildCoherentDataHealthShadow(
    snapshot,
    currency,
    now,
    isWalletDefiNetWorthV1Enabled()
  );
  return buildLocalDataHealthDiagnostics({
    transactions: snapshot.transactions,
    coverage: snapshot.sourceCoverage,
    defiSnapshots: snapshot.defiPositionSnapshots ?? [],
    shadow
  });
}
