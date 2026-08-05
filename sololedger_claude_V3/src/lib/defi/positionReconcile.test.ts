import { describe, expect, it } from 'vitest';
import { reconcilePositionEvidence, unsupportedPositionRequest } from './positionReconcile';
import type { DefiPositionResult, DefiPositionRow } from './types';

const token = (address: string, symbol = 'USDC') => ({ chainId: 1 as const, contractAddress: address, symbol, decimals: 6 });
const row = (quantity: number, role: 'supply' | 'debt' = 'supply'): DefiPositionRow => role === 'supply' ? {
  id: 'x', snapshotId: '', protocolId: 'aave-v3-ethereum', reserveKey: '0x0000000000000000000000000000000000000001', role,
  underlying: token('0x0000000000000000000000000000000000000001'), protocolToken: token('0x0000000000000000000000000000000000000002', 'aUSDC'), quantity, rawQuantity: String(quantity * 1e6), isCollateral: true
} : {
  id: 'd', snapshotId: '', protocolId: 'aave-v3-ethereum', reserveKey: '0x0000000000000000000000000000000000000001', role,
  underlying: token('0x0000000000000000000000000000000000000001'), protocolToken: token('0x0000000000000000000000000000000000000003', 'variableDebtUSDC'), quantity, rawQuantity: String(quantity * 1e6), debtRateMode: 'variable'
};
const result = (rows: DefiPositionRow[], status: 'complete' | 'partial' = 'complete'): Exclude<DefiPositionResult, { status: 'unsupported' }> => ({ status, chainId: 1, protocolId: 'aave-v3-ethereum', rows, evidence: [{ provider: 'ethereum-rpc', status, detail: 'fixture' }], warnings: [] });

describe('position evidence reconciliation', () => {
  it('returns typed unsupported for non-Ethereum without reads', () => expect(unsupportedPositionRequest({ chainId: 137, protocolId: 'aave-v3-ethereum', address: '0x0' })).toMatchObject({ status: 'unsupported', rows: [] }));
  it('accepts exhaustive RPC fallback when Moralis is unavailable', () => expect(reconcilePositionEvidence(undefined, result([row(10)]))).toMatchObject({ status: 'complete', rows: [expect.objectContaining({ quantity: 10 })] }));
  it('fails closed on provider disagreement and retains direct debt only', () => {
    const reconciled = reconcilePositionEvidence(result([row(11)]), result([row(10), row(4, 'debt')]));
    expect(reconciled.status).toBe('partial');
    expect(reconciled.rows).toEqual([expect.objectContaining({ role: 'debt', quantity: 4 })]);
  });
  it('never upgrades partial RPC evidence from Moralis supply', () => expect(reconcilePositionEvidence(result([row(10)]), result([], 'partial'))).toMatchObject({ status: 'partial', rows: [] }));
  it('merges corroborating Moralis valuation into exact same-quantity RPC authority', () => {
    const moralisRow = { ...row(10), valueEvidence: { currency: 'USD' as const, value: 10, observedAt: 5, provider: 'moralis' } };
    expect(reconcilePositionEvidence(result([moralisRow]), result([row(10)]))).toMatchObject({
      status: 'complete', rows: [expect.objectContaining({ valueEvidence: moralisRow.valueEvidence })]
    });
  });
});
