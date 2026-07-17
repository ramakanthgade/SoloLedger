import { describe, it, expect } from 'vitest';
import { isBridgeType, bridgeIsInternalTransfer, novesTxTypeToSoloLedger } from './noves';
import type { NovesTransfer } from './noves';

function transfer(action: string, symbol: string, amount: string): NovesTransfer {
  return { action, amount, token: { symbol, address: '0x', decimals: 18 } };
}

describe('Noves bridge classification (C1)', () => {
  it('detects bridge type strings', () => {
    expect(isBridgeType('bridge')).toBe(true);
    expect(isBridgeType('bridgeDeposit')).toBe(true);
    expect(isBridgeType('swap')).toBe(false);
  });

  it('base bridge maps to transfer_out by default', () => {
    expect(novesTxTypeToSoloLedger('bridge')).toBe('transfer_out');
  });

  it('treats a bridge with both out and in legs as an internal transfer', () => {
    const sent = [transfer('sent', 'USDC', '1000')];
    const received = [transfer('received', 'USDC', '999')];
    expect(bridgeIsInternalTransfer(sent, received)).toBe(true);
  });

  it('ignores gas/fee-only legs when deciding bidirectionality', () => {
    const sent = [transfer('sent', 'USDC', '1000')];
    const gasOnly = [transfer('paidGas', 'ETH', '0.001')];
    // Out leg + only a gas leg on the received side → not both real legs, but
    // a matching inbound found on the destination chain makes it internal.
    expect(bridgeIsInternalTransfer(sent, gasOnly)).toBe(false);
    expect(bridgeIsInternalTransfer(sent, gasOnly, true)).toBe(true);
  });

  it('uses a matched inbound on the destination chain to mark internal transfer', () => {
    const sent = [transfer('sent', 'USDC', '1000')];
    expect(bridgeIsInternalTransfer(sent, [], false)).toBe(false);
    expect(bridgeIsInternalTransfer(sent, [], true)).toBe(true);
  });
});
