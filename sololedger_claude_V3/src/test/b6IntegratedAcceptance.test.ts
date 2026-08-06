import { describe, expect, it } from 'vitest';
import { applyOwnershipUpdate, newAccountIdentity, walletAccountCanonicalKey } from '@/lib/accounts/accountIdentity';
import { groupWallets } from '@/components/connections/connectionModel';
import { matchInternalTransfers, type TransferCandidate } from '@/lib/internalTransfers/matcher';
import { assertValidReciprocalTransferPairs } from '@/lib/internalTransfers/model';
import { applyClassificationEvidence, resetClassification, userClassificationPatch } from '@/lib/taxonomy/classification';
import { resolveTaxPolicy } from '@/lib/taxonomy/taxPolicy';
import { projectEconomicExposure, projectWalletDefiNetWorth } from '@/lib/portfolio/economicExposureProjection';
import { isExcludedSafetyState } from '@/lib/safety/types';
import { TEST_TAX_SETTINGS } from '@/test/taxSettings';
import {
  B6_AUSDC, B6_DEBT_USDC, B6_EVM_ADDRESS, B6_NOW, B6_USDC,
  b6ClassificationEvidence, b6DefiAction, b6DefiRows, b6DefiSnapshot,
  b6SafetyDecisions, b6Transaction, b6TransferTransactions, b6WalletSources
} from '@/test/fixtures/b6Integrated';

function candidate(transaction: ReturnType<typeof b6Transaction>, accountId: string, endpointAddress: string): TransferCandidate {
  return {
    transaction,
    account: { accountId, ownership: 'owned', lifecycleRevision: 1, sourceRevision: 0, endpointAddress }
  };
}

describe('B6 integrated acceptance fixture', () => {
  it('keeps canonical ownership separate from chain/source presentation', () => {
    const firstKey = walletAccountCanonicalKey('ethereum', B6_EVM_ADDRESS);
    expect(walletAccountCanonicalKey('polygon', B6_EVM_ADDRESS.toUpperCase())).toBe(firstKey);
    const groups = groupWallets(b6WalletSources);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.address.toLowerCase() === B6_EVM_ADDRESS)?.chains.sort()).toEqual(['ethereum', 'polygon']);

    const owned = applyOwnershipUpdate(newAccountIdentity({ kind: 'wallet', canonicalKey: firstKey }, B6_NOW), {
      status: 'owned', origin: 'user'
    }, B6_NOW + 1);
    expect(owned).toMatchObject({ ownershipStatus: 'owned', lifecycleRevision: 1, ownershipConfirmedAt: B6_NOW + 1 });

    const exchangeAccounts = ['primary', 'retirement'].map((id) => newAccountIdentity({
      kind: 'exchange', canonicalKey: `exchange:${id}`, providerId: 'binance'
    }, B6_NOW));
    const recurringCsv = newAccountIdentity({ kind: 'csv', canonicalKey: 'csv-account:tax-year', parserId: 'binance' }, B6_NOW);
    expect(new Set(exchangeAccounts.map((row) => row.id)).size).toBe(2);
    expect(recurringCsv.canonicalKey).toBe('csv-account:tax-year');
  });

  it('covers every safety state and prevents spoofed outbound evidence from transfer matching', () => {
    expect(b6SafetyDecisions.map((row) => [row.state, isExcludedSafetyState(row.state)])).toEqual([
      ['trusted', false], ['high_confidence_spam', true], ['unverified', false],
      ['user_hidden', true], ['user_visible', false]
    ]);
    expect(b6SafetyDecisions[b6SafetyDecisions.length - 1]).toMatchObject({
      state: 'user_visible', origin: 'user', previousAutomaticState: 'high_confidence_spam'
    });

    const rows = b6TransferTransactions;
    const matches = matchInternalTransfers([
      candidate(rows.exactOut, 'wallet-a', B6_EVM_ADDRESS),
      candidate(rows.exactIn, 'wallet-b', `0x${'2'.repeat(40)}`),
      candidate(rows.suggestedOut, 'wallet-a', B6_EVM_ADDRESS),
      candidate(rows.suggestedIn, 'wallet-b', `0x${'2'.repeat(40)}`),
      candidate(rows.spoofedOut, 'wallet-a', B6_EVM_ADDRESS)
    ]);
    expect(matches.map(({ outgoingTransactionId, decision, method }) => ({ outgoingTransactionId, decision, method })))
      .toEqual(expect.arrayContaining([
        { outgoingTransactionId: 'exact-out', decision: 'confirmed', method: 'exact_onchain_event' },
        { outgoingTransactionId: 'suggested-out', decision: 'suggested', method: 'heuristic' }
      ]));
    expect(matches.some((match) => match.outgoingTransactionId === 'spoofed-out')).toBe(false);

    const rejected = ['out', 'in'].map((leg) => b6Transaction(`rejected-${leg}`, {
      type: leg === 'out' ? 'transfer_out' : 'transfer_in', internalTransferPairId: 'rejected-pair',
      linkedTransferId: `rejected-${leg === 'out' ? 'in' : 'out'}`, internalTransferDecision: 'rejected',
      internalTransferMatchMethod: 'manual', internalTransferMatcherVersion: 'b4-v1',
      internalTransferDecisionAt: B6_NOW, isInternalTransfer: false
    }));
    expect(() => assertValidReciprocalTransferPairs(rejected)).not.toThrow();
  });

  it('applies B5 precedence, preserves user lock, resets to evidence, and resolves every jurisdiction at report time', () => {
    const baseline = b6Transaction('classified', { type: 'income', category: 'other', categoryOrigin: 'legacy' });
    const automatic = applyClassificationEvidence(baseline, b6ClassificationEvidence, B6_NOW + 10);
    expect(automatic).toMatchObject({ type: 'income', category: 'staking_reward', categoryOrigin: 'provider' });

    const locked = { ...automatic, ...userClassificationPatch(automatic, 'income', 'airdrop', B6_NOW + 20) };
    expect(applyClassificationEvidence(locked, [{ ...b6ClassificationEvidence[1], category: 'reward', observedAt: B6_NOW + 30 }]))
      .toMatchObject({ category: 'airdrop', categoryOrigin: 'user', categoryLocked: true });
    expect(resetClassification(locked, B6_NOW + 40)).toMatchObject({ category: 'staking_reward', categoryOrigin: 'provider', categoryLocked: false });

    for (const jurisdiction of ['IN', 'US', 'CA', 'AE'] as const) {
      const settings = { ...TEST_TAX_SETTINGS, jurisdiction };
      expect(resolveTaxPolicy({ kind: 'transaction', transaction: automatic, settings })).toMatchObject({
        treatment: 'income', reasonCode: 'typed_income_receipt', jurisdiction
      });
      expect(resolveTaxPolicy({ kind: 'defi_action', action: b6DefiAction('supply'), settings })).toMatchObject({
        treatment: 'requires_review', reasonCode: 'defi_supply_withdraw_unsupported', jurisdiction
      });
      expect(resolveTaxPolicy({ kind: 'defi_action', action: b6DefiAction('borrow'), settings })).toMatchObject({
        treatment: 'non_taxable', reasonCode: 'defi_loan_principal', jurisdiction
      });
      expect(resolveTaxPolicy({ kind: 'defi_action', action: b6DefiAction('reward'), settings })).toMatchObject({
        treatment: 'income', reasonCode: 'defi_income_receipt', jurisdiction
      });
      expect(resolveTaxPolicy({ kind: 'defi_action', action: b6DefiAction('withdraw', { chainId: 137 }), settings })).toMatchObject({
        treatment: 'requires_review', reasonCode: 'defi_protocol_unsupported', jurisdiction
      });
    }
  });

  it('projects supply and debt once, fails closed on unsupported DeFi, and gives Dashboard/Connections identical totals', () => {
    const custody = [
      { id: 'liquid', scopeId: `wallet:evm:1:${B6_EVM_ADDRESS}`, chainId: 1, contractAddress: B6_USDC, symbol: 'USDC', quantity: 93_076, value: 93_076 },
      { id: 'receipt', scopeId: `wallet:evm:1:${B6_EVM_ADDRESS}`, chainId: 1, contractAddress: B6_AUSDC, symbol: 'aUSDC', quantity: 100_000, value: 100_000 },
      { id: 'debt-token', scopeId: `wallet:evm:1:${B6_EVM_ADDRESS}`, chainId: 1, contractAddress: B6_DEBT_USDC, symbol: 'variableDebtUSDC', quantity: 90_005, value: 0 }
    ];
    const input = { custody, snapshots: [b6DefiSnapshot], rows: b6DefiRows, prices: new Map([[B6_USDC, 1]]), enabled: true };
    const dashboard = projectWalletDefiNetWorth(input);
    const connections = projectWalletDefiNetWorth(input);
    expect(dashboard.projection.assets.filter((row) => row.kind === 'supply')).toHaveLength(1);
    expect(dashboard.projection.liabilities).toEqual([expect.objectContaining({ quantity: 90_005, contribution: -90_005 })]);
    expect(dashboard.projection.netWorth).toBe(103_071);
    expect(connections.projection).toEqual(dashboard.projection);

    const unsupported = projectEconomicExposure({ custody, rows: [], unsupported: true });
    expect(unsupported).toMatchObject({ status: 'unsupported', liabilities: [], retainedCustody: custody });
  });
});
