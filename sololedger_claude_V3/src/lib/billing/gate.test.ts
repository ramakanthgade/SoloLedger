import { describe, expect, it } from 'vitest';
import { evaluateExportGate, suggestPlanForUnits } from './gate';
import { LOCAL_INCLUDED_UNITS } from '@/lib/saas/plans';

describe('free-tier export cap (100 events)', () => {
  it('allows export at exactly 100 units', () => {
    const r = evaluateExportGate(100, LOCAL_INCLUDED_UNITS, 'local');
    expect(r.allowed).toBe(true);
    expect(r.overageUnits).toBe(0);
    expect(r.upgradeCta).toBeUndefined();
  });

  it('blocks export at 101 units with an upgrade CTA and no truncation', () => {
    const r = evaluateExportGate(101, LOCAL_INCLUDED_UNITS, 'local');
    expect(r.allowed).toBe(false);
    expect(r.overageUnits).toBe(1);
    expect(r.units).toBe(101); // full count preserved — nothing truncated
    expect(r.upgradeCta?.action).toBe('upgrade_plan');
    expect(r.upgradeCta?.suggestedPlan).toBe('starter');
  });
});

describe('suggestPlanForUnits', () => {
  it('suggests the smallest tier that covers the unit count', () => {
    expect(suggestPlanForUnits(100)).toBe('local');
    expect(suggestPlanForUnits(101)).toBe('starter');
    expect(suggestPlanForUnits(501)).toBe('standard');
    expect(suggestPlanForUnits(2001)).toBe('pro');
    expect(suggestPlanForUnits(5001)).toBe('investor');
    expect(suggestPlanForUnits(10001)).toBe('enterprise');
  });
});

describe('Enterprise allowance enforcement (prepaid packs)', () => {
  it('blocks base Enterprise (10,000) at 10,001 with a buy-pack CTA', () => {
    const r = evaluateExportGate(10_001, 10_000, 'enterprise');
    expect(r.allowed).toBe(false);
    expect(r.overageUnits).toBe(1);
    expect(r.upgradeCta?.action).toBe('buy_pack');
  });

  it('allows a larger pack (13,000) up to 13,000 and blocks at 13,001', () => {
    expect(evaluateExportGate(13_000, 13_000, 'enterprise').allowed).toBe(true);
    const over = evaluateExportGate(13_001, 13_000, 'enterprise');
    expect(over.allowed).toBe(false);
    expect(over.upgradeCta?.action).toBe('buy_pack');
  });
});
