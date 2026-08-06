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
    expect(resolveTaxPolicy({ kind: 'defi_action', action: action('repay'), settings }).treatment).toBe('requires_review');
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

  it('consumes exact stored DeFi evidence at report time instead of trusting the loan category', () => {
    const eventIds = [
      'event:1:0xabc:0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2:90',
      'event:1:0xabc:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:89',
      'event:1:0xabc:0x72e95b8931767c79ba4eee721354d6e99a61d004:88'
    ];
    const exact = {
      type: 'borrow', chainId: 1, protocolId: 'aave-v3-ethereum',
      reserveKey: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', quantity: '45000000000',
      transactionHash: '0xabc', callId: eventIds[0], eventIds, complete: true, confidence: 1,
      evidenceSource: 'ethereum_log', ruleId: 'defi-receipt:aave-v3-ethereum:borrow', ruleVersion: 'b5.1',
      postingAnchorEventId: eventIds[1], postingAnchor: true,
      postingAnchorRawQuantity: '45000000000', postingAnchorDecimals: 6,
      registryEvidence: [{
        contractAddress: '0x72e95b8931767c79ba4eee721354d6e99a61d004',
        protocolId: 'aave-v3-ethereum', reserveKey: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', role: 'debt_token'
      }],
      economicLegs: [
        { eventId: eventIds[1], kind: 'underlying', direction: 'in', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', quantity: '45000000000', from: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', to: '0x2b2b7fec2ba5854aef243c21a583d8e61ee82c32' },
        { eventId: eventIds[2], kind: 'debt_token', direction: 'mint', contractAddress: '0x72e95b8931767c79ba4eee721354d6e99a61d004', quantity: '45000000001', from: '0x0000000000000000000000000000000000000000', to: '0x2b2b7fec2ba5854aef243c21a583d8e61ee82c32' }
      ],
      callEvidence: {
        provider: 'blockscout', from: '0x2b2b7fec2ba5854aef243c21a583d8e61ee82c32',
        to: '0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2', status: 'success'
      }
    };
    const transaction: Transaction = {
      id: 'borrow', timestamp: 1, type: 'transfer_in', category: 'loan', asset: 'USDC', amount: 45_000,
      source: 'rpc:blockscout', txHash: '0xabc', walletAddress: '0x2b2b7fec2ba5854aef243c21a583d8e61ee82c32',
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', chain: 'ethereum',
      onchainTransferEvent: {
        chain: 'ethereum', txHash: '0xabc', assetKey: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        indexKind: 'log', index: '89', sender: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
        recipient: '0x2b2b7fec2ba5854aef243c21a583d8e61ee82c32', quantity: '45000000000'
      },
      fiatCurrency: 'USD', flags: [], isInternalTransfer: false,
      raw: { defiActionEvidence: exact }
    };
    expect(resolveTaxPolicy({ kind: 'transaction', transaction, settings })).toMatchObject({
      treatment: 'non_taxable', reasonCode: 'defi_loan_principal', evidenceIds: eventIds
    });
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: {
      ...transaction, raw: { defiActionEvidence: { ...exact, complete: false } }
    }, settings })).toMatchObject({ treatment: 'requires_review', reasonCode: 'defi_evidence_incomplete' });

    const interestEvent = 'event:1:0xabc:0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c:91';
    const interest = {
      ...exact, type: 'interest', quantity: '125000', callId: interestEvent,
      eventIds: [interestEvent, 'event:1:0xabc:0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c:92'],
      ruleId: 'defi-receipt:aave-v3-ethereum:lending-interest', interestKind: 'lending',
      postingAnchorEventId: 'event:1:0xabc:0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c:92',
      postingAnchorRawQuantity: '125000', postingAnchorDecimals: 6,
      registryEvidence: [{
        contractAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c', protocolId: 'aave-v3-ethereum',
        reserveKey: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', role: 'protocol_token'
      }],
      economicLegs: [{
        eventId: 'event:1:0xabc:0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c:92',
        kind: 'protocol_token', direction: 'mint', contractAddress: '0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c',
        quantity: '125000', from: '0x0000000000000000000000000000000000000000',
        to: '0x2b2b7fec2ba5854aef243c21a583d8e61ee82c32'
      }]
    };
    expect(resolveTaxPolicy({ kind: 'transaction', transaction: {
      ...transaction, id: 'interest', type: 'income', category: 'lending_interest', onchainTransferEvent: undefined,
      raw: { syntheticDefiComponent: true, defiActionEvidence: interest }
    }, settings })).toMatchObject({ treatment: 'income', reasonCode: 'defi_income_receipt' });
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
