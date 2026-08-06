import { describe, expect, it } from 'vitest';
import { exactClassificationEvidence, suggestedClassificationEvidence } from './rules';
import type { Transaction } from '@/types/transaction';

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'fixture', timestamp: 1, type: 'income', asset: 'USDC', amount: 1,
    fiatCurrency: 'USD', source: 'fixture', flags: [], isInternalTransfer: false,
    ...overrides
  };
}

describe('fixture-backed exact classification rules', () => {
  it.each([
    [tx({ source: 'binance_options', type: 'fee', raw: { _optionsKind: 'premium' } }), 'binance-options:premium', 'options_premium'],
    [tx({ source: 'binance', type: 'fee', raw: { Operation: 'Funding Fee' } }), 'binance-ledger:funding-fee', 'funding_fee'],
    [tx({ source: 'binance', type: 'sell', raw: { Operation: 'Realized Profit and Loss' } }), 'binance-ledger:realized-pnl', 'realized_pnl'],
    [tx({ source: 'binance', type: 'trade', raw: { Operation: 'Small Assets Exchange BNB' } }), 'binance-ledger:dust', 'dust'],
    [tx({ source: 'hyperliquid_trades', type: 'income', raw: { _hlKind: 'perp_profit' } }), 'hyperliquid:perp-profit', 'perp_profit'],
    [tx({ source: 'hyperliquid_deposits', type: 'transfer_in' }), 'hyperliquid:collateral', 'derivative_collateral']
  ])('emits confidence 1.0 for %s', (transaction, ruleId, category) => {
    expect(exactClassificationEvidence(transaction)).toContainEqual(expect.objectContaining({
      ruleId, category, confidence: 1, allowlisted: true
    }));
  });

  it('does not turn unsupported parser text into exact evidence', () => {
    expect(exactClassificationEvidence(tx({ source: 'binance', raw: { Operation: 'Mystery Yield' } }))).toEqual([]);
  });

  it('keeps Moralis intent labels at medium-confidence suggestion strength', () => {
    expect(suggestedClassificationEvidence(tx({ source: 'rpc:moralis', type: 'transfer_in', raw: { category: 'reward' } })))
      .toContainEqual(expect.objectContaining({
        category: 'defi_reward', origin: 'suggestion', confidence: 0.75, allowlisted: false
      }));
  });
});
