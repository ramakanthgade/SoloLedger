import { describe, expect, it } from 'vitest';
import { classifyFromMoralis, neutralDefiActionFromMoralis } from './classificationEngine';

describe('Moralis DeFi classification boundary', () => {
  it('emits neutral action hints without treating DeFi labels as structural tax facts', () => {
    for (const [label, action] of [
      ['deposit', 'supply'], ['withdraw', 'withdraw'], ['borrow', 'borrow'], ['repay', 'repay'],
      ['staking', undefined], ['unstaking', undefined]
    ] as const) {
      expect(neutralDefiActionFromMoralis(label)).toBe(action);
      expect(classifyFromMoralis(label, `${label} USDC`, false)).toBeNull();
    }
  });
});
