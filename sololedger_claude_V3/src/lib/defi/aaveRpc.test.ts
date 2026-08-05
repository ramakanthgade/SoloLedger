import { describe, expect, it } from 'vitest';
import { fetchAaveCompatibleRpcPositions, type EthereumRpcCall } from './aaveRpc';
import { AAVE_DATA_PROVIDER_SELECTORS, PROTOCOL_REGISTRY } from './protocolRegistry';

const pad = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
const uint = (value: bigint | number) => pad(BigInt(value).toString(16));
const address = (digit: string) => `0x${digit.repeat(40)}`;
const addrWord = (value: string) => pad(value);
const stringResult = (value: string) => {
  const bytes = [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `0x${uint(32)}${uint(value.length)}${bytes.padEnd(64, '0')}`;
};
const reservesResult = () => {
  const bytes = [...new TextEncoder().encode('USDC')].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `0x${uint(32)}${uint(1)}${uint(32)}${uint(64)}${addrWord(address('1'))}${uint(4)}${bytes.padEnd(64, '0')}`;
};

describe('same-block Aave-compatible direct reads', () => {
  it('reads supply once with collateral metadata and both positive debt modes at one block', async () => {
    const entry = PROTOCOL_REGISTRY['aave-v3-ethereum'];
    const calls: Array<{ to?: string; data?: string; block?: unknown }> = [];
    const rpc: EthereumRpcCall = async (method, params) => {
      if (method === 'eth_blockNumber') return '0x1234';
      const [{ to, data }, block] = params as [{ to: string; data: string }, string];
      calls.push({ to, data, block });
      if (to.toLowerCase() === entry.dataProviderAddress.toLowerCase() && data === AAVE_DATA_PROVIDER_SELECTORS.getAllReservesTokens) return reservesResult();
      if (data.startsWith(AAVE_DATA_PROVIDER_SELECTORS.getUserReserveData)) return `0x${uint(10_000_000)}${uint(2_000_000)}${uint(3_000_000)}${uint(0)}${uint(0)}${uint(0)}${uint(0)}${uint(0)}${uint(1)}`;
      if (data.startsWith(AAVE_DATA_PROVIDER_SELECTORS.getReserveTokensAddresses)) return `0x${addrWord(address('2'))}${addrWord(address('3'))}${addrWord(address('4'))}`;
      if (data === AAVE_DATA_PROVIDER_SELECTORS.decimals) return `0x${uint(6)}`;
      if (data === AAVE_DATA_PROVIDER_SELECTORS.symbol) return stringResult(to === address('1') ? 'USDC' : to === address('2') ? 'aUSDC' : to === address('3') ? 'stableDebtUSDC' : 'variableDebtUSDC');
      throw new Error('unexpected call');
    };
    const result = await fetchAaveCompatibleRpcPositions(address('9'), 'aave-v3-ethereum', rpc);
    expect(result).toMatchObject({ status: 'complete', blockNumber: 4660, rows: [
      expect.objectContaining({ role: 'supply', quantity: 10, isCollateral: true }),
      expect.objectContaining({ role: 'debt', quantity: 2, debtRateMode: 'stable' }),
      expect.objectContaining({ role: 'debt', quantity: 3, debtRateMode: 'variable' })
    ] });
    expect(calls.every((call) => call.block === '0x1234')).toBe(true);
  });
});
