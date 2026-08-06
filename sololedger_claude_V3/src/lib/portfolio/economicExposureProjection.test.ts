import { describe, expect, it, vi } from 'vitest';
import {
  projectEconomicExposure as projectEconomicExposureWithCurrency,
  projectLegacyWalletNetWorth,
  projectScopedEconomicExposure as projectScopedEconomicExposureWithCurrency,
  projectWalletDefiNetWorth as projectWalletDefiNetWorthWithCurrency,
  storeWalletDefiNetWorthShadow,
  WALLET_DEFI_SHADOW_STORAGE_KEY
} from './economicExposureProjection';
import { canonicalDefiAccountScope, type DefiPositionRow, type DefiPositionSnapshot } from '@/lib/defi/types';
import diagnosedWallet from '@/lib/defi/__fixtures__/diagnosed-wallet.sanitized.json';
import { reaggregateUnreplacedCustody } from '@/components/dashboard/dashboardEconomicRows';

const U = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const A = '0xbcca60bb61934080951369a648fb03df4f96263c';
const D = '0x72e95b8931767c79bA4Ee721E2dFD084399483DA'.toLowerCase();
const snapshot = { snapshotId: 's', generation: 1, accountIdentityScope: `wallet:evm:0x${'1'.repeat(40)}`, protocolId: 'aave-v3-ethereum', chainId: 1, status: 'complete', capturedAt: 1, blockNumber: 1, evidence: [{ provider: 'ethereum-rpc', status: 'complete', blockNumber: 1, detail: 'fixture' }] } satisfies DefiPositionSnapshot;
const base = { snapshotId: 's', protocolId: 'aave-v3-ethereum' as const, reserveKey: U, underlying: { chainId: 1 as const, contractAddress: U, symbol: 'USDC', decimals: 6 } };
const rows: DefiPositionRow[] = [
  { ...base, id: 'supply', role: 'supply', protocolToken: { chainId: 1, contractAddress: A, symbol: 'aUSDC', decimals: 6 }, quantity: 100, rawQuantity: '100000000', isCollateral: true },
  { ...base, id: 'debt', role: 'debt', protocolToken: { chainId: 1, contractAddress: D, symbol: 'variableDebtUSDC', decimals: 6 }, quantity: 90, rawQuantity: '90000000', debtRateMode: 'variable' }
];
const custody = [
  { id: 'liquid', chainId: 1, contractAddress: U, symbol: 'USDC', quantity: 93_076, value: 93_076 },
  { id: 'receipt', chainId: 1, contractAddress: A, symbol: 'aUSDC', quantity: 100, value: 100 },
  { id: 'debtToken', chainId: 1, contractAddress: D, symbol: 'variableDebtUSDC', quantity: 90, value: 0 }
];
type EconomicInput = Omit<Parameters<typeof projectEconomicExposureWithCurrency>[0], 'reportingCurrency'>;
type ScopedInput = Omit<Parameters<typeof projectScopedEconomicExposureWithCurrency>[0], 'reportingCurrency'>;
type WalletInput = Omit<Parameters<typeof projectWalletDefiNetWorthWithCurrency>[0], 'reportingCurrency'>;
const projectEconomicExposure = (input: EconomicInput) => projectEconomicExposureWithCurrency({ now: 1, ...input, reportingCurrency: 'USD' });
const authorityFor = (scopeId: string, snapshotId = 'custody-snapshot', generation = 1, capturedAt = 1) => ({
  snapshotId, generation, scopeId, authorityKind: 'rpc' as const, authorityClass: 'wallet_balance' as const,
  accountClass: 'wallet' as const, coveredAccountClasses: ['wallet' as const], capturedAt, asOf: capturedAt,
  sourceIdentityId: 'wallet', endpointProof: { authorityKind: 'rpc' as const, provider: 'fixture', operation: 'fixture', parametersClass: 'fixture', requestedAccountClasses: ['wallet' as const], provenAccountClasses: ['wallet' as const], exhaustiveBalances: true }, status: 'complete' as const
});
const manifestsFor = (input: ScopedInput) => [...new Set(input.snapshots.map((row) => canonicalDefiAccountScope(row.accountIdentityScope)))].map((scope) => ({
  ...(() => {
    const capturedAt = Math.max(...input.snapshots.filter((row) => canonicalDefiAccountScope(row.accountIdentityScope) === scope).map((row) => row.capturedAt));
    return { custodyAsOf: capturedAt, capturedAt };
  })(),
  accountIdentityScope: scope, custodyScopeId: scope, custodySnapshotId: 'custody-snapshot', custodyGeneration: 1,
  blockNumber: input.snapshots.find((row) => canonicalDefiAccountScope(row.accountIdentityScope) === scope)?.blockNumber ?? 1,
  protocolSnapshotIds: Object.fromEntries(['aave-v2-ethereum', 'aave-v3-ethereum', 'spark-v1-ethereum'].map((protocolId) => [
    protocolId, input.snapshots.find((row) => canonicalDefiAccountScope(row.accountIdentityScope) === scope && row.protocolId === protocolId)?.snapshotId ?? `empty-${protocolId}`
  ])) as Record<DefiPositionSnapshot['protocolId'], string>
}));
const completeFamilies = (input: ScopedInput) => {
  const scopes = [...new Set(input.snapshots.map((row) => canonicalDefiAccountScope(row.accountIdentityScope)))];
  return [...input.snapshots, ...scopes.flatMap((scope) => ['aave-v2-ethereum', 'aave-v3-ethereum', 'spark-v1-ethereum'].flatMap((protocolId) =>
    input.snapshots.some((row) => canonicalDefiAccountScope(row.accountIdentityScope) === scope && row.protocolId === protocolId) ? [] : (() => {
      const template = input.snapshots.find((row) => canonicalDefiAccountScope(row.accountIdentityScope) === scope) ?? snapshot;
      return [{ ...template, snapshotId: `empty-${protocolId}`, accountIdentityScope: scope, protocolId: protocolId as DefiPositionSnapshot['protocolId'] }];
    })()))];
};
const projectScopedEconomicExposure = (input: ScopedInput) => {
  const snapshots = completeFamilies(input);
  const enriched = { ...input, snapshots };
  const manifests = manifestsFor(enriched);
  return projectScopedEconomicExposureWithCurrency({
    ...enriched,
    custodyAuthoritySnapshots: manifests.map((manifest) => authorityFor(manifest.custodyScopeId, 'custody-snapshot', 1, manifest.custodyAsOf)),
    refreshManifests: manifests,
    reportingCurrency: 'USD', now: manifests[0]?.capturedAt ?? 1
  });
};
const projectWalletDefiNetWorth = (input: WalletInput) => {
  const snapshots = completeFamilies(input);
  const enriched = { ...input, snapshots };
  const manifests = manifestsFor(enriched);
  return projectWalletDefiNetWorthWithCurrency({
    ...enriched, custodyAuthoritySnapshots: manifests.map((manifest) => authorityFor(manifest.custodyScopeId, 'custody-snapshot', 1, manifest.custodyAsOf)),
    refreshManifests: manifests, reportingCurrency: 'USD', now: manifests[0]?.capturedAt ?? 1
  });
};

describe('economic exposure projection', () => {
  it('shadows DeFi arithmetic and falls back to raw custody when killed', () => {
    const scopedCustody = custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope }));
    const enabled = projectWalletDefiNetWorth({ custody: scopedCustody, snapshots: [snapshot], rows, prices: new Map([[U, 1]]), enabled: true });
    const killed = projectWalletDefiNetWorth({ custody: scopedCustody, snapshots: [snapshot], rows, prices: new Map([[U, 1]]), enabled: false });
    expect(enabled).toMatchObject({ legacyNetWorth: 93_176, defiNetWorth: 93_086, difference: -90, featureEnabled: true });
    expect(enabled.projection.netWorth).toBe(93_086);
    expect(killed.projection).toMatchObject({ netWorth: 93_176, liabilities: [], retainedCustody: scopedCustody });
    expect(projectLegacyWalletNetWorth(scopedCustody)).toEqual(killed.projection);
    expect(killed.defiNetWorth).toBe(93_086);
  });
  it('stores the disabled shadow locally without wallet or position evidence', () => {
    const shadow = projectWalletDefiNetWorth({
      custody: custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope })),
      snapshots: [snapshot], rows, prices: new Map([[U, 1]]), enabled: false
    });
    const setItem = vi.fn();
    storeWalletDefiNetWorthShadow(shadow, { setItem }, 123);
    expect(setItem).toHaveBeenCalledWith(WALLET_DEFI_SHADOW_STORAGE_KEY, expect.any(String));
    const stored = JSON.parse(setItem.mock.calls[0][1]);
    expect(stored).toMatchObject({ version: 1, observedAt: 123, featureEnabled: false, difference: -90 });
    expect(JSON.stringify(stored)).not.toContain(snapshot.accountIdentityScope);
    expect(stored).not.toHaveProperty('rows');
  });
  it('keeps an unpriced-liability candidate shadow-only when the rollout is disabled', () => {
    const pricedSupply = { ...rows[0], valueEvidence: { currency: 'USD' as const, value: 100, observedAt: 1, provider: 'fixture' } };
    const output = projectWalletDefiNetWorth({
      custody: custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope })),
      snapshots: [snapshot], rows: [pricedSupply, rows[1]], enabled: false
    });
    expect(output.featureEnabled).toBe(false);
    expect(output.defiNetWorth).toBeNull();
    expect(output.projection).toMatchObject({ netWorth: 93_176, liabilities: [], status: 'complete' });
  });
  it('preserves the legacy known-value total when an unpriced custody asset is disclosed', () => {
    const unpriced = { id: 'unpriced', chainId: 0, symbol: 'XYZ', quantity: 5, value: null };
    const output = projectWalletDefiNetWorth({
      custody: [...custody, unpriced], snapshots: [], rows: [], enabled: false
    });
    expect(output.projection).toMatchObject({
      netWorth: 93_176,
      hasUnpricedValues: true,
      hasUnpricedLiabilities: false,
      status: 'partial'
    });
    expect(output.projection.assets).toContainEqual(expect.objectContaining(unpriced));
  });
  it('fails closed when an EVM wallet has no protocol refresh evidence', () => {
    const output = projectWalletDefiNetWorthWithCurrency({
      custody: custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope })),
      snapshots: [], rows: [], enabled: true, reportingCurrency: 'USD'
    });
    expect(output.projection).toMatchObject({ status: 'partial', netWorth: 93_176, liabilities: [] });
  });
  it('keeps liquid, replaces exact protocol tokens, and subtracts positive debt once', () => {
    const output = projectEconomicExposure({ custody, snapshot, rows, prices: new Map([[U, 1]]) });
    expect(output.assets.map((row) => row.id)).toEqual(['liquid', 'supply']);
    expect(output.liabilities).toEqual([expect.objectContaining({ quantity: 90, contribution: -90 })]);
    expect(output.netWorth).toBe(93_086);
  });
  it('partial debt can lower but never increase net worth and raw custody remains', () => {
    const partial = projectEconomicExposure({ custody, rows: [], latestPartialRows: [rows[1]], prices: new Map([[U, 1]]) });
    expect(partial.assets).toHaveLength(3);
    expect(partial.netWorth).toBe(93_086); // 93,176 valued custody - 90 known liability
    expect(partial.retainedCustody).toEqual(custody);
  });
  it('a newer partial generation cannot reduce debt retained by a stale complete snapshot', () => {
    const stale = projectEconomicExposure({
      custody, snapshot: { ...snapshot, restoredAt: 2 }, rows,
      latestPartialRows: [{ ...rows[1], id: 'newer-debt', quantity: 95, rawQuantity: '95000000' }],
      prices: new Map([[U, 1]])
    });
    expect(stale.status).toBe('stale');
    expect(stale.liabilities).toEqual([expect.objectContaining({ quantity: 95, contribution: -95 })]);
    expect(stale.netWorth).toBe(93_081);
  });
  it('unsupported retains custody and cannot claim complete look-through', () => {
    const output = projectEconomicExposure({ custody, rows: [], unsupported: true });
    expect(output.status).toBe('unsupported');
    expect(output.assets).toHaveLength(3);
  });
  it('is isolated from historical transaction, posting, lot, gain, and tax facts', () => {
    const historicalFacts = Object.freeze({ transactions: Object.freeze([{ id: 'tx-1', amount: 1 }]), postings: Object.freeze([{ id: 'p-1', quantity: -1 }]), lots: Object.freeze([{ id: 'lot-1', remaining: 1 }]), gains: Object.freeze([{ id: 'gain-1', value: 5 }]), tax: Object.freeze({ taxable: true }) });
    const before = JSON.stringify(historicalFacts);
    projectEconomicExposure({ custody, snapshot, rows, prices: new Map([[U, 1]]) });
    expect(JSON.stringify(historicalFacts)).toBe(before);
  });
  it('projects each wallet scope once so liquid assets are preserved without cross-account receipt replacement', () => {
    const otherScope = `wallet:evm:0x${'2'.repeat(40)}`;
    const output = projectScopedEconomicExposure({
      custody: [
        { ...custody[0], id: 'liquid-a', scopeId: snapshot.accountIdentityScope },
        { ...custody[1], id: 'receipt-a', scopeId: snapshot.accountIdentityScope },
        { ...custody[1], id: 'receipt-other', scopeId: otherScope, value: 50, quantity: 50 }
      ],
      snapshots: [snapshot], rows, prices: new Map([[U, 1]])
    });
    expect(output.assets.map((item) => item.id)).toEqual(['liquid-a', 'supply', 'receipt-other']);
    expect(output.netWorth).toBe(93_136);
  });
  it('joins real chain-scoped wallet authority to canonical DeFi scope', () => {
    const output = projectScopedEconomicExposure({
      custody: custody.map((row) => ({ ...row, scopeId: `wallet:evm:1:0x${'1'.repeat(40)}` })),
      snapshots: [snapshot], rows, prices: new Map([[U, 1]])
    });
    expect(output.assets.map((row) => row.id)).toEqual(['liquid', 'supply']);
    expect(output.netWorth).toBe(93_086);
  });
  it('does not replace custody without current wallet authority or coherent same-block protocol evidence', () => {
    const spark = {
      ...snapshot, snapshotId: 'spark', protocolId: 'spark-v1-ethereum' as const,
      blockNumber: 2, evidence: [{ provider: 'ethereum-rpc' as const, status: 'complete' as const, blockNumber: 2, detail: 'different block' }]
    };
    const sparkDebt = { ...rows[1], id: 'spark-debt', snapshotId: 'spark', protocolId: 'spark-v1-ethereum' as const, quantity: 95 };
    const noCustodyAuthority = projectScopedEconomicExposureWithCurrency({
      custody: custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope })),
      snapshots: [snapshot], rows, prices: new Map([[U, 1]]), reportingCurrency: 'USD'
    });
    expect(noCustodyAuthority).toMatchObject({ status: 'partial', netWorth: 93_086 });
    expect(noCustodyAuthority.assets.map((row) => row.id)).toEqual(['liquid', 'receipt', 'debtToken']);

    const incoherent = projectScopedEconomicExposure({
      custody: custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope })),
      snapshots: [snapshot, spark], rows: [...rows, sparkDebt], prices: new Map([[U, 1]])
    });
    expect(incoherent.status).toBe('partial');
    expect(incoherent.assets.map((row) => row.id)).toEqual(['liquid', 'receipt', 'debtToken']);
    expect(incoherent.liabilities.map((row) => row.quantity).sort((a, b) => a - b)).toEqual([90, 95]);
    expect(incoherent.netWorth).toBe(92_991);
  });
  it('requires a manifest-bound latest generation for every required family, including empty families', () => {
    const scopedCustody = custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope }));
    const allFamilies = completeFamilies({ custody: scopedCustody, snapshots: [snapshot], rows, prices: new Map([[U, 1]]) });
    const manifest = manifestsFor({ custody: scopedCustody, snapshots: allFamilies, rows, prices: new Map([[U, 1]]) });
    const common = {
      custody: scopedCustody, rows, prices: new Map([[U, 1]]), reportingCurrency: 'USD',
      custodyAuthoritySnapshots: [authorityFor(snapshot.accountIdentityScope)], refreshManifests: manifest, now: 1
    };

    expect(projectScopedEconomicExposureWithCurrency({ ...common, snapshots: allFamilies }).status).toBe('complete');
    expect(projectScopedEconomicExposureWithCurrency({
      ...common, snapshots: allFamilies.filter((row) => row.protocolId !== 'aave-v2-ethereum')
    })).toMatchObject({ status: 'partial', netWorth: 93_086 });

    const newer = { ...snapshot, snapshotId: 'newer-v3', generation: 2 };
    expect(projectScopedEconomicExposureWithCurrency({
      ...common, snapshots: [...allFamilies, newer]
    })).toMatchObject({ status: 'partial', netWorth: 93_086 });
  });
  it('retains the maximum exact debt across prior complete and mid-refresh provider disagreement', () => {
    const scopedCustody = custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope }));
    const completeRows = [rows[1]];
    const completeFamiliesRows = completeFamilies({
      custody: scopedCustody, snapshots: [snapshot], rows: completeRows, prices: new Map([[U, 1]])
    });
    const manifest = manifestsFor({
      custody: scopedCustody, snapshots: completeFamiliesRows, rows: completeRows, prices: new Map([[U, 1]])
    });
    const partial = {
      ...snapshot, snapshotId: 'v3-mid-refresh', generation: 2, status: 'partial' as const,
      evidence: [
        { provider: 'moralis' as const, status: 'complete' as const, detail: 'disagreed' },
        { provider: 'ethereum-rpc' as const, status: 'complete' as const, blockNumber: 1, detail: 'disagreed' }
      ]
    };
    const partialRows = [
      { ...rows[1], id: 'rpc-debt', snapshotId: partial.snapshotId, quantity: 110 },
      { ...rows[1], id: 'moralis-debt', snapshotId: partial.snapshotId, quantity: 120 }
    ];
    const output = projectScopedEconomicExposureWithCurrency({
      custody: scopedCustody, snapshots: [...completeFamiliesRows, partial], rows: [...completeRows, ...partialRows],
      prices: new Map([[U, 1]]), reportingCurrency: 'USD',
      custodyAuthoritySnapshots: [authorityFor(snapshot.accountIdentityScope)], refreshManifests: manifest
    });
    expect(output.status).toBe('partial');
    expect(output.liabilities).toEqual([expect.objectContaining({ quantity: 120, debtRateMode: 'variable' })]);
    expect(output.netWorth).toBe(93_056);
  });
  it('ratchets debt across every consecutive unresolved post-manifest generation', () => {
    const scopedCustody = custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope }));
    const manifestSnapshots = completeFamilies({ custody: scopedCustody, snapshots: [snapshot], rows: [rows[1]] });
    const manifest = manifestsFor({ custody: scopedCustody, snapshots: manifestSnapshots, rows: [rows[1]] });
    const partial2 = { ...snapshot, snapshotId: 'partial-2', generation: 2, status: 'partial' as const };
    const partial3 = { ...snapshot, snapshotId: 'partial-3', generation: 3, status: 'partial' as const };
    const output = projectScopedEconomicExposureWithCurrency({
      custody: scopedCustody,
      snapshots: [...manifestSnapshots, partial2, partial3],
      rows: [rows[1],
        { ...rows[1], id: 'partial-debt-2', snapshotId: partial2.snapshotId, quantity: 120 },
        { ...rows[1], id: 'partial-debt-3', snapshotId: partial3.snapshotId, quantity: 100 }],
      prices: new Map([[U, 1]]), reportingCurrency: 'USD', now: 1,
      custodyAuthoritySnapshots: [authorityFor(snapshot.accountIdentityScope)], refreshManifests: manifest
    });
    expect(output).toMatchObject({ status: 'partial', netWorth: 93_056 });
    expect(output.liabilities).toEqual([expect.objectContaining({ quantity: 120 })]);
  });
  it('ratchets debt from a complete family committed inside an incomplete batch until a new manifest resets it', () => {
    const scopedCustody = custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope }));
    const manifestSnapshots = completeFamilies({ custody: scopedCustody, snapshots: [snapshot], rows: [rows[1]] });
    const oldManifest = manifestsFor({ custody: scopedCustody, snapshots: manifestSnapshots, rows: [rows[1]] });
    const incompleteBatch = { ...snapshot, snapshotId: 'incomplete-batch-v3', generation: 2, capturedAt: 2 };
    const highDebt = { ...rows[1], id: 'incomplete-batch-debt', snapshotId: incompleteBatch.snapshotId, quantity: 130 };
    const unresolved = projectScopedEconomicExposureWithCurrency({
      custody: scopedCustody, snapshots: [...manifestSnapshots, incompleteBatch], rows: [rows[1], highDebt],
      prices: new Map([[U, 1]]), reportingCurrency: 'USD', now: 2,
      custodyAuthoritySnapshots: [authorityFor(snapshot.accountIdentityScope)], refreshManifests: oldManifest
    });
    expect(unresolved).toMatchObject({ status: 'partial', netWorth: 93_046 });
    expect(unresolved.liabilities).toEqual([expect.objectContaining({ quantity: 130 })]);

    const nextSnapshots = manifestSnapshots.map((row) => ({
      ...row, snapshotId: `next-${row.protocolId}`, generation: 2, capturedAt: 3
    }));
    const nextDebt = { ...rows[1], id: 'next-debt', snapshotId: 'next-aave-v3-ethereum', quantity: 80 };
    const nextManifest = manifestsFor({ custody: scopedCustody, snapshots: nextSnapshots, rows: [nextDebt] });
    const reset = projectScopedEconomicExposureWithCurrency({
      custody: scopedCustody, snapshots: nextSnapshots, rows: [nextDebt], prices: new Map([[U, 1]]),
      reportingCurrency: 'USD', now: 3,
      custodyAuthoritySnapshots: [authorityFor(snapshot.accountIdentityScope, 'custody-snapshot', 1, 3)],
      refreshManifests: nextManifest
    });
    expect(reset).toMatchObject({ status: 'complete', netWorth: 93_096 });
    expect(reset.liabilities).toEqual([expect.objectContaining({ quantity: 80 })]);
  });
  it('requires manifest custody and every selected protocol snapshot to be no older than 24 hours', () => {
    const scopedCustody = custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope }));
    const snapshots = completeFamilies({ custody: scopedCustody, snapshots: [snapshot], rows });
    const manifests = manifestsFor({ custody: scopedCustody, snapshots, rows });
    const common = {
      custody: scopedCustody, snapshots, rows, prices: new Map([[U, 1]]), reportingCurrency: 'USD',
      custodyAuthoritySnapshots: [authorityFor(snapshot.accountIdentityScope)], refreshManifests: manifests
    };
    expect(projectScopedEconomicExposureWithCurrency({ ...common, now: 1 + 24 * 60 * 60_000 }).status).toBe('complete');
    const stale = projectScopedEconomicExposureWithCurrency({ ...common, now: 2 + 24 * 60 * 60_000 });
    expect(stale.status).toBe('partial');
    expect(stale.assets.map((row) => row.id)).toEqual(['liquid', 'receipt', 'debtToken']);
    expect(stale.liabilities).toEqual([expect.objectContaining({ quantity: 90 })]);
  });
  it('accepts complete Moralis corroboration without requiring its block to equal RPC', () => {
    const corroborated = {
      ...snapshot,
      evidence: [
        ...snapshot.evidence,
        { provider: 'moralis' as const, status: 'complete' as const, blockNumber: 999, detail: 'complete corroboration' }
      ]
    };
    const scopedCustody = custody.map((row) => ({ ...row, scopeId: snapshot.accountIdentityScope }));
    const snapshots = completeFamilies({ custody: scopedCustody, snapshots: [corroborated], rows, prices: new Map([[U, 1]]) });
    expect(projectScopedEconomicExposureWithCurrency({
      custody: scopedCustody, snapshots, rows, prices: new Map([[U, 1]]), reportingCurrency: 'USD',
      custodyAuthoritySnapshots: [authorityFor(snapshot.accountIdentityScope)],
      refreshManifests: manifestsFor({ custody: scopedCustody, snapshots, rows, prices: new Map([[U, 1]]) }),
      now: 1
    }).status).toBe('complete');
  });
  it('retains known liability arithmetic when another protocol row is unpriced', () => {
    const debtWithValue = { ...rows[1], valueEvidence: { currency: 'USD' as const, value: 90, observedAt: 1, provider: 'moralis' } };
    const output = projectEconomicExposure({ custody: [custody[0]], snapshot, rows: [rows[0], debtWithValue] });
    expect(output.hasUnpricedValues).toBe(true);
    expect(output.status).toBe('partial');
    expect(output.netWorth).toBe(92_986); // known liquid 93,076 - known debt 90; unpriced supply is explicit
  });
  it('fails closed when supply is priced but a known positive liability is unpriced', () => {
    const pricedSupply = { ...rows[0], valueEvidence: { currency: 'USD' as const, value: 100, observedAt: 1, provider: 'moralis' } };
    const output = projectEconomicExposure({ custody: [custody[0]], snapshot, rows: [pricedSupply, rows[1]] });
    expect(output.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'supply', contribution: 100 })]));
    expect(output.liabilities).toEqual([expect.objectContaining({ quantity: 90, contribution: null })]);
    expect(output.hasUnpricedLiabilities).toBe(true);
    expect(output.status).toBe('partial');
    expect(output.netWorth).toBeNull();
  });
  it('never treats USD position evidence as INR and prefers exact INR underlying prices', () => {
    const usdEvidenceRows = rows.map((row) => ({
      ...row,
      valueEvidence: { currency: 'USD' as const, value: row.role === 'supply' ? 100 : 90, observedAt: 1, provider: 'moralis' }
    }));
    const withoutFx = projectEconomicExposureWithCurrency({
      custody: [], snapshot, rows: usdEvidenceRows, reportingCurrency: 'INR', now: 1
    });
    expect(withoutFx.assets).toEqual([expect.objectContaining({ contribution: null })]);
    expect(withoutFx.liabilities).toEqual([expect.objectContaining({ contribution: null })]);
    expect(withoutFx.netWorth).toBeNull();

    const exactInrPrices = projectEconomicExposureWithCurrency({
      custody: [], snapshot, rows: usdEvidenceRows, reportingCurrency: 'INR',
      prices: new Map([[U, 83]]), now: 1
    });
    expect(exactInrPrices.assets).toEqual([expect.objectContaining({ contribution: 8_300 })]);
    expect(exactInrPrices.liabilities).toEqual([expect.objectContaining({ contribution: -7_470 })]);
    expect(exactInrPrices.netWorth).toBe(830);
  });
  it('converts USD evidence only when explicit reporting-currency FX evidence is supplied', () => {
    const debtWithUsdEvidence = {
      ...rows[1], valueEvidence: { currency: 'USD' as const, value: 90, observedAt: 1, provider: 'moralis' }
    };
    const output = projectEconomicExposureWithCurrency({
      custody: [], snapshot, rows: [debtWithUsdEvidence], reportingCurrency: 'INR',
      usdToReportingCurrencyRate: 83, now: 1
    });
    expect(output.liabilities).toEqual([expect.objectContaining({ contribution: -7_470 })]);
    expect(output.netWorth).toBe(-7_470);
  });
  it.each(['USD', 'INR'])(
    'treats zero aggregate evidence for positive debt as unpriced in %s',
    (reportingCurrency) => {
      const debtWithZeroEvidence = {
        ...rows[1],
        valueEvidence: { currency: 'USD' as const, value: 0, observedAt: 1, provider: 'moralis' }
      };
      const output = projectEconomicExposureWithCurrency({
        custody: [], snapshot, rows: [debtWithZeroEvidence], reportingCurrency,
        now: 1,
        ...(reportingCurrency === 'INR' ? { usdToReportingCurrencyRate: 83 } : {})
      });
      expect(output.liabilities).toEqual([expect.objectContaining({ contribution: null })]);
      expect(output.hasUnpricedLiabilities).toBe(true);
      expect(output.netWorth).toBeNull();
    }
  );
  it.each([
    ['USD', undefined],
    ['INR', 83]
  ] as const)('treats stale positive-liability value evidence as incomplete for %s', (reportingCurrency, fx) => {
    const staleDebt = {
      ...rows[1], valueEvidence: { currency: 'USD' as const, value: 90, observedAt: 1, provider: 'moralis' }
    };
    const output = projectEconomicExposureWithCurrency({
      custody: [], snapshot, rows: [staleDebt], reportingCurrency,
      usdToReportingCurrencyRate: fx, now: 1 + 15 * 60_000 + 1
    });
    expect(output).toMatchObject({ status: 'partial', netWorth: null, hasUnpricedLiabilities: true });
    expect(output.liabilities).toEqual([expect.objectContaining({ contribution: null })]);
  });
  it('replaces receipt and debt-token custody only in the exact complete wallet scope, then reaggregates the other wallet', () => {
    const otherScope = `wallet:evm:1:0x${'2'.repeat(40)}`;
    const currentScope = `wallet:evm:1:0x${'1'.repeat(40)}`;
    const projection = projectScopedEconomicExposure({
      custody: [
        { id: `${currentScope}:receipt`, scopeId: currentScope, chainId: 1, contractAddress: A, symbol: 'aUSDC', quantity: 100, value: 100 },
        { id: `${otherScope}:receipt`, scopeId: otherScope, chainId: 1, contractAddress: A, symbol: 'aUSDC', quantity: 50, value: 50 },
        { id: `${currentScope}:debt-token`, scopeId: currentScope, chainId: 1, contractAddress: D, symbol: 'variableDebtUSDC', quantity: 90, value: 0 },
        { id: `${otherScope}:debt-token`, scopeId: otherScope, chainId: 1, contractAddress: D, symbol: 'variableDebtUSDC', quantity: 10, value: 0 }
      ],
      snapshots: [snapshot], rows, prices: new Map([[U, 1]])
    });
    const replaced = new Set([...projection.assets, ...projection.liabilities].flatMap((row) => row.replacedCustodyId ? [row.replacedCustodyId] : []));
    const source = (scopeId: string, quantity: number) => ({ scopeId, quantity, accountClass: 'wallet' as const, postingQuantity: quantity, verificationStatus: 'verified_authority' as const, authorityStatus: 'current' as const, coverageStatus: 'complete' as const, scopeStatus: 'resolved' as const });
    const displayed = reaggregateUnreplacedCustody([{
      asset: 'aUSDC', chain: 'ethereum', contractAddress: A, amount: 150, costBasis: 150,
      priceNow: 1, priceAsOf: 1, dayChangePct: null, avgCost: 1, valueNow: 150,
      unrealized: 0, unrealizedPct: 0, sourceVerification: [source(currentScope, 100), source(otherScope, 50)]
    }, {
      asset: 'variableDebtUSDC', chain: 'ethereum', contractAddress: D, amount: 100, costBasis: 0,
      priceNow: 0, priceAsOf: 1, dayChangePct: null, avgCost: 0, valueNow: 0,
      unrealized: 0, unrealizedPct: null, sourceVerification: [source(currentScope, 90), source(otherScope, 10)]
    }], [{ assetKey: 'receipt', asset: 'aUSDC', chain: 'ethereum', contractAddress: A, sourceVerification: [source(currentScope, 100), source(otherScope, 50)] },
      { assetKey: 'debt-token', asset: 'variableDebtUSDC', chain: 'ethereum', contractAddress: D, sourceVerification: [source(currentScope, 90), source(otherScope, 10)] }], replaced);
    expect(displayed).toEqual([
      expect.objectContaining({ asset: 'aUSDC', amount: 50, valueNow: 50, sourceVerification: [expect.objectContaining({ scopeId: otherScope })] }),
      expect.objectContaining({ asset: 'variableDebtUSDC', amount: 10, valueNow: 0, sourceVerification: [expect.objectContaining({ scopeId: otherScope })] })
    ]);
    expect([...projection.assets, ...projection.liabilities]).toHaveLength(4);
    expect(projection.netWorth).toBe(60); // other receipt 50 + supplied 100 - debt 90
  });
  it('reconciles the diagnosed wallet fixture at one block without lookalikes or receipt duplication', () => {
    const scope = diagnosedWallet.accountIdentityScope;
    const snapshots = [...new Set(diagnosedWallet.protocolClaims.map((claim) => claim.protocolId))].map((protocolId, index) => ({
      snapshotId: `diagnosed-${index}`, generation: 1, accountIdentityScope: scope,
      protocolId: protocolId as DefiPositionSnapshot['protocolId'], chainId: 1, status: 'complete' as const,
      capturedAt: diagnosedWallet.capturedAt, blockNumber: diagnosedWallet.blockNumber,
      evidence: [{ provider: 'ethereum-rpc' as const, status: 'complete' as const, blockNumber: diagnosedWallet.blockNumber, detail: 'sanitized diagnosed fixture' }]
    }));
    const fixtureRows = diagnosedWallet.protocolClaims.map((claim, index): DefiPositionRow => {
      const common = {
        id: `claim-${index}`, snapshotId: snapshots.find((item) => item.protocolId === claim.protocolId)!.snapshotId,
        protocolId: claim.protocolId as DefiPositionRow['protocolId'], reserveKey: claim.underlyingContract,
        underlying: { chainId: 1 as const, contractAddress: claim.underlyingContract, symbol: claim.asset, decimals: claim.decimals },
        protocolToken: { chainId: 1 as const, contractAddress: claim.protocolTokenContract, symbol: `protocol${claim.asset}`, decimals: claim.decimals },
        quantity: claim.quantity, rawQuantity: claim.rawQuantity
      };
      return claim.role === 'supply'
        ? { ...common, role: 'supply', isCollateral: claim.isCollateral! }
        : { ...common, role: 'debt', debtRateMode: claim.debtRateMode as 'stable' | 'variable' };
    });
    const priceByContract = new Map(diagnosedWallet.protocolClaims.map((claim) => [
      claim.underlyingContract.toLowerCase(), diagnosedWallet.prices[claim.asset as keyof typeof diagnosedWallet.prices]
    ]));
    const custodyRows = diagnosedWallet.custody.filter((row) => row.quantity > 0).map((row) => ({
      id: row.id, scopeId: scope, chainId: 1, contractAddress: row.contractAddress,
      symbol: row.asset, quantity: row.quantity,
      value: row.quantity * (priceByContract.get(row.contractAddress.toLowerCase()) ?? 0)
    }));
    const output = projectScopedEconomicExposure({
      custody: custodyRows, snapshots, rows: fixtureRows, prices: priceByContract
    });
    const connectionsOutput = projectScopedEconomicExposure({
      custody: custodyRows, snapshots, rows: fixtureRows, prices: priceByContract
    });
    const expectedNetWorth = diagnosedWallet.custody[0].quantity * diagnosedWallet.prices.USDC
      + 1.4975 * diagnosedWallet.prices.WBTC
      + 15004.031 * diagnosedWallet.prices.USDC
      + 2.5 * diagnosedWallet.prices.WETH
      - (4000 + 10500.25) * diagnosedWallet.prices.USDC;
    expect(output.status).toBe('complete');
    expect(output.netWorth).toBeCloseTo(expectedNetWorth, 6);
    expect(connectionsOutput.netWorth).toBe(output.netWorth);
    expect(connectionsOutput.assets).toEqual(output.assets);
    expect(connectionsOutput.liabilities).toEqual(output.liabilities);
    expect(output.assets.filter((row) => row.symbol === 'WBTC')).toEqual([
      expect.objectContaining({ kind: 'supply', quantity: 1.4975, protocolId: 'spark-v1-ethereum' })
    ]);
    expect(output.assets.some((row) => ['spWBTC', 'aEthWBTC', 'aEthUSDC', 'aEthWETH'].includes(row.symbol))).toBe(false);
    expect(output.liabilities.map((row) => row.debtRateMode).sort()).toEqual(['stable', 'variable']);
    expect(new Set([...output.assets, ...output.liabilities].map((row) => row.id)).size).toBe(output.assets.length + output.liabilities.length);
  });
});
