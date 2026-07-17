import { describe, it, expect } from 'vitest';
import { isFeatureUnlocked } from './features';

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
