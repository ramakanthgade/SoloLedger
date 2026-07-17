import { describe, it, expect } from 'vitest';
import { hyperliquidDepositsParser } from './hyperliquidDeposits';
import { loadFixtureRows, loadExpected, normalizeForSnapshot } from './__fixtures__/fixtureUtils';

describe('Hyperliquid deposits — non-USDC valuation (C1)', () => {
  it('matches the golden expected fixture', () => {
    const rows = loadFixtureRows('hyperliquid/deposits.csv');
    const { transactions } = hyperliquidDepositsParser.parse(rows);
    expect(normalizeForSnapshot(transactions)).toEqual(
      loadExpected('hyperliquid/deposits.expected.json')
    );
  });

  it('values USDC deposits 1:1 in USD', () => {
    const rows = loadFixtureRows('hyperliquid/deposits.csv');
    const { transactions } = hyperliquidDepositsParser.parse(rows);
    const usdc = transactions.find((t) => t.asset === 'USDC')!;
    expect(usdc.fiatValue).toBe(1989.8);
    expect(usdc.fiatCurrency).toBe('USD');
    expect(usdc.flags).not.toContain('missing_cost_basis');
  });

  it('leaves a non-USDC deposit unpriced and flags missing_cost_basis', () => {
    const rows = loadFixtureRows('hyperliquid/deposits.csv');
    const { transactions } = hyperliquidDepositsParser.parse(rows);
    const eth = transactions.find((t) => t.asset === 'ETH')!;
    expect(eth.fiatValue).toBeUndefined();
    expect(eth.flags).toContain('missing_cost_basis');
  });
});
