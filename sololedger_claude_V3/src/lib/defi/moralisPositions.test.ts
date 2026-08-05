import { describe, expect, it } from 'vitest';
import { normalizeMoralisPositions } from './moralisPositions';

const reserve = `0x${'1'.repeat(40)}`;
const protocolToken = (digit: string, tokenType: string, balance: string, extras: Record<string, unknown> = {}) => ({
  token_type: tokenType,
  contract_address: reserve,
  protocol_token_address: `0x${digit.repeat(40)}`,
  symbol: 'USDC', decimals: 6, balance: String(Math.round(Number(balance) * 1e6)), balance_formatted: balance,
  ...extras
});

describe('Moralis detailed position normalization', () => {
  it('emits one collateral-marked supply and positive stable/variable debt magnitudes', () => {
    const result = normalizeMoralisPositions({ complete: true, result: [
      { position_type: 'lending', tokens: [protocolToken('2', 'supply', '10', { is_collateral: true })] },
      { position_type: 'borrowing', tokens: [
        protocolToken('3', 'stable-debt', '2', { rate_mode: 'stable' }),
        protocolToken('4', 'variable-debt', '3', { rate_mode: 'variable' })
      ] }
    ] }, 'aave-v3-ethereum', 100);
    expect(result.status).toBe('complete');
    if (result.status === 'unsupported') throw new Error('unexpected');
    expect(result.rows).toEqual([
      expect.objectContaining({ role: 'supply', quantity: 10, isCollateral: true }),
      expect.objectContaining({ role: 'debt', quantity: 2, debtRateMode: 'stable' }),
      expect.objectContaining({ role: 'debt', quantity: 3, debtRateMode: 'variable' })
    ]);
  });
  it('treats missing requested debt completeness as partial rather than empty', () => {
    const result = normalizeMoralisPositions({ result: [{ position_type: 'lending', tokens: [protocolToken('2', 'supply', '1')] }] }, 'aave-v2-ethereum');
    expect(result.status).toBe('partial');
  });
  it('accepts an explicitly complete empty protocol', () => expect(normalizeMoralisPositions({ complete: true, result: [] }, 'spark-v1-ethereum')).toMatchObject({ status: 'complete', rows: [] }));
  it('drops repay-to-zero rows without fabricating debt', () => {
    const result = normalizeMoralisPositions({ complete: true, result: [{ position_type: 'borrowing', tokens: [protocolToken('4', 'variable-debt', '0', { rate_mode: 'variable' })] }] }, 'aave-v3-ethereum');
    if (result.status === 'unsupported') throw new Error('unexpected');
    expect(result.rows).toEqual([]);
  });
  it('uses the captured Moralis raw/formatted shape without inflating one USDC', () => {
    const result = normalizeMoralisPositions({ complete: true, result: [{ position_type: 'lending', tokens: [{
      token_type: 'supply', contract_address: reserve, protocol_token_address: `0x${'2'.repeat(40)}`,
      label: 'USD Coin', symbol: 'USDC', decimals: 6, balance: '1000000', balance_formatted: '1.0'
    }] }] }, 'aave-v3-ethereum');
    if (result.status === 'unsupported') throw new Error('unexpected');
    expect(result.rows).toEqual([expect.objectContaining({ quantity: 1, rawQuantity: '1000000', underlying: expect.objectContaining({ symbol: 'USDC' }) })]);
  });
});
