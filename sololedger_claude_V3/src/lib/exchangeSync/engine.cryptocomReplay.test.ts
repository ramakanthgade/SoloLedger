import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/saas/api', () => ({ apiFetch: vi.fn(), getAuthToken: vi.fn(() => 'fixture-jwt') }));
vi.mock('@/lib/saas/config', () => ({ isSaasMode: vi.fn(() => true) }));
vi.mock('@/lib/saas/effectiveSettings', () => ({
  getEffectiveSettings: vi.fn(async () => ({ priceApiEnabled: false })),
  getBinanceGatewayUrl: vi.fn(async () => null)
}));

import { apiFetch } from '@/lib/saas/api';
import { addConnection } from './connections';
import { clearAllData, db, transactionExchangeKey } from '@/lib/storage/db';
import { syncConnection } from './engine';
import { reconcileHoldings } from '@/lib/dashboard/dashboardModel';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';
import { createFullBackupPayload, importFullBackup } from '@/lib/storage/backup';
import { evaluateSourceCoverage } from '@/lib/reconcile/sourceCoverage';
import {
  CRYPTOCOM_REPLAY_NOW,
  cryptocomReplayDeps,
  installCryptocomFixtureServer
} from './__fixtures__/cryptocomReplay';

const apiFetchMock = vi.mocked(apiFetch);
const backupFile = (payload: unknown) =>
  new File([JSON.stringify(payload)], 'backup.json', { type: 'application/json' });

describe('Crypto.com Exchange real-CCXT replay', () => {
  beforeEach(async () => {
    await clearAllData();
    apiFetchMock.mockReset();
    installCryptocomFixtureServer(apiFetchMock);
  });

  it.each([
    ['cursorless', undefined],
    ['stale-cursor', {
      deposits: CRYPTOCOM_REPLAY_NOW - 365 * 86_400_000,
      withdrawals: CRYPTOCOM_REPLAY_NOW - 365 * 86_400_000,
      trades: CRYPTOCOM_REPLAY_NOW - 365 * 86_400_000
    }]
  ] as const)(
    'keeps retention truncation primary when a committed %s sync also filters rows',
    async (_scenario, cursors) => {
      const view = await addConnection({
        exchange: 'cryptocom', apiKey: 'fixture-key', secret: 'fixture-secret'
      });
      if (cursors) await db.exchangeConnections.update(view.id, { cursors });

      const result = await syncConnection(view.id, { mode: 'commit' }, {}, cryptocomReplayDeps());
      expect(result.mode).toBe('commit');
      const coverage = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).first())!;
      const outcomes = new Map(coverage.endpointOutcomes.map((outcome) => [outcome.endpoint, outcome]));

      expect(outcomes.get('trades')).toMatchObject({
        status: 'partial',
        warning: 'retention_truncated',
        skippedCount: 1,
        excludedCount: 1,
        failedCount: 1,
        exclusionReasons: ['derivative_out_of_scope', 'trade_normalization_failed']
      });
      expect(outcomes.get('deposits')).toMatchObject({
        status: 'partial',
        warning: 'retention_truncated',
        skippedCount: 1,
        exclusionReasons: ['unsettled_transfer']
      });
      expect(outcomes.get('withdrawals')).toMatchObject({
        status: 'partial',
        warning: 'retention_truncated',
        skippedCount: 1,
        exclusionReasons: ['unsettled_transfer']
      });
    }
  );

  it('keeps an incremental derivative-only exclusion complete and round-trips scoped coverage', async () => {
    const view = await addConnection({
      exchange: 'cryptocom', apiKey: 'fixture-key', secret: 'fixture-secret'
    });
    await db.exchangeConnections.update(view.id, {
      cursors: {
        deposits: CRYPTOCOM_REPLAY_NOW - 60 * 86_400_000,
        withdrawals: CRYPTOCOM_REPLAY_NOW - 60 * 86_400_000,
        trades: CRYPTOCOM_REPLAY_NOW - 60 * 86_400_000
      }
    });
    installCryptocomFixtureServer(apiFetchMock, {
      tradeIds: ['90002'],
      depositIds: ['42'],
      withdrawalIds: ['42']
    });

    await syncConnection(view.id, { mode: 'commit' }, {}, cryptocomReplayDeps());
    const coverage = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).first())!;
    expect(coverage.endpoints).toEqual(['deposits', 'withdrawals', 'trades']);
    expect(coverage.endpointOutcomes.map((outcome) => outcome.endpoint)).toEqual([
      'deposits', 'withdrawals', 'trades'
    ]);
    expect(coverage).toMatchObject({
      status: 'complete', recognizedCount: 3, parsedCount: 2, skippedCount: 0,
      excludedCount: 1, failedCount: 0, exclusionReasons: ['derivative_out_of_scope']
    });
    expect(coverage.endpointOutcomes.find((outcome) => outcome.endpoint === 'trades')).toMatchObject({
      status: 'complete', paginationExhausted: true, skippedCount: 0, excludedCount: 1,
      failedCount: 0, exclusionReasons: ['derivative_out_of_scope']
    });
    for (const endpoint of ['deposits', 'withdrawals']) expect(
      coverage.endpointOutcomes.find((outcome) => outcome.endpoint === endpoint)
    ).toMatchObject({ status: 'complete', paginationExhausted: true });
    expect(evaluateSourceCoverage(coverage)).toMatchObject({ status: 'complete', reasons: [] });

    const payload = await createFullBackupPayload();
    await importFullBackup(backupFile(payload));
    const restored = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).first())!;
    expect(evaluateSourceCoverage(restored)).toMatchObject({ status: 'complete', reasons: [] });
    expect(evaluateSourceCoverage(restored).reasons).not.toContain('endpoint_outside_declared_scope');
  });

  it('counts terminal transfers as explained exclusions without making incremental coverage partial', async () => {
    const view = await addConnection({ exchange: 'cryptocom', apiKey: 'fixture-key', secret: 'fixture-secret' });
    await db.exchangeConnections.update(view.id, {
      cursors: {
        deposits: CRYPTOCOM_REPLAY_NOW - 60 * 86_400_000,
        withdrawals: CRYPTOCOM_REPLAY_NOW - 60 * 86_400_000,
        trades: CRYPTOCOM_REPLAY_NOW - 60 * 86_400_000
      }
    });
    installCryptocomFixtureServer(apiFetchMock, {
      tradeIds: ['90001'], depositStatuses: { '43': '2' }, withdrawalStatuses: { '44': '6' }
    });

    await syncConnection(view.id, { mode: 'commit' }, {}, cryptocomReplayDeps());
    const coverage = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).first())!;
    expect(coverage).toMatchObject({
      status: 'complete', recognizedCount: 5, parsedCount: 3, skippedCount: 0,
      excludedCount: 2, failedCount: 0, exclusionReasons: ['terminal_status_out_of_scope']
    });
    for (const endpoint of ['deposits', 'withdrawals']) expect(
      coverage.endpointOutcomes.find((outcome) => outcome.endpoint === endpoint)
    ).toMatchObject({
      status: 'complete', paginationExhausted: true, skippedCount: 0, excludedCount: 1,
      exclusionReasons: ['terminal_status_out_of_scope']
    });
    expect(evaluateSourceCoverage(coverage)).toMatchObject({ status: 'complete', reasons: [] });
  });

  it('keeps an unresolved active-spot trade as a failed partial normalization', async () => {
    const view = await addConnection({ exchange: 'cryptocom', apiKey: 'fixture-key', secret: 'fixture-secret' });
    await db.exchangeConnections.update(view.id, {
      cursors: {
        deposits: CRYPTOCOM_REPLAY_NOW - 60 * 86_400_000,
        withdrawals: CRYPTOCOM_REPLAY_NOW - 60 * 86_400_000,
        trades: CRYPTOCOM_REPLAY_NOW - 60 * 86_400_000
      }
    });
    installCryptocomFixtureServer(apiFetchMock, {
      tradeIds: ['90003'], depositIds: ['42'], withdrawalIds: ['42']
    });

    await syncConnection(view.id, { mode: 'commit' }, {}, cryptocomReplayDeps());
    const coverage = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).first())!;
    expect(coverage).toMatchObject({
      status: 'partial', recognizedCount: 3, parsedCount: 2, skippedCount: 1,
      excludedCount: 0, failedCount: 1, exclusionReasons: ['trade_normalization_failed']
    });
    expect(coverage.endpointOutcomes.find((outcome) => outcome.endpoint === 'trades')).toMatchObject({
      status: 'partial', paginationExhausted: false, skippedCount: 1, excludedCount: 0,
      failedCount: 1, exclusionReasons: ['trade_normalization_failed']
    });
    expect(evaluateSourceCoverage(coverage).status).toBe('partial');
  });

  it('scopes failed Crypto.com coverage to history endpoints through backup and evaluation', async () => {
    const view = await addConnection({ exchange: 'cryptocom', apiKey: 'fixture-key', secret: 'fixture-secret' });
    apiFetchMock.mockRejectedValue(new TypeError('fixture network unavailable'));

    await expect(syncConnection(view.id, { mode: 'commit' }, {}, cryptocomReplayDeps())).rejects.toThrow(
      /Nothing was saved/
    );
    const failed = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).first())!;
    expect(failed).toMatchObject({
      status: 'failed', failureKind: 'relay_unavailable', endpoints: ['deposits', 'withdrawals', 'trades']
    });
    expect(failed.endpointOutcomes.map((outcome) => outcome.endpoint)).toEqual([
      'deposits', 'withdrawals', 'trades'
    ]);
    expect(evaluateSourceCoverage(failed)).toMatchObject({ status: 'failed' });
    expect(evaluateSourceCoverage(failed).reasons).not.toContain('endpoint_outside_declared_scope');

    const payload = await createFullBackupPayload();
    await importFullBackup(backupFile(payload));
    const restored = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).first())!;
    expect(restored.endpointOutcomes.some((outcome) => outcome.endpoint === 'balance')).toBe(false);
    expect(evaluateSourceCoverage(restored).reasons).not.toContain('endpoint_outside_declared_scope');
  });

  it('replays signing/parsing, excludes derivatives/unsettled rows, and is API-idempotent', async () => {
    const view = await addConnection({ exchange: 'cryptocom', apiKey: 'fixture-key', secret: 'fixture-secret' });
    const result = await syncConnection(view.id, { mode: 'commit' }, {}, cryptocomReplayDeps());
    expect(result.mode).toBe('commit');
    if (result.mode !== 'commit') return;
    expect(result.outcome.imported).toBe(3);
    expect(result.outcome.warnings.join(' ')).toMatch(/derivative trade.*active spot/i);
    expect(result.outcome.warnings.join(' ')).toMatch(/trade.*active spot market could not be resolved/i);
    expect(result.outcome.warnings.join(' ')).toMatch(/180 days.*Exchange export.*App CSV/i);
    expect(result.outcome.warnings).not.toContain('History continues — sync again to fetch more.');

    const rows = await db.transactions.where('source').equals('cryptocom_api').toArray();
    expect(rows.map((row) => row.sourceRef).sort()).toEqual(['42', '42', '90001']);
    expect(rows.some((row) => row.sourceRef === '90002')).toBe(false);
    expect(await db.exchangeBalances.where('connectionId').equals(view.id).count()).toBe(0);
    expect(await db.authoritySnapshots.where('sourceIdentityId').equals(view.id).count()).toBe(0);
    const coverage = (await db.sourceCoverage.where('sourceIdentityId').equals(view.id).first())!;
    expect(coverage.endpoints).not.toContain('balance');
    expect(coverage.endpointOutcomes.some((outcome) => outcome.endpoint === 'balance')).toBe(false);
    const reconciled = reconcileHoldings(buildPortfolioHoldings(rows), rows, [], []);
    expect(reconciled.holdings.find((holding) => holding.asset === 'BTC')).toEqual(
      expect.objectContaining({ qtySource: 'tx-history' })
    );

    const originalKeys = new Map(rows.map((row) => [row.raw?.exchangeSyncKind, transactionExchangeKey(row)]));
    for (const row of rows) {
      const reclassified = row.raw?.exchangeSyncKind === 'trade'
        ? 'income'
        : row.raw?.exchangeSyncKind === 'deposit'
          ? 'gift_received'
          : 'fee';
      await db.transactions.update(row.id, { type: reclassified });
    }
    const reclassifiedRows = await db.transactions.where('source').equals('cryptocom_api').toArray();
    expect(new Map(reclassifiedRows.map((row) => [row.raw?.exchangeSyncKind, transactionExchangeKey(row)])))
      .toEqual(originalKeys);

    installCryptocomFixtureServer(apiFetchMock);
    const replay = await syncConnection(view.id, { mode: 'commit' }, {}, cryptocomReplayDeps());
    expect(replay.mode === 'commit' && replay.outcome.imported).toBe(0);
    expect(await db.transactions.where('source').equals('cryptocom_api').count()).toBe(3);
  });

  it('durably replays multiple pending transfers beyond the overlap, clears settled checkpoints, and ignores terminal rows', async () => {
    const view = await addConnection({ exchange: 'cryptocom', apiKey: 'fixture-key', secret: 'fixture-secret' });
    const firstStarts = { deposits: [] as number[], withdrawals: [] as number[] };
    installCryptocomFixtureServer(apiFetchMock, {
      depositStatuses: { '42': '0' },
      transferStarts: firstStarts
    });
    await syncConnection(view.id, { mode: 'commit' }, {}, cryptocomReplayDeps());
    const first = (await db.exchangeConnections.get(view.id))!;
    expect(first.cryptocomPendingTransfers).toEqual({
      deposits: 1_782_950_400_000,
      withdrawals: 1_783_036_801_000
    });
    expect(first.cursors).toMatchObject({ deposits: CRYPTOCOM_REPLAY_NOW, withdrawals: CRYPTOCOM_REPLAY_NOW });

    const payload = await createFullBackupPayload();
    await importFullBackup(backupFile(payload));
    expect((await db.exchangeConnections.get(view.id))?.cryptocomPendingTransfers).toEqual(
      first.cryptocomPendingTransfers
    );
    await db.exchangeConnections.update(view.id, {
      apiKey: 'fixture-key', secret: 'fixture-secret', credentialsState: 'ready'
    });

    const laterNow = CRYPTOCOM_REPLAY_NOW + 11 * 86_400_000;
    const secondStarts = { deposits: [] as number[], withdrawals: [] as number[] };
    installCryptocomFixtureServer(apiFetchMock, {
      depositStatuses: { '42': '1', '43': '1' },
      withdrawalStatuses: { '44': '6' },
      transferStarts: secondStarts
    });
    const second = await syncConnection(view.id, { mode: 'commit' }, {}, cryptocomReplayDeps(laterNow));
    expect(second.mode === 'commit' && second.outcome.imported).toBe(2);
    expect(secondStarts.deposits[0]).toBeLessThanOrEqual(1_782_950_400_000);
    expect(secondStarts.withdrawals[0]).toBeLessThanOrEqual(1_783_036_801_000);
    expect((await db.exchangeConnections.get(view.id))?.cryptocomPendingTransfers).toEqual({});
    const finalRows = await db.transactions.toArray();
    expect(finalRows.find((row) => row.sourceRef === '43')?.raw?.exchangeSyncKind).toBe('deposit');
    expect(finalRows.filter((row) => row.sourceRef === '44')).toHaveLength(0);
  });

  it('retains durable pending checkpoints when the physical request cap interrupts replay', async () => {
    const view = await addConnection({ exchange: 'cryptocom', apiKey: 'fixture-key', secret: 'fixture-secret' });
    installCryptocomFixtureServer(apiFetchMock, { depositStatuses: { '42': '0' } });
    await syncConnection(view.id, { mode: 'commit' }, {}, cryptocomReplayDeps());
    const pending = (await db.exchangeConnections.get(view.id))!.cryptocomPendingTransfers;

    installCryptocomFixtureServer(apiFetchMock);
    const capped = await syncConnection(view.id, { mode: 'commit' }, {}, {
      ...cryptocomReplayDeps(CRYPTOCOM_REPLAY_NOW + 11 * 86_400_000),
      cryptocomMaxRequests: 0
    });
    expect(capped.mode === 'commit' && capped.outcome.warnings)
      .toContain('History continues — sync again to fetch more.');
    expect((await db.exchangeConnections.get(view.id))?.cryptocomPendingTransfers).toEqual(pending);
  });
});
