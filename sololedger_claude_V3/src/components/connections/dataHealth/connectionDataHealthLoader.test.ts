import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import { buildConnectionDataHealthModel } from './connectionDataHealthLoader';
import type { DataHealthSnapshot } from './dataHealthSnapshot';

const transaction = (over: Partial<Transaction> = {}): Transaction => ({
  id: 'manual-1',
  timestamp: 1_700_000_000_000,
  type: 'buy',
  asset: 'BTC',
  amount: 1,
  fiatCurrency: 'INR',
  fiatValue: 1_000,
  source: 'manual',
  flags: [],
  isInternalTransfer: false,
  ...over
});

const snapshot = (transactions: Transaction[]): DataHealthSnapshot => ({
  transactions,
  wallets: [],
  csvImports: [],
  exchangeConnections: [],
  authoritySnapshots: [],
  authorityAssets: [],
  sourceCoverage: [],
  openingBalances: [],
  defiPositionSnapshots: [],
  defiPositionRows: [],
  walletDefiRefreshManifests: [],
  safetyDecisions: [],
  priceCache: []
});

describe('buildConnectionDataHealthModel', () => {
  it('assembles manual source ownership under Connections', () => {
    const model = buildConnectionDataHealthModel(snapshot([transaction()]), 1_700_000_100_000);

    expect(model.summary.sourceCount).toBe(1);
    expect(model.sources[0]).toMatchObject({
      id: 'manual',
      target: { kind: 'manual', singletonId: 'manual' }
    });
  });

  it('preserves deleted-source evidence as an exact stale remediation target', () => {
    const model = buildConnectionDataHealthModel(snapshot([transaction({
      id: 'deleted-1',
      source: 'binance_api',
      importBatchId: 'removed-connection',
      deletedSourceEvidence: {
        kind: 'deleted_exchange_source',
        sourceIdentityId: 'removed-connection',
        transactionId: 'deleted-1',
        source: 'binance_api',
        apiIdentity: 'deleted-1',
        deletedAt: 1_700_000_050_000
      }
    })]), 1_700_000_100_000);

    expect(model.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'deleted:removed-connection',
        target: { kind: 'exchange', connectionId: 'removed-connection' }
      })
    ]));
  });
});
