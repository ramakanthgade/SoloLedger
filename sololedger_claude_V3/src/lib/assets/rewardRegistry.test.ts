import { describe, it, expect } from 'vitest';
import {
  classifyRewardIncome,
  isKnownRewardToken,
  GEOD_TOKEN_MINT_SOLANA,
  GEOD_REWARDS_WALLET_SOLANA,
  GEOD_TOKEN_POLYGON,
  GEOD_REWARDS_WALLET_POLYGON,
  REWARD_KIND_LABEL
} from '@/lib/assets/rewardRegistry';
import { DBT_TOKEN_MINT, DABBA_PROGRAMS } from '@/lib/assets/dabbaRegistry';

describe('isKnownRewardToken', () => {
  it('recognizes GEOD and DBT mints', () => {
    expect(isKnownRewardToken(GEOD_TOKEN_MINT_SOLANA)).toBe(true);
    expect(isKnownRewardToken(GEOD_TOKEN_POLYGON)).toBe(true);
    expect(isKnownRewardToken(DBT_TOKEN_MINT)).toBe(true);
  });

  it('returns false for unknown / missing mints', () => {
    expect(isKnownRewardToken('So11111111111111111111111111111111111111112')).toBe(false);
    expect(isKnownRewardToken(undefined)).toBe(false);
    expect(isKnownRewardToken('')).toBe(false);
  });
});

describe('classifyRewardIncome — GEOD (distributor allowlist)', () => {
  it('classifies GEOD from the rewards wallet as a mining reward', () => {
    const r = classifyRewardIncome(GEOD_TOKEN_MINT_SOLANA, GEOD_REWARDS_WALLET_SOLANA);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('mining_reward');
    expect(r!.label).toBe('Geodnet GEOD mining reward (Solana)');
    // Deliberately NOT the literal 'mining' so it counts as receipt-side income.
    expect(r!.kind).not.toBe('mining');
  });

  it('returns null for GEOD from a non-rewards sender (user guard)', () => {
    const other = 'Gh2nJr3gxiYBxFaSGBsi6VVhdefkMYX6jGR3PCD7h8t4';
    expect(classifyRewardIncome(GEOD_TOKEN_MINT_SOLANA, other)).toBeNull();
  });

  it('returns null for GEOD with an undefined counterparty (conservative)', () => {
    expect(classifyRewardIncome(GEOD_TOKEN_MINT_SOLANA, undefined)).toBeNull();
  });

  it('classifies Polygon GEOD from its mining distribution wallet', () => {
    const r = classifyRewardIncome(GEOD_TOKEN_POLYGON, GEOD_REWARDS_WALLET_POLYGON);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('mining_reward');
    expect(r!.label).toBe('Geodnet GEOD mining reward (Polygon)');
  });

  it.each([
    ['lowercase', GEOD_TOKEN_POLYGON, GEOD_REWARDS_WALLET_POLYGON],
    [
      'uppercase hex',
      `0x${GEOD_TOKEN_POLYGON.slice(2).toUpperCase()}`,
      `0x${GEOD_REWARDS_WALLET_POLYGON.slice(2).toUpperCase()}`
    ],
    [
      'checksummed/mixed case',
      '0xAc0F66379A6D7801D7726D5A943356A172549AdB',
      '0x8Fb9Dd00B9A3D893Da96D444817D0B77330D5478'
    ]
  ])('matches %s Polygon contract and distributor addresses', (_label, contract, distributor) => {
    const r = classifyRewardIncome(contract, distributor);
    expect(r).toEqual({
      kind: 'mining_reward',
      label: 'Geodnet GEOD mining reward (Polygon)',
      notes: 'Geodnet GEOD mining reward on Polygon — auto-classified as income'
    });
    expect(isKnownRewardToken(contract)).toBe(true);
  });

  it('keeps Solana mint and wallet matching case-sensitive', () => {
    expect(isKnownRewardToken(GEOD_TOKEN_MINT_SOLANA.toLowerCase())).toBe(false);
    expect(
      classifyRewardIncome(GEOD_TOKEN_MINT_SOLANA.toLowerCase(), GEOD_REWARDS_WALLET_SOLANA)
    ).toBeNull();
    expect(
      classifyRewardIncome(GEOD_TOKEN_MINT_SOLANA, GEOD_REWARDS_WALLET_SOLANA.toLowerCase())
    ).toBeNull();
  });

  it('keeps the Solana and Polygon distributor allowlists separate', () => {
    expect(classifyRewardIncome(GEOD_TOKEN_MINT_SOLANA, GEOD_REWARDS_WALLET_POLYGON)).toBeNull();
    expect(classifyRewardIncome(GEOD_TOKEN_POLYGON, GEOD_REWARDS_WALLET_SOLANA)).toBeNull();
  });
});

describe('classifyRewardIncome — DBT (no regression)', () => {
  it('matches a known Dabba program by prefix/suffix like classifyDbtIncome', () => {
    const prog = DABBA_PROGRAMS[0];
    const counterparty = `${prog.prefix}${'A'.repeat(36)}${prog.suffix}`;
    const r = classifyRewardIncome(DBT_TOKEN_MINT, counterparty);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe(prog.kind);
    expect(r!.label).toBe(prog.label);
  });

  it('falls back to genesis_reward for DBT from an unknown sender', () => {
    const unknown = 'Gh2nJr3gxiYBxFaSGBsi6VVhdefkMYX6jGR3PCD7h8t4';
    const r = classifyRewardIncome(DBT_TOKEN_MINT, unknown);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('genesis_reward');
  });

  it('falls back to genesis_reward for DBT with an UNDEFINED counterparty (ATA balance-change path)', () => {
    // Regression guard: DBT rewards that land as an ATA balance change have no
    // sender, but must still classify as income (not revert to transfer_in).
    const r = classifyRewardIncome(DBT_TOKEN_MINT, undefined);
    expect(r).not.toBeNull();
    expect(r!.kind).toBe('genesis_reward');
  });
});

describe('classifyRewardIncome — unknown mint', () => {
  it('returns null', () => {
    expect(classifyRewardIncome('So11111111111111111111111111111111111111112', GEOD_REWARDS_WALLET_SOLANA)).toBeNull();
  });
});

describe('REWARD_KIND_LABEL', () => {
  it('provides a product-neutral label for mining_reward', () => {
    expect(REWARD_KIND_LABEL.mining_reward).toBe('Mining reward');
  });
});
