import { describe, expect, it } from 'vitest';
import { resolveTaxPolicy } from './taxPolicy';
import type { NeutralDefiAction } from '@/lib/defi/types';
import type { TaxSettings } from '@/types/transaction';
import type { Transaction } from '@/types/transaction';

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

  it('exempts only confirmed internal-transfer decisions and keeps suggestions/rejections review-required', () => {
    const transaction: Transaction = {
      id: 'transfer', timestamp: 1, type: 'transfer_out', asset: 'ETH', amount: 1,
      source: 'wallet', fiatCurrency: 'USD', flags: [], isInternalTransfer: false
    };
    for (const decision of ['suggested', 'rejected'] as const) {
      expect(resolveTaxPolicy({ kind: 'transaction', transaction: { ...transaction, internalTransferDecision: decision }, settings }).treatment)
        .toBe('requires_review');
    }
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: {
      ...transaction, internalTransferDecision: 'confirmed', isInternalTransfer: true
    }, settings }).treatment).toBe('non_taxable');
  });

  it.each(['IN', 'US', 'CA', 'AE'] as const)('returns stable, versioned outcomes for %s without rewriting stored rows', (jurisdiction) => {
    const before: Transaction = {
      id: 'income', timestamp: 1, type: 'income', category: 'lending_interest', asset: 'USDC', amount: 2,
      source: 'fixture', fiatCurrency: 'USD', flags: [], isInternalTransfer: false
    };
    const snapshot = structuredClone(before);
    const outcome = resolveTaxPolicy({ kind: 'transaction', transaction: before, settings: { ...settings, jurisdiction } });
    expect(outcome).toMatchObject({
      treatment: 'income', reasonCode: 'typed_income_receipt', policyVersion: 'b5.1', jurisdiction
    });
    expect(outcome.explanation).toBe(outcome.reason);
    expect(before).toEqual(snapshot);
  });

  it.each(['IN', 'US', 'CA', 'AE'] as const)('keeps ordinary fees out of gains for %s without flagging unsupported policy', (jurisdiction) => {
    const transaction: Transaction = {
      id: 'spot-fee', timestamp: 1, type: 'fee', category: 'other_fee', asset: 'ETH', amount: 0.01,
      source: 'fixture', fiatCurrency: 'USD', flags: [], isInternalTransfer: false
    };
    expect(resolveTaxPolicy({ kind: 'transaction', transaction, settings: { ...settings, jurisdiction } })).toMatchObject({
      treatment: 'non_taxable', reasonCode: 'transaction_fee', jurisdiction
    });
  });

  it.each(['IN', 'US', 'CA', 'AE'] as const)('requires explicit jurisdiction evidence for gifts and crypto loan repayment in %s', (jurisdiction) => {
    const base: Transaction = {
      id: 'review', timestamp: 1, type: 'gift_received', category: 'gift', asset: 'ETH', amount: 1,
      source: 'fixture', fiatCurrency: 'USD', flags: [], isInternalTransfer: false
    };
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: base, settings: { ...settings, jurisdiction } })).toMatchObject({
      treatment: 'requires_review', reasonCode: 'gift_received_unsupported', jurisdiction
    });
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: { ...base, type: 'gift_sent' }, settings: { ...settings, jurisdiction } })).toMatchObject({
      treatment: 'requires_review', reasonCode: 'gift_sent_unsupported', jurisdiction
    });
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: { ...base, type: 'transfer_out', category: 'loan_repayment' }, settings: { ...settings, jurisdiction } })).toMatchObject({
      treatment: 'requires_review', reasonCode: 'crypto_loan_repayment_unsupported', jurisdiction
    });
  });

  it('fails closed for options lifecycle, derivative collateral, DeFi rows, and unconfirmed suggestions', () => {
    const base: Transaction = {
      id: 'x', timestamp: 1, type: 'income', asset: 'USDC', amount: 1,
      source: 'fixture', fiatCurrency: 'USD', flags: [], isInternalTransfer: false,
      instrumentClass: 'derivative'
    };
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: { ...base, category: 'options_premium' }, settings }).reasonCode)
      .toBe('options_lifecycle_unsupported');
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: { ...base, type: 'transfer_in', category: 'derivative_collateral' }, settings }).treatment)
      .toBe('requires_review');
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: { ...base, type: 'defi_deposit', instrumentClass: 'spot' }, settings }).treatment)
      .toBe('requires_review');
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: { ...base, category: 'defi_reward', categoryOrigin: 'suggestion', instrumentClass: 'spot' }, settings }).reasonCode)
      .toBe('suggestion_pending');
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: { ...base, type: 'fee', category: 'funding_fee' }, settings }).reasonCode)
      .toBe('derivative_cashflow_unsupported');
  });
});
