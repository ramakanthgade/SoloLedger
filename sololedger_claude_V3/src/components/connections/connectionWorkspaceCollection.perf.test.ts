import { expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import type { ConnectionCardData } from './connectionModel';
import {
  buildConnectionWorkspaceFromCard,
  prepareConnectionWorkspaceCollectionIndex
} from './connectionWorkspaceModel';

it('builds a 30k ledger across 100 source workspaces in under 250 ms', () => {
  const sourceCount = 100;
  const connections = Array.from({ length: sourceCount }, (_, index) => ({
    id: `conn-${index}`, exchange: 'kraken'
  }));
  const transactions: Transaction[] = Array.from({ length: 30_000 }, (_, index) => ({
    id: `many-source-${index}`,
    timestamp: index + 1,
    type: 'transfer_in',
    asset: 'BTC',
    amount: 1,
    fiatCurrency: 'USD',
    source: 'kraken_api',
    importBatchId: `conn-${index % sourceCount}`,
    flags: [],
    isInternalTransfer: false
  }));
  const cards: ConnectionCardData[] = connections.map((connection, index) => ({
    id: `exchange:${connection.id}`,
    kind: 'exchange-api',
    lane: 'exchanges',
    iconId: 'kraken',
    iconFallback: 'K',
    title: `Kraken ${index}`,
    subtitle: 'API auto-sync',
    tags: ['Exchange'],
    status: { tone: 'gain', label: 'Synced' },
    metaLine: 'Synced',
    exchange: {
      id: connection.id,
      exchange: 'kraken',
      createdAt: 1,
      lastSyncAt: 2,
      txCount: 300,
      lastError: null
    }
  }));
  const emptyConnections = Array.from({ length: 500 }, (_, index) => ({ id: `empty-${index}`, exchange: 'kraken' }));
  const emptyCards: ConnectionCardData[] = emptyConnections.map((connection, index) => ({
    ...cards[0], id: `exchange:${connection.id}`, title: `Empty Kraken ${index}`,
    exchange: { ...cards[0].exchange!, id: connection.id, txCount: 0 }
  }));
  const input = {
    transactions,
    exchangeConnections: [...connections, ...emptyConnections],
    openingBalances: [],
    snapshots: [],
    assets: [],
    sourceCoverage: []
  };

  const run = () => {
    const startedAt = performance.now();
    const collectionIndex = prepareConnectionWorkspaceCollectionIndex(input);
    const workspaces = [...cards, ...emptyCards].map((card) => buildConnectionWorkspaceFromCard({
      ...input,
      card,
      now: 2_000_000,
      collectionIndex
    }));
    return { elapsed: performance.now() - startedAt, workspaces };
  };
  run();
  const samples = Array.from({ length: 20 }, run);
  // Twenty samples make nearest-rank p95 distinct from a single scheduler or GC pause.
  const measures = samples.map((sample) => sample.elapsed).sort((left, right) => left - right);
  const p95 = measures[Math.ceil(measures.length * 0.95) - 1];
  const workspaces = samples[samples.length - 1].workspaces;

  expect(workspaces.reduce((sum, workspace) => sum + workspace.overview.transactionCount, 0)).toBe(30_000);
  expect(workspaces.slice(sourceCount).every((workspace) => workspace.overview.transactionCount === 0)).toBe(true);
  expect(p95).toBeLessThan(250);
});
