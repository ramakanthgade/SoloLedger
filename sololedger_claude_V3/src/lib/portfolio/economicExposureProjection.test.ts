import { describe, expect, it, vi } from 'vitest';
import { projectEconomicExposure, projectLegacyWalletNetWorth, projectScopedEconomicExposure, projectWalletDefiNetWorth, storeWalletDefiNetWorthShadow, WALLET_DEFI_SHADOW_STORAGE_KEY } from './economicExposureProjection';
import type { DefiPositionRow, DefiPositionSnapshot } from '@/lib/defi/types';
import diagnosedWallet from '@/lib/defi/__fixtures__/diagnosed-wallet.sanitized.json';
import { reaggregateUnreplacedCustody } from '@/components/dashboard/dashboardEconomicRows';

const U = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const A = '0xbcca60bb61934080951369a648fb03df4f96263c';
const D = '0x72e95b8931767c79bA4Ee721E2dFD084399483DA'.toLowerCase();
const snapshot = { snapshotId: 's', generation: 1, accountIdentityScope: `wallet:evm:0x${'1'.repeat(40)}`, protocolId: 'aave-v3-ethereum', chainId: 1, status: 'complete', capturedAt: 1, evidence: [] } satisfies DefiPositionSnapshot;
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
    const wbtc = `0x${'b'.repeat(40)}`;
    const fixtureRows = diagnosedWallet.protocolClaims.map((claim, index): DefiPositionRow => {
      const underlying = claim.asset === 'USDC' ? U : wbtc;
      const common = {
        id: `claim-${index}`, snapshotId: snapshots.find((item) => item.protocolId === claim.protocolId)!.snapshotId,
        protocolId: claim.protocolId as DefiPositionRow['protocolId'], reserveKey: underlying,
        underlying: { chainId: 1 as const, contractAddress: underlying, symbol: claim.asset, decimals: claim.asset === 'USDC' ? 6 : 8 },
        protocolToken: { chainId: 1 as const, contractAddress: `0x${String(index + 1).repeat(40)}`, symbol: `protocol${claim.asset}`, decimals: claim.asset === 'USDC' ? 6 : 8 },
        quantity: claim.quantity, rawQuantity: '1'
      };
      return claim.role === 'supply'
        ? { ...common, role: 'supply', isCollateral: claim.isCollateral! }
        : { ...common, role: 'debt', debtRateMode: claim.debtRateMode as 'stable' | 'variable' };
    });
    const output = projectScopedEconomicExposure({
      custody: [{ id: 'canonical-liquid-usdc', scopeId: `wallet:evm:1:${scope.slice('wallet:evm:'.length)}`, chainId: 1, contractAddress: U, symbol: 'USDC', quantity: diagnosedWallet.expectations.canonicalLiquidUsdc, value: diagnosedWallet.expectations.canonicalLiquidUsdc }],
      snapshots, rows: fixtureRows, prices: new Map([[U, 1]])
    });
    expect(output.assets.filter((row) => row.symbol === 'WBTC' && row.kind === 'liquid')).toHaveLength(diagnosedWallet.expectations.plainWbtcQuantity);
    expect(output.assets.filter((row) => row.symbol === 'WBTC' && row.kind === 'supply')).toHaveLength(2);
    expect(output.liabilities.reduce((sum, row) => sum + row.quantity, 0)).toBe(diagnosedWallet.expectations.totalDebtUsdc);
    expect(output.netWorth).toBe(103_071);
    expect(output.assets.some((row) => /lookalike/i.test(row.id))).toBe(false);
  });
});
