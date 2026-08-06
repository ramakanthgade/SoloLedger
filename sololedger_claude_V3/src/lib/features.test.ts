import { describe, it, expect } from 'vitest';
import { isFeatureUnlocked, isWalletDefiNetWorthV1Enabled } from './features';

describe('isFeatureUnlocked — jurisdiction gating', () => {
  it('gates loss-harvesting and multi-year carryforward OFF for IN', () => {
    expect(isFeatureUnlocked('advanced_loss_harvesting', 'IN')).toBe(false);
    expect(isFeatureUnlocked('multi_year_carryforward', 'IN')).toBe(false);
  });

  it('keeps those features ON for US/CA/AE', () => {
    for (const jur of ['US', 'CA', 'AE'] as const) {
      expect(isFeatureUnlocked('advanced_loss_harvesting', jur)).toBe(true);
      expect(isFeatureUnlocked('multi_year_carryforward', jur)).toBe(true);
    }
  });

  it('leaves other features unaffected by jurisdiction', () => {
    expect(isFeatureUnlocked('custom_jurisdiction_rules', 'IN')).toBe(true);
    expect(isFeatureUnlocked('unlimited_transactions', 'IN')).toBe(true);
  });

  it('defaults to unlocked when no jurisdiction is passed', () => {
    expect(isFeatureUnlocked('advanced_loss_harvesting')).toBe(true);
  });
});

describe('walletDefiNetWorthV1 rollout switch', () => {
  it('defaults off and enables only for an explicit true value', () => {
    expect(isWalletDefiNetWorthV1Enabled(undefined)).toBe(false);
    expect(isWalletDefiNetWorthV1Enabled('true')).toBe(true);
    expect(isWalletDefiNetWorthV1Enabled(' TRUE ')).toBe(true);
    expect(isWalletDefiNetWorthV1Enabled('false')).toBe(false);
    expect(isWalletDefiNetWorthV1Enabled('1')).toBe(false);
    expect(isFeatureUnlocked('walletDefiNetWorthV1')).toBe(true);
  });
});
