import { describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@/types/transaction';
import {
  applyUnifiedIncomingClassifications,
  createReceiptLoader,
  fetchAlchemyEvmInner
} from './providers';
import { ERC_TRANSFER_TOPIC } from './evmDecoder';
import { GEOD_REWARDS_WALLET_POLYGON, GEOD_TOKEN_POLYGON } from '@/lib/assets/rewardRegistry';

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 'tx', timestamp: 1, type: 'transfer_in', asset: 'GEOD', amount: 1,
    fiatCurrency: 'USD', source: 'rpc:moralis', flags: ['possible_internal_transfer'],
    isInternalTransfer: false, chain: 'polygon', ...overrides
  };
}

const wallet = '0x1111111111111111111111111111111111111111';
const aave = '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9';
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const topicAddress = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;

describe('provider unified registry fallback', () => {
  it('preserves high-confidence static behavior without review flag', () => {
    const [result] = applyUnifiedIncomingClassifications([tx({
      contractAddress: GEOD_TOKEN_POLYGON,
      counterpartyAddress: GEOD_REWARDS_WALLET_POLYGON
    })]);
    expect(result.type).toBe('income');
    expect(result.flags).toEqual([]);
  });

  it('keeps non-distribution allocation matches as transfer_in suggestions', () => {
    const [result] = applyUnifiedIncomingClassifications([tx({
      contractAddress: '0x0000000000000000000000000000000000000001',
      counterpartyAddress: '0xfa5fed5cc2b6dd8f370651d17242c52ed711b14f'
    })]);
    expect(result.type).toBe('transfer_in');
    expect(result.flags).toEqual(['needs_review']);
    expect(result.notes).toMatch(/review transfer purpose/i);
  });

  it('loads one receipt at most once for duplicate Alchemy rows sharing a hash', async () => {
    const receipt = { transactionHash: '0xhash', logs: [] };
    const underlying = vi.fn(async () => receipt);
    const load = createReceiptLoader(underlying);
    const [first, second, third] = await Promise.all([
      load('0xHASH'),
      load('0xhash'),
      load('0xHash')
    ]);
    expect(first).toBe(receipt);
    expect(second).toBe(receipt);
    expect(third).toBe(receipt);
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('keeps native rows generic while decoding the ERC row from their shared receipt', async () => {
    const shared = {
      hash: '0xshared',
      from: wallet,
      to: aave,
      value: 1,
      asset: 'ETH',
      metadata: { blockTimestamp: '2026-01-01T00:00:00.000Z' }
    };
    const receiptRequests: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === 'eth_getTransactionReceipt') {
        receiptRequests.push(body.params[0]);
        return new Response(JSON.stringify({
          result: {
            transactionHash: '0xshared',
            logs: [{
              address: usdc,
              topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(aave)],
              data: `0x${1_000_000n.toString(16).padStart(64, '0')}`
            }]
          }
        }), { status: 200 });
      }
      const isOutgoing = Boolean(body.params[0].fromAddress);
      return new Response(JSON.stringify({
        result: {
          transfers: isOutgoing
            ? [
                { ...shared, category: 'external', rawContract: {} },
                { ...shared, category: 'erc20', asset: 'USDC', rawContract: { address: usdc } }
              ]
            : []
        }
      }), { status: 200 });
    });

    const result = await fetchAlchemyEvmInner(wallet, 'eth-mainnet', 'key', 'ETH', 'ethereum');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]).toMatchObject({ asset: 'ETH', type: 'transfer_out' });
    expect(result.transactions[0].notes).toBeUndefined();
    expect(result.transactions[1]).toMatchObject({ asset: 'USDC', type: 'defi_deposit' });
    expect(receiptRequests).toEqual(['0xshared']);
  });
});
