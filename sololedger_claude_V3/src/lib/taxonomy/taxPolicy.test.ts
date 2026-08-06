import { describe, expect, it } from 'vitest';
import { resolveTaxPolicy } from './taxPolicy';
import type { NeutralDefiAction } from '@/lib/defi/types';
import type { TaxSettings } from '@/types/transaction';

const settings: TaxSettings = {
  jurisdiction: 'US', reportingCurrency: 'USD', defaultCostBasisMethod: 'FIFO',
  priceApiEnabled: false, rpcLookupEnabled: false
};
const action = (type: NeutralDefiAction['type'], overrides: Partial<NeutralDefiAction> = {}): NeutralDefiAction => ({
  type, chainId: 1, protocolId: 'aave-v3-ethereum', reserveKey: '0xreserve', quantity: '10',
  transactionHash: '0xhash', eventIds: ['event:1:0xhash:0xpool:7'], complete: true,
  confidence: 1, evidenceSource: 'ethereum_log', ...overrides
});

describe('canonical tax policy boundary', () => {
  it('has no second resolver or defiPolicy import path', () => {
    const modules = import.meta.glob('../**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const resolvers = Object.entries(modules).filter(([, source]) => /function\s+resolveTaxPolicy\s*\(/.test(source));
    expect(resolvers.map(([path]) => path)).toEqual(['./taxPolicy.ts']);
    expect(Object.keys(modules).some((path) => /defiPolicy/i.test(path))).toBe(false);
  });

  it('pins only explicit supported DeFi outcomes', () => {
    expect(resolveTaxPolicy({ kind: 'defi_action', action: action('borrow'), settings }).treatment).toBe('non_taxable');
    expect(resolveTaxPolicy({ kind: 'defi_action', action: action('repay'), settings }).treatment).toBe('non_taxable');
    expect(resolveTaxPolicy({ kind: 'defi_action', action: action('interest'), settings }).treatment).toBe('income');
    expect(resolveTaxPolicy({ kind: 'defi_action', action: action('reward'), settings }).treatment).toBe('income');
    for (const type of ['supply', 'withdraw', 'liquidation'] as const) {
      expect(resolveTaxPolicy({ kind: 'defi_action', action: action(type), settings }).treatment).toBe('requires_review');
    }
  });

  it('fails closed for incomplete, unsupported-chain, and unsupported-protocol evidence', () => {
    for (const unsupported of [
      action('borrow', { complete: false }),
      action('borrow', { chainId: 137 }),
      action('borrow', { protocolId: 'provider-label-only' })
    ]) expect(resolveTaxPolicy({ kind: 'defi_action', action: unsupported, settings }).treatment).toBe('requires_review');
  });

  it('adapts validated derivative defaults without storing a second table', () => {
    expect(resolveTaxPolicy({ kind: 'derivatives', settings }).treatment).toBe('capital_gains');
    expect(resolveTaxPolicy({ kind: 'derivatives', settings: { ...settings, jurisdiction: 'IN' } }).treatment).toBe('business_income');
  });
});
