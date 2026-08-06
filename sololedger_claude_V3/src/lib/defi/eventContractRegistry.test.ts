import { describe, expect, it } from 'vitest';
import { fetchDefiEventContractRegistry, type EventRegistryRpc } from './eventContractRegistry';
import { AAVE_DATA_PROVIDER_SELECTORS, PROTOCOL_REGISTRY } from './protocolRegistry';
import { decodeNeutralDefiActions, ERC_TRANSFER_TOPIC } from '@/lib/rpc/evmDecoder';

const pad = (hex: string) => hex.replace(/^0x/, '').padStart(64, '0');
const uint = (value: bigint | number) => pad(BigInt(value).toString(16));
const address = (digit: string) => `0x${digit.repeat(40)}`;
const zero = `0x${'0'.repeat(40)}`;
const reservesResult = (reserve: string) => {
  const bytes = [...new TextEncoder().encode('USDC')].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `0x${uint(32)}${uint(1)}${uint(32)}${uint(64)}${pad(reserve)}${uint(4)}${bytes.padEnd(64, '0')}`;
};
const triple = (index: number) => [address(String(index + 4)), address(String(index + 7)), `0x${String.fromCharCode(97 + index).repeat(40)}`] as const;

describe('exhaustive DeFi event-contract registry', () => {
  it('maps every reserve token at one block without reading wallet positions', async () => {
    const calls: Array<{ method: string; data?: string; block?: string }> = [];
    const entries = Object.values(PROTOCOL_REGISTRY);
    const rpc: EventRegistryRpc = async (method, params) => {
      if (method === 'eth_blockNumber') return '0xabc';
      const [{ to, data }, block] = params as [{ to: string; data: string }, string];
      calls.push({ method, data, block });
      const index = entries.findIndex((entry) => entry.dataProviderAddress.toLowerCase() === to.toLowerCase());
      if (index < 0) throw new Error('unexpected provider');
      if (data === AAVE_DATA_PROVIDER_SELECTORS.getAllReservesTokens) return reservesResult(address(String(index + 1)));
      if (data.startsWith(AAVE_DATA_PROVIDER_SELECTORS.getReserveTokensAddresses)) {
        return `0x${triple(index).map(pad).join('')}`;
      }
      throw new Error('wallet-dependent call must not occur');
    };
    const result = await fetchDefiEventContractRegistry(rpc);
    expect(result.block).toBe('0xabc');
    expect(calls).toHaveLength(entries.length * 2);
    expect(calls.every((call) => call.block === '0xabc')).toBe(true);
    expect(calls.some((call) => call.data?.startsWith(AAVE_DATA_PROVIDER_SELECTORS.getUserReserveData))).toBe(false);
    expect(result.contracts[address('4')]).toMatchObject({ protocolId: 'aave-v2-ethereum', reserveKey: address('1'), role: 'protocol_token' });
    expect(result.contracts[address('7')]).toMatchObject({ protocolId: 'aave-v2-ethereum', reserveKey: address('1'), role: 'debt_token' });
    expect(result.contracts['0xd784927ff2f95ba542bfc824c8a8a98f3495f6b5']).toMatchObject({ protocolId: 'aave-v2-ethereum', role: 'reward_controller' });
    expect(result.contracts['0x25f2226b597e8f9514b3f68f00f494cf4f286491']).toMatchObject({ protocolId: 'aave-v2-ethereum', role: 'reward_source' });
    expect(result.contracts['0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9']).toMatchObject({ protocolId: 'aave-v2-ethereum', reserveKey: '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', role: 'reward' });
    expect(result.contracts['0x8164cc65827dcfe994ab23944cbc90e0aa80bfcb']).toMatchObject({ protocolId: 'aave-v3-ethereum', role: 'reward_controller' });
    expect(result.contracts['0x4370d3b6c9588e02ce9d22e684387859c7ff5b34']).toMatchObject({ protocolId: 'spark-v1-ethereum', role: 'reward_controller' });
  });

  it('decodes fully withdrawn historical activity on first import with no wallet-position read', async () => {
    const entries = Object.values(PROTOCOL_REGISTRY);
    const rpc: EventRegistryRpc = async (method, params) => {
      if (method === 'eth_blockNumber') return '0x1';
      const [{ to, data }] = params as [{ to: string; data: string }, string];
      const index = entries.findIndex((entry) => entry.dataProviderAddress.toLowerCase() === to.toLowerCase());
      if (index < 0) throw new Error('unexpected provider');
      if (data === AAVE_DATA_PROVIDER_SELECTORS.getAllReservesTokens) return reservesResult(address(String(index + 1)));
      if (data.startsWith(AAVE_DATA_PROVIDER_SELECTORS.getReserveTokensAddresses)) return `0x${triple(index).map(pad).join('')}`;
      throw new Error('unexpected call');
    };
    const { contracts } = await fetchDefiEventContractRegistry(rpc);
    const wallet = address('9');
    const pool = PROTOCOL_REGISTRY['aave-v2-ethereum'].poolAddress;
    const reserve = address('1');
    const aToken = address('4');
    const amount = 1_000_000n;
    const topicAddress = (value: string) => `0x${'0'.repeat(24)}${value.slice(2)}`;
    const actions = decodeNeutralDefiActions({
      transactionHash: '0xhistorical', from: wallet, gasUsed: '0x5208', effectiveGasPrice: '0x1',
      logs: [
        { address: reserve, logIndex: 1, topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(pool)], data: `0x${uint(amount)}` },
        { address: aToken, logIndex: 2, topics: [ERC_TRANSFER_TOPIC, topicAddress(address('0')), topicAddress(wallet)], data: `0x${uint(amount - 1n)}` },
        { address: pool, logIndex: 3, topics: ['0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951', topicAddress(reserve), topicAddress(wallet), `0x${'0'.repeat(64)}`], data: `${topicAddress(wallet)}${uint(amount)}` }
      ]
    }, 1, contracts, wallet);
    expect(actions).toEqual([expect.objectContaining({ type: 'supply', complete: true, reserveKey: reserve })]);
  });

  it('propagates cancellation through the active RPC and issues no later sequential reserve calls', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const rpc: EventRegistryRpc = async (method, _params, signal) => {
      calls.push(method);
      if (method === 'eth_blockNumber') return '0x1';
      return await new Promise<unknown>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    };
    const pending = fetchDefiEventContractRegistry(rpc, undefined, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toEqual(['eth_blockNumber', 'eth_call']);
  });

  it.each([
    ['empty protocol reserve list', 'empty'],
    ['zero token address', 'zero'],
    ['truncated reserve-token triple', 'truncated'],
    ['duplicate token in one triple', 'triple-duplicate'],
    ['conflicting token across protocols', 'cross-protocol-duplicate']
  ])('rejects the whole registry atomically for %s', async (_label, failure) => {
    const entries = Object.values(PROTOCOL_REGISTRY);
    const rpc: EventRegistryRpc = async (method, params) => {
      if (method === 'eth_blockNumber') return '0x2';
      const [{ to, data }] = params as [{ to: string; data: string }, string];
      const index = entries.findIndex((entry) => entry.dataProviderAddress.toLowerCase() === to.toLowerCase());
      if (data === AAVE_DATA_PROVIDER_SELECTORS.getAllReservesTokens) {
        if (failure === 'empty' && index === 1) return `0x${uint(32)}${uint(0)}`;
        return reservesResult(address(String(index + 1)));
      }
      if (failure === 'truncated' && index === 1) return `0x${pad(triple(index)[0])}${pad(triple(index)[1])}`;
      const tokens = [...triple(index)];
      if (failure === 'zero' && index === 1) tokens[0] = zero;
      if (failure === 'triple-duplicate' && index === 1) tokens[2] = tokens[1];
      if (failure === 'cross-protocol-duplicate' && index === 1) tokens[0] = triple(0)[0];
      return `0x${tokens.map(pad).join('')}`;
    };
    await expect(fetchDefiEventContractRegistry(rpc)).rejects.toThrow(/registry|truncated/i);
  });
});
