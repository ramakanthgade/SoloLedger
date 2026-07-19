import { describe, expect, it } from 'vitest';
import { decodeEvmReceipt, decodeEvmReceiptForTransfer, ERC_TRANSFER_TOPIC } from './evmDecoder';

const wallet = '0x1111111111111111111111111111111111111111';
const rewards = '0x25f2226b597e8f9514b3f68f00f494cf4f286491';
const other = '0x2222222222222222222222222222222222222222';
const topicAddress = (address: string) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const data = (amount: bigint) => `0x${amount.toString(16).padStart(64, '0')}`;

describe('EVM receipt decoder', () => {
  it('decodes verified ERC-20 Transfer topics with known decimals', () => {
    const result = decodeEvmReceipt({
      transactionHash: '0xhash',
      logs: [{
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        topics: [ERC_TRANSFER_TOPIC, topicAddress(rewards), topicAddress(wallet)],
        data: data(1_500_000n)
      }]
    }, wallet);
    expect(result).toMatchObject({ type: 'income', asset: 'USDC', amount: 1.5, rawAmount: '1500000' });
  });

  it('correlates a specific Alchemy row in a multi-log receipt', () => {
    const receipt = {
      transactionHash: '0xhash',
      logs: [
        {
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          topics: [ERC_TRANSFER_TOPIC, topicAddress(rewards), topicAddress(wallet)],
          data: data(2_000_000n)
        },
        {
          address: '0x6b175474e89094c44da98b954eedeac495271d0f',
          topics: [ERC_TRANSFER_TOPIC, topicAddress(other), topicAddress(wallet)],
          data: data(3_000_000_000_000_000_000n)
        }
      ]
    };

    const dai = decodeEvmReceiptForTransfer(receipt, wallet, {
      contractAddress: '0x6b175474e89094c44da98b954eedeac495271d0f',
      direction: 'transfer_in',
      from: other,
      to: wallet
    });
    expect(dai).toMatchObject({ type: 'transfer_in', asset: 'DAI', counterpartyAddress: other });
    expect(dai?.notes).toBeUndefined();
    expect(decodeEvmReceiptForTransfer(receipt, wallet, {
      contractAddress: '0x6b175474e89094c44da98b954eedeac495271d0f',
      direction: 'transfer_in',
      from: rewards,
      to: wallet
    })).toBeNull();
  });

  it('preserves raw amount instead of assuming 18 decimals for unknown tokens', () => {
    const result = decodeEvmReceipt({
      transactionHash: '0xhash',
      logs: [{
        address: '0x9999999999999999999999999999999999999999',
        topics: [ERC_TRANSFER_TOPIC, topicAddress(rewards), topicAddress(wallet)],
        data: data(123n)
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

  it('ignores malformed logs and classifies outgoing router legs without contaminating direction', () => {
    const router = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
    const receipt = {
      transactionHash: '0xhash',
      logs: [
        { address: '0x9999999999999999999999999999999999999999', topics: [ERC_TRANSFER_TOPIC, '0xbad', topicAddress(wallet)], data: '0xzz' },
        { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', topics: [ERC_TRANSFER_TOPIC, topicAddress(wallet), topicAddress(router)], data: data(2_000_000n) }
      ]
    };
    expect(decodeEvmReceiptForTransfer(receipt, wallet, {
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', direction: 'transfer_out', from: wallet, to: router
    })).toMatchObject({ type: 'trade', amount: 2, counterpartyAddress: router, rawAmount: '2000000' });
    expect(decodeEvmReceiptForTransfer(receipt, wallet, {
      contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', direction: 'transfer_in', from: router, to: wallet
    })).toBeNull();
  });
});
