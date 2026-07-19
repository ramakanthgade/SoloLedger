import { describe, expect, it } from 'vitest';
import { decodeEvmReceipt, ERC_TRANSFER_TOPIC } from './evmDecoder';

const wallet = '0x1111111111111111111111111111111111111111';
const rewards = '0x25f2226b597e8f9514b3f68f00f494cf4f286491';
const topicAddress = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;

describe('EVM receipt decoder', () => {
  it('decodes verified ERC-20 Transfer topics with known decimals', () => {
    const result = decodeEvmReceipt({
      transactionHash: '0xhash',
      logs: [{
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        topics: [ERC_TRANSFER_TOPIC, topicAddress(rewards), topicAddress(wallet)],
        data: `0x${(1_500_000n).toString(16).padStart(64, '0')}`
      }]
    }, wallet);
    expect(result).toMatchObject({ type: 'income', asset: 'USDC', amount: 1.5, rawAmount: '1500000' });
  });

  it('preserves raw amount instead of assuming 18 decimals for unknown tokens', () => {
    const result = decodeEvmReceipt({
      transactionHash: '0xhash',
      logs: [{
        address: '0x9999999999999999999999999999999999999999',
        topics: [ERC_TRANSFER_TOPIC, topicAddress(rewards), topicAddress(wallet)],
        data: `0x${123n.toString(16).padStart(64, '0')}`
      }]
    }, wallet);
    expect(result?.amount).toBeUndefined();
    expect(result?.rawAmount).toBe('123');
  });

  it('does not misread ERC-721 Transfer logs as ERC-20', () => {
    expect(decodeEvmReceipt({
      transactionHash: '0xhash',
      logs: [{
        address: '0x9999999999999999999999999999999999999999',
        topics: [ERC_TRANSFER_TOPIC, topicAddress(rewards), topicAddress(wallet), `0x${'0'.repeat(63)}1`],
        data: '0x'
      }]
    }, wallet)).toBeNull();
  });
});
