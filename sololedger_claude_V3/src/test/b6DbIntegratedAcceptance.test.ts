import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedB6BrowserFixture } from './b6BrowserSeed';
import { db, claimAccountOwnershipPrompt } from '@/lib/storage/db';
import { collectSequentialCursor } from '@/lib/rpc/pagination';
import { createFullBackupPayload } from '@/lib/storage/backup';
import { buildSourcePresentationIndexes, sourcePresentationForTransaction } from '@/lib/sources/sourcePresentation';
import { buildReviewSourceFilterOptions } from '@/components/review/reviewSourceFilters';
import { txFlow } from '@/components/review/rowAnatomy';
import { createHoldingsProjector, createTransactionViewsProjector } from '@/components/dashboard/dashboardProjectionCache';
import { createCoherentDashboardLedgerPublisher, readDashboardHoldingsSnapshot } from '@/components/dashboard/dashboardHoldingsSnapshot';
import { buildCards } from '@/components/connections/connectionModel';
import { buildConnectionWorkspaceFromCard } from '@/components/connections/connectionWorkspaceModel';
import { resolveTaxPolicy } from '@/lib/taxonomy/taxPolicy';
import { TEST_TAX_SETTINGS } from './taxSettings';
import {
  B6_EVM_ADDRESS, B6_USDC, B6_WBTC
} from './fixtures/b6Integrated';
import { safetySubjectKind } from '@/lib/safety/canonicalAssets';
import diagnosedWallet from '@/lib/defi/__fixtures__/diagnosed-wallet.sanitized.json';
import { projectManifestSelectedWalletDefi } from '@/lib/portfolio/walletDefiProjection';

describe('B6 database-backed integrated acceptance', () => {
  beforeEach(async () => {
    await seedB6BrowserFixture();
  });

  it('persists exhaustive authority, safety, ownership reuse, pairing, classification and backup evidence', async () => {
    const paged = await collectSequentialCursor({
      fetchPage: async (cursor?: string) => cursor == null
        ? { items: Array.from({ length: 25 }, (_, id) => ({ id })), nextCursor: 'page-2' }
        : { items: Array.from({ length: 20 }, (_, offset) => ({ id: offset + 25 })) },
      itemKey: (row) => String(row.id)
    });
    expect(paged.items).toHaveLength(45);
    expect(paged.evidence).toMatchObject({ status: 'complete', paginationExhausted: true, pages: 2 });
    expect(await db.authorityAssets.count()).toBeGreaterThan(40);
    const walletAuthority = await db.authoritySnapshots.where('sourceIdentityId')
      .equals(`ethereum:${B6_EVM_ADDRESS}`).filter((row) => row.status === 'complete').first();
    if (!walletAuthority) throw new Error('B6 primary exhaustive authority was not committed');
    if (walletAuthority.asOf == null) throw new Error('B6 primary exhaustive authority has no observation time');
    expect(walletAuthority?.endpointProof).toMatchObject({ provider: 'b6-fixture', exhaustiveBalances: true });
    expect(Date.now() - walletAuthority.asOf).toBeLessThan(24 * 60 * 60 * 1_000);
    const walletAuthorityAssets = await db.authorityAssets.where('snapshotId').equals(walletAuthority.snapshotId).toArray();
    expect(walletAuthorityAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({ assetKey: `evm:1:${B6_USDC}`, quantity: 93_076.497 }),
      expect.objectContaining({ assetKey: `evm:1:${B6_WBTC}`, quantity: 0 }),
      ...diagnosedWallet.custody.filter((row) => ![B6_USDC, B6_WBTC].includes(row.contractAddress)).map((row) =>
        expect.objectContaining({ assetKey: `evm:1:${row.contractAddress}`, quantity: row.quantity }))
    ]));
    expect((await db.sourceCoverage.where('sourceIdentityId').equals(`ethereum:${B6_EVM_ADDRESS}`).first())?.endpointOutcomes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ endpoint: 'incoming-history', paginationExhausted: true })]));
    expect((await db.defiPositionRows.where('reserveKey').equals(B6_WBTC).toArray()).map((row) => row.protocolId))
      .toEqual(['spark-v1-ethereum']);
    const positionSnapshots = await db.defiPositionSnapshots
      .where('accountIdentityScope').equals(`wallet:evm:${B6_EVM_ADDRESS}`).toArray();
    expect(positionSnapshots).toHaveLength(3);
    expect(positionSnapshots.map((row) => row.protocolId).sort()).toEqual([
      'aave-v2-ethereum', 'aave-v3-ethereum', 'spark-v1-ethereum'
    ]);
    expect(positionSnapshots.every((row) => row.status === 'complete' && row.blockNumber === diagnosedWallet.blockNumber))
      .toBe(true);
    const aaveV2 = positionSnapshots.find((row) => row.protocolId === 'aave-v2-ethereum')!;
    expect(await db.defiPositionRows.where('snapshotId').equals(aaveV2.snapshotId).count()).toBe(0);
    const positionRows = await db.defiPositionRows.toArray();
    for (const claim of diagnosedWallet.protocolClaims) {
      expect(positionRows).toContainEqual(expect.objectContaining({
        protocolId: claim.protocolId,
        reserveKey: claim.underlyingContract,
        role: claim.role,
        quantity: claim.quantity,
        rawQuantity: claim.rawQuantity,
        underlying: expect.objectContaining({ decimals: claim.decimals }),
        protocolToken: expect.objectContaining({ contractAddress: claim.protocolTokenContract, decimals: claim.decimals }),
        ...(claim.role === 'debt' ? { debtRateMode: claim.debtRateMode } : { isCollateral: true })
      }));
    }
    expect(positionRows.filter((row) => row.role === 'debt').map((row) => row.debtRateMode).sort())
      .toEqual(['stable', 'variable']);
    const manifest = await db.walletDefiRefreshManifests.get(`wallet:evm:${B6_EVM_ADDRESS}`);
    expect(manifest).toMatchObject({
      custodySnapshotId: walletAuthority.snapshotId,
      custodyGeneration: walletAuthority.generation,
      custodyAsOf: walletAuthority.asOf,
      blockNumber: diagnosedWallet.blockNumber,
      protocolSnapshotIds: Object.fromEntries(positionSnapshots.map((row) => [row.protocolId, row.snapshotId]))
    });

    const custody = diagnosedWallet.custody.map((row) => ({
      id: row.id,
      scopeId: walletAuthority.scopeId,
      chainId: 1,
      contractAddress: row.contractAddress,
      symbol: row.asset,
      quantity: row.quantity,
      value: row.quantity * (diagnosedWallet.prices[row.asset as keyof typeof diagnosedWallet.prices] ?? 0)
    }));
    const projection = projectManifestSelectedWalletDefi({
      custody,
      snapshots: positionSnapshots,
      rows: positionRows,
      custodyAuthoritySnapshots: [walletAuthority],
      refreshManifests: [manifest!],
      prices: new Map(diagnosedWallet.protocolClaims.map((claim) => [
        claim.underlyingContract, diagnosedWallet.prices[claim.asset as keyof typeof diagnosedWallet.prices]
      ])),
      reportingCurrency: 'INR',
      enabled: true
    }).projection;
    expect(projection).toMatchObject({ status: 'complete', netWorth: 17_238_558.1435 });
    expect(projection.assets.filter((row) => row.kind === 'supply').map((row) => [row.symbol, row.quantity]))
      .toEqual(expect.arrayContaining([['WBTC', 1.4975], ['USDC', 15_004.031], ['WETH', 2.5]]));
    expect(projection.liabilities.map((row) => [row.debtRateMode, row.quantity]))
      .toEqual(expect.arrayContaining([['stable', 4_000], ['variable', 10_500.25]]));
    expect(projection.assets.some((row) => row.quantity > 0 && /^aEth|^spWBTC|.*DebtUSDC/i.test(row.symbol))).toBe(false);

    const safetyTransactions = await db.transactions.where('id').startsWith('b6-safety-').toArray();
    expect(safetyTransactions.map((row) => row.safetyState)).toEqual(expect.arrayContaining([
      'trusted', 'high_confidence_spam', 'unverified', 'user_hidden', 'user_visible'
    ]));
    const decisions = await db.safetyDecisions.toArray();
    const evidence = await db.providerEvidence.toArray();
    const transactionSubjects = new Set(safetyTransactions.map((row) => row.safetySubjectKey));
    const authorityAssetSubjects = new Set((await db.authorityAssets.toArray())
      .filter((row) => row.assetKey.startsWith('evm:1:'))
      .map((row) => `asset:ethereum:${row.assetKey.slice('evm:1:'.length)}`));
    expect([...decisions, ...evidence].every((row) => safetySubjectKind(row.subjectKey) != null)).toBe(true);
    expect(decisions.every((row) => transactionSubjects.has(row.subjectKey) || authorityAssetSubjects.has(row.subjectKey))).toBe(true);
    expect(decisions.filter((row) => row.origin === 'automatic').every((decision) =>
      decision.evidenceIds?.every((id) => evidence.some((row) => row.id === id && row.subjectKey === decision.subjectKey))))
      .toBe(true);
    expect(evidence.find((row) => row.id === 'b6-spam-asset-evidence')?.subjectKey)
      .toBe(`asset:ethereum:${'9'.repeat(40).padStart(42, '0x')}`);
    expect((await db.transactions.get('spoofed-out'))?.outboundInitiation).toBe('spoofed_outbound_log');
    expect((await db.transactions.get('exact-out'))).toMatchObject({ internalTransferDecision: 'confirmed', isInternalTransfer: true });
    expect((await db.transactions.get('suggested-out'))).toMatchObject({ internalTransferDecision: 'suggested', isInternalTransfer: false });
    expect((await db.transactions.get('b6-classified'))).toMatchObject({ category: 'staking_reward', categoryOrigin: 'provider' });

    const accountId = `wallet:evm:${B6_EVM_ADDRESS}`;
    expect((await claimAccountOwnershipPrompt(accountId, Date.now())).claimed).toBe(false);
    expect((await db.lookupAddresses.where('accountIdentityId').equals(accountId).toArray()).map((row) => row.chain).sort())
      .toEqual(['ethereum', 'optimism', 'polygon']);
    expect((await db.csvImports.toArray()).map((row) => row.accountIdentityId)).toEqual([
      'csv-account:b6-recurring', 'csv-account:b6-recurring'
    ]);
    expect((await db.csvImports.toArray()).every((row) => row.authorityGeneration === 1 && row.revision === 1)).toBe(true);
    expect((await db.exchangeConnections.toArray())[0]?.accountIdentityId).toMatch(/^exchange:/);

    const backup = await createFullBackupPayload();
    expect(backup).toMatchObject({ formatVersion: 6 });
    expect(backup.accountIdentities.some((row) => row.ownershipStatus === 'owned')).toBe(true);
    expect(backup.safetyDecisions.some((row) => row.state === 'user_visible')).toBe(true);
    expect(backup.transactions.some((row) => row.internalTransferDecision === 'confirmed')).toBe(true);
    expect(backup.transactions.some((row) => row.category === 'staking_reward')).toBe(true);
  });

  it('routes persisted rows through source/row, Dashboard, Connections, and policy entrypoints', async () => {
    const [transactions, accounts, wallets, exchanges, csvImports, snapshot] = await Promise.all([
      db.transactions.toArray(), db.accountIdentities.toArray(), db.lookupAddresses.toArray(),
      db.exchangeConnections.toArray(), db.csvImports.toArray(), readDashboardHoldingsSnapshot()
    ]);
    const indexes = buildSourcePresentationIndexes({ accounts, wallets, exchanges, csvImports });
    const presentations = new Map(transactions.map((row) => [row.id, sourcePresentationForTransaction(row, indexes)]));
    expect(presentations.get('b6-classified')).toMatchObject({ primaryLabel: 'Diagnosed wallet', iconId: 'metamask', status: 'resolved' });
    expect(buildReviewSourceFilterOptions(transactions, presentations).some((option) => option.label.includes('Diagnosed wallet'))).toBe(true);
    expect(txFlow(transactions.find((row) => row.id === 'exact-out')!, { assetLabel: 'USDC', toAddr: B6_EVM_ADDRESS }).sent)
      .toMatchObject({ symbol: 'USDC', sign: '−' });

    const projectTransactions = createTransactionViewsProjector();
    const views = projectTransactions(transactions);
    const dashboard = createCoherentDashboardLedgerPublisher(createHoldingsProjector())({
      ledgerTransactions: transactions, transactionViews: views, snapshot,
      projectionInput: {
        transactions: views.projection, exchangeConnections: snapshot.exchangeConnections,
        openingBalances: snapshot.openingBalances, snapshots: snapshot.authoritySnapshots,
        assets: snapshot.authorityAssets, coverage: snapshot.sourceCoverage,
        safetyDecisions: snapshot.safetyDecisions, now: Date.now()
      }
    });
    expect(dashboard?.projection.slices.some((row) => row.asset === 'USDC' && row.quantity === 93_076.497 &&
      row.authorityQuantity === 93_076.497 && row.verificationStatus === 'verified_authority')).toBe(true);

    const cards = buildCards({ connections: [], csvImports, wallets, manualCount: 0, syncingConnectionId: null, syncActive: false });
    const walletCard = cards.find((card) => card.kind === 'wallet' && card.walletRows?.some((row) => row.address === B6_EVM_ADDRESS));
    expect(walletCard).toBeDefined();
    const connection = buildConnectionWorkspaceFromCard({
      card: walletCard!, transactions, exchangeConnections: [], openingBalances: snapshot.openingBalances,
      snapshots: snapshot.authoritySnapshots, assets: snapshot.authorityAssets,
      sourceCoverage: snapshot.sourceCoverage, safetyDecisions: snapshot.safetyDecisions,
      now: Date.now(), liveExchangeConnections: [], liveCsvImports: csvImports, liveWalletRows: wallets
    });
    expect(connection.overview.slices.some((row) => row.asset === 'USDC' && row.quantity === 93_076.497 &&
      row.authorityQuantity === 93_076.497 && row.verificationStatus === 'verified_authority')).toBe(true);

    const classified = transactions.find((row) => row.id === 'b6-classified')!;
    for (const jurisdiction of ['IN', 'US', 'CA', 'AE'] as const) {
      expect(resolveTaxPolicy({ kind: 'transaction', transaction: classified, settings: { ...TEST_TAX_SETTINGS, jurisdiction } }))
        .toMatchObject({ treatment: 'income', jurisdiction });
    }
  });
});
