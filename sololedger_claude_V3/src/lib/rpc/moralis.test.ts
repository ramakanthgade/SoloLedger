import { describe, expect, it } from 'vitest';
import { moralisTxToRows, type MoralisTransaction } from './moralis';

const wallet = '0x1111111111111111111111111111111111111111';
const txBase: MoralisTransaction = {
  hash: '0xhash',
  block_timestamp: '2026-01-01T00:00:00.000Z',
  from_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  to_address: wallet,
  value: '0',
  receipt_status: '1',
  category: 'receive',
  summary: 'Received native assets',
  possible_spam: false,
  erc20_transfers: [],
  native_transfers: [],
  nft_transfers: []
};

describe('Moralis native transfer mapping', () => {
  it('uses each native transfer leg addresses rather than transaction-level parties', () => {
    const legSender = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const [row] = moralisTxToRows({
      ...txBase,
      native_transfers: [{
        from_address: legSender,
        to_address: wallet,
        direction: 'receive',
        value_formatted: '1.25',
        token_symbol: 'ETH'
      }]
    }, wallet, 'ETH', 'ethereum');
    expect(row).toMatchObject({ type: 'transfer_in', counterpartyAddress: legSender, amount: 1.25 });
  });

  it('falls back to transaction-level parties only when a native leg omits them', () => {
    const [row] = moralisTxToRows({
      ...txBase,
      native_transfers: [{
        direction: 'receive',
        value_formatted: '0.5',
        token_symbol: 'ETH'
      }]
    }, wallet, 'ETH', 'ethereum');
    expect(row.counterpartyAddress).toBe(txBase.from_address);
  });
});
