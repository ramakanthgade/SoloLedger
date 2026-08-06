import { applyClassificationEvidence } from '@/lib/taxonomy/classification';
import { materializeImportedTransactionSafety } from '@/lib/safety/assetSafety';
import { assetSubjectKey, eventSubjectKey } from '@/lib/safety/canonicalAssets';
import { resolveOutboundInitiation } from '@/lib/safety/outboundInitiation';
import { runInternalTransferMatching } from '@/lib/internalTransfers/persistence';
import {
  clearAllData, commitCsvImportGeneration, commitWalletBalanceOperation, db, DEFAULT_SETTINGS,
  ensureAccountIdentity, reserveWalletBalanceOperation, saveSettings, setTransactionSafetyVisibility,
  updateAccountOwnership, upsertLookupAddress
} from '@/lib/storage/db';
import { walletAccountCanonicalKey } from '@/lib/accounts/accountIdentity';
import { addConnection } from '@/lib/exchangeSync/connections';
import { buildCsvImportEvidenceGeneration } from '@/lib/parsers/importEvidence';
import { commitPositionGeneration, reconcilePositionEvidence } from '@/lib/defi/positionReconcile';
import { normalizeMoralisPositions } from '@/lib/defi/moralisPositions';
import { commitWalletDefiRefreshManifest } from '@/lib/defi/positionAuthority';
import type { DefiPositionSnapshot } from '@/lib/defi/types';
import diagnosedWallet from '@/lib/defi/__fixtures__/diagnosed-wallet.sanitized.json';
import {
  B6_EVM_ADDRESS, B6_NOW, B6_SECOND_EVM_ADDRESS, B6_USDC,
  b6ClassificationEvidence, b6Transaction, b6TransferTransactions
} from './fixtures/b6Integrated';

export const B6_BROWSER_EXPECTED_NET_WORTH = 17_238_558.1435;

/** Seed real v16 stores; browser tests then consume only normal application entrypoints. */
export async function seedB6BrowserFixture(): Promise<void> {
  await clearAllData();
  const accountA = walletAccountCanonicalKey('ethereum', B6_EVM_ADDRESS);
  const accountB = walletAccountCanonicalKey('ethereum', B6_SECOND_EVM_ADDRESS);
  const metadataBalances = Array.from({ length: 41 }, (_, index) => ({
    asset: `META${index}`, contractAddress: `0x${String(index + 10).padStart(40, '0')}`, amount: 0
  }));
  const classified = applyClassificationEvidence(b6Transaction('b6-classified', {
    type: 'income', category: 'other', categoryOrigin: 'legacy', source: 'rpc:ethereum',
    sourceRef: 'moralis:event:ethereum:erc20:staking-reward:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:17',
    chain: 'ethereum', walletAddress: B6_EVM_ADDRESS, amount: 25, fiatValue: 25
  }), b6ClassificationEvidence, B6_NOW + 50);
  const safetyContracts = {
    spam: `0x${'9'.repeat(40)}`, unverified: `0x${'8'.repeat(40)}`,
    hidden: `0x${'7'.repeat(40)}`, visible: `0x${'6'.repeat(40)}`
  };
  const safetyTransaction = (
    id: string, contractAddress: string, index: number,
    evidenceId?: string
  ) => b6Transaction(id, {
    source: 'rpc:ethereum', chain: 'ethereum', walletAddress: B6_EVM_ADDRESS,
    txHash: `0x${String(index).repeat(64)}`, sourceRef: `moralis:event:ethereum:erc20:${index}`,
    amount: 0, fiatValue: 0, contractAddress,
    safetySubjectKey: eventSubjectKey({
      chain: 'ethereum', txHash: `0x${String(index).repeat(64)}`, contractAddress,
      eventIndex: index, direction: 'in'
    }),
    raw: evidenceId ? { safetyEvidence: [{
      id: evidenceId, provider: 'moralis', ruleId: 'possible_spam', ruleVersion: '1',
      confidence: 0.99, observedAt: B6_NOW + index
    }] } : undefined
  });
  const safetyInputs = [
    safetyTransaction('b6-safety-trusted', B6_USDC, 1),
    safetyTransaction('b6-safety-spam', safetyContracts.spam, 2, 'b6-spam-evidence'),
    safetyTransaction('b6-safety-unverified', safetyContracts.unverified, 3),
    safetyTransaction('b6-safety-hidden', safetyContracts.hidden, 4),
    safetyTransaction('b6-safety-visible', safetyContracts.visible, 5, 'b6-visible-evidence')
  ];
  const safety = materializeImportedTransactionSafety(safetyInputs);
  const assetEvidence = {
    id: 'b6-spam-asset-evidence', subjectKey: assetSubjectKey('ethereum', safetyContracts.spam),
    subjectKind: 'asset' as const, provider: 'moralis', ruleId: 'possible_spam', ruleVersion: '1',
    confidence: 0.99, observedAt: B6_NOW
  };
  const spoofed = { ...b6TransferTransactions.spoofedOut, source: 'rpc:ethereum', outboundInitiation: resolveOutboundInitiation({
    watchedAddress: B6_EVM_ADDRESS, transferFrom: B6_EVM_ADDRESS,
    topLevelSender: `0x${'f'.repeat(40)}`, initiatorAddress: `0x${'f'.repeat(40)}`
  }) };
  const transfers = Object.values(b6TransferTransactions).map((row) => ({ ...row, source: 'rpc:ethereum' }));
  const primaryEthereumRows = [...transfers, spoofed, classified, ...safety.transactions];
  const existingEthereumCount = new Set(primaryEthereumRows.map((row) => row.id)).size;
  // Two transfer fixture rows are intentionally excluded from collection activity
  // attribution; compensate so the indexed wallet evidence totals exactly 909.
  const ethereumActivity = Array.from({ length: 704 - existingEthereumCount }, (_, index) =>
    b6Transaction(`b6-wallet-ethereum-${index}`, {
      source: 'rpc:ethereum', chain: 'ethereum', walletAddress: B6_EVM_ADDRESS,
      timestamp: B6_NOW - index * 60_000, amount: 0, fiatValue: 0
    })
  );
  const polygonActivity = Array.from({ length: 207 }, (_, index) =>
    b6Transaction(`b6-wallet-polygon-${index}`, {
      source: 'rpc:polygon', chain: 'polygon', walletAddress: B6_EVM_ADDRESS,
      timestamp: B6_NOW - index * 60_000, amount: 0, fiatValue: 0
    })
  );
  const reserveActivity = b6Transaction('b6-reserve-wallet', {
    source: 'rpc:ethereum', chain: 'ethereum', walletAddress: B6_SECOND_EVM_ADDRESS,
    timestamp: B6_NOW - 30_000, amount: 0, fiatValue: 0
  });
  const now = Date.now();

  await saveSettings({ ...DEFAULT_SETTINGS, reportingCurrency: 'INR', priceApiEnabled: false });
  await upsertLookupAddress('ethereum', B6_EVM_ADDRESS, 0, undefined, { label: 'Diagnosed wallet', walletAppId: 'metamask' });
  await upsertLookupAddress('polygon', B6_EVM_ADDRESS, 0, undefined, { label: 'Diagnosed wallet', walletAppId: 'metamask' });
  await upsertLookupAddress('optimism', B6_EVM_ADDRESS, 0, undefined, { label: 'Diagnosed wallet', walletAppId: 'metamask' });
  await upsertLookupAddress('ethereum', B6_SECOND_EVM_ADDRESS, 0, undefined, { label: 'Reserve wallet', walletAppId: 'ledger' });
  await updateAccountOwnership(accountA, { status: 'owned', origin: 'user' }, undefined, B6_NOW);
  await updateAccountOwnership(accountB, { status: 'owned', origin: 'user' }, undefined, B6_NOW);

  const exchange = await addConnection({ exchange: 'binance', label: 'Primary Binance', apiKey: 'browser-fixture', secret: 'browser-fixture' });
  const exchangeRow = await db.exchangeConnections.get(exchange.id);
  if (!exchangeRow?.accountIdentityId) throw new Error('B6 exchange account was not committed');
  await updateAccountOwnership(exchangeRow.accountIdentityId, { status: 'owned', origin: 'user' }, undefined, B6_NOW);
  await db.exchangeConnections.update(exchange.id, { credentialsState: 'reauthorization_required' });

  await ensureAccountIdentity({
    kind: 'csv', canonicalKey: 'csv-account:b6-recurring', label: 'Recurring Binance CSV', parserId: 'binance'
  }, B6_NOW);
  await updateAccountOwnership('csv-account:b6-recurring', { status: 'owned', origin: 'user' }, undefined, B6_NOW);
  for (const [id, fileName, completedAt] of [
    ['b6-csv-2025', 'binance-2025.csv', B6_NOW],
    ['b6-csv-2026', 'binance-2026.csv', B6_NOW + 1]
  ] as const) {
    await commitCsvImportGeneration({
      id, fileName, parserId: 'binance', accountIdentityId: 'csv-account:b6-recurring', transactions: [], completedAt,
      buildGeneration: ({ generation, savedAfterDedup, savedTransactions }) => buildCsvImportEvidenceGeneration({
        sourceIdentityId: id, parserId: 'binance', parsedBeforeDedup: 0, savedAfterDedup, savedTransactions,
        completedAt, generation,
        evidence: {
          declaredHistory: { completeHistory: true }, coveredAccountClasses: ['spot'],
          requiredOutcomes: [{ id: 'history', accountClass: 'spot', required: true, status: 'complete', parsedCount: 0, parsedTransactionRows: [] }],
          recognizedCount: 0, parsedCount: 0, excludedCount: 0, skippedCount: 0, failedCount: 0,
          exclusionReasons: [], skippedReasons: [], failureReasons: []
        }
      })
    });
  }

  await db.transaction('rw', [db.transactions, db.providerEvidence, db.safetyDecisions, db.priceCache], async () => {
    await db.transactions.bulkPut([...primaryEthereumRows, ...ethereumActivity, ...polygonActivity, reserveActivity]);
    await db.providerEvidence.bulkPut([...safety.providerEvidence, assetEvidence]);
    await db.safetyDecisions.bulkPut(safety.automaticDecisions);
    await db.priceCache.bulkPut([
      ...Object.entries(diagnosedWallet.prices).map(([asset, price]) => {
        const contract = diagnosedWallet.protocolClaims.find((claim) => claim.asset === asset)!.underlyingContract;
        return { key: `spot:ctr:ethereum:${contract}:INR`, price, fetchedAt: now };
      })
    ]);
  });
  await setTransactionSafetyVisibility(safety.transactions.find((row) => row.id === 'b6-safety-hidden')!, false, B6_NOW + 10);
  await setTransactionSafetyVisibility(safety.transactions.find((row) => row.id === 'b6-safety-visible')!, true, B6_NOW + 11);

  const completeOutcomes = [
    { endpoint: 'balances', accountClass: 'wallet' as const, required: true, status: 'complete' as const, pages: 1, paginationExhausted: true }
  ];
  const historyOutcomes = ['incoming-history', 'outgoing-history'].map((endpoint) => ({
    endpoint, accountClass: 'wallet' as const, required: true, status: 'complete' as const,
    pages: 2, paginationRequired: true, paginationExhausted: true
  }));
  const primaryOperation = await reserveWalletBalanceOperation('ethereum', B6_EVM_ADDRESS, now - 1);
  const primaryCommitted = await commitWalletBalanceOperation({
    operation: primaryOperation, provider: 'b6-fixture', operationName: 'exhaustive-balances',
    rows: [
      ...diagnosedWallet.custody.map((row) => ({ asset: row.asset, contractAddress: row.contractAddress, amount: row.quantity })),
      { asset: 'SPAM-ASSET', contractAddress: safetyContracts.spam, amount: 0 },
      ...metadataBalances
    ], endpointOutcomes: completeOutcomes, historyEndpointOutcomes: historyOutcomes,
    status: 'complete', asOf: now, capturedAt: now
  });
  await db.sourceCoverage.put({
    id: `optimism:${B6_EVM_ADDRESS}:rpc-coverage:1`, generation: 1,
    scopeId: `wallet:evm:10:${B6_EVM_ADDRESS.toLowerCase()}`,
    sourceIdentityId: `optimism:${B6_EVM_ADDRESS}`, evidenceId: 'rpc:optimism:1', kind: 'rpc',
    accountClasses: ['wallet'], endpoints: ['asset-transfers'],
    startedAt: now - 2 * 60 * 60_000 - 1_000, completedAt: now - 2 * 60 * 60_000,
    status: 'partial', endpointOutcomes: [{
      endpoint: 'asset-transfers', accountClass: 'wallet', required: true, status: 'partial',
      warning: 'RPC rate limit'
    }], warnings: ['RPC rate limit']
  });
  if (!primaryCommitted) throw new Error('B6 primary custody authority was not committed');
  const primaryCustodySnapshotId = `${primaryOperation.sourceIdentityId}:rpc:${primaryOperation.generation}`;
  const reserveOperation = await reserveWalletBalanceOperation('ethereum', B6_SECOND_EVM_ADDRESS, now - 1);
  await commitWalletBalanceOperation({
    operation: reserveOperation, provider: 'b6-fixture', operationName: 'exhaustive-balances',
    rows: [{ asset: 'USDC', contractAddress: B6_USDC, amount: 0 }], endpointOutcomes: completeOutcomes,
    historyEndpointOutcomes: historyOutcomes, status: 'complete', asOf: now, capturedAt: now
  });

  const committedSnapshots: DefiPositionSnapshot[] = [];
  for (const protocolId of ['aave-v2-ethereum', 'aave-v3-ethereum', 'spark-v1-ethereum'] as const) {
    const claims = diagnosedWallet.protocolClaims.filter((claim) => claim.protocolId === protocolId);
    const moralis = normalizeMoralisPositions({
      complete: true,
      result: claims.map((claim) => ({
        position_type: claim.role === 'supply' ? 'lending' : 'borrowing',
        tokens: [{
          token_type: claim.role === 'supply' ? 'supply' : `${claim.debtRateMode}-debt`,
          contract_address: claim.underlyingContract,
          protocol_token_address: claim.protocolTokenContract,
          symbol: claim.asset,
          protocol_token_symbol: diagnosedWallet.custody.find((row) => row.contractAddress === claim.protocolTokenContract)?.asset,
          decimals: claim.decimals,
          balance: claim.rawQuantity,
          balance_formatted: String(claim.quantity),
          is_collateral: claim.isCollateral,
          rate_mode: claim.debtRateMode
        }]
      }))
    }, protocolId, now);
    if (moralis.status !== 'complete') throw new Error(`B6 ${protocolId} Moralis fixture was not complete`);
    const rpcResult = {
      status: 'complete' as const, chainId: 1 as const, protocolId, blockNumber: diagnosedWallet.blockNumber,
      rows: moralis.rows.map((row) => ({ ...row, id: `rpc:${row.id}`, valueEvidence: undefined })),
      evidence: [{ provider: 'ethereum-rpc' as const, status: 'complete' as const, blockNumber: diagnosedWallet.blockNumber, detail: 'sanitized diagnosed-wallet fixture' }],
      warnings: []
    };
    const reconciled = reconcilePositionEvidence(moralis, rpcResult);
    if (reconciled.status === 'unsupported') throw new Error('B6 Ethereum protocol unexpectedly unsupported');
    committedSnapshots.push(await commitPositionGeneration(db, B6_EVM_ADDRESS, reconciled, now));
  }
  const manifestCommitted = await commitWalletDefiRefreshManifest(
    B6_EVM_ADDRESS, primaryCustodySnapshotId, committedSnapshots, diagnosedWallet.blockNumber
  );
  if (!manifestCommitted) throw new Error('B6 coherent custody and position manifest was not committed');
  // Keep the chain-card presentation fixture at a stable two-hour sync age
  // without making the coherent custody/position generation itself stale.
  await db.sourceCoverage.where('sourceIdentityId').equals(`ethereum:${B6_EVM_ADDRESS}`).modify({
    startedAt: now - 2 * 60 * 60_000 - 1_000,
    completedAt: now - 2 * 60 * 60_000
  });
  await runInternalTransferMatching({ transactionIds: ['exact-out', 'exact-in', 'suggested-out', 'suggested-in', 'spoofed-out'] });
}
