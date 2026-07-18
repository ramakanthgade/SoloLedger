import { describe, it, expect } from 'vitest';
import {
  parseWithMapping,
  resolveTxType,
  inferOptionalColumns,
  DEFAULT_TYPE_VALUE_MAP,
  type ColumnMapping
} from './generic';
import { genericHistoryParser } from './genericHistory';

const SOL_HASH =
  '4LTQVKtCoEjceydPPzEpfUa554osbph1msH9K9gUnX79bgdk2AarFUSbeFwBwRdru2VtewvkAjtZeAVnSBzXkxA6';
const ETH_HASH = '0x64ae15d0282286fd2d21c102c24ec35739d74cdd70f468cb0884c04a6f99904c';
const SOL_ADDR = 'CgSF2tG4uD2EuSuoYBxwySqdaPKqgcbzSGLbRdfBtgfp';
const ETH_ADDR = '0x475E5b507a1d028773b60B2b32830b61A6820579';

/** Binance "Withdraw History" layout — Side is the misspelled "Withdrawl". */
const WITHDRAW_HEADERS = ['Time', 'Coin', 'Network', 'Side', 'Amount', 'Fee', 'Address', 'TXID', 'Status'];
const WITHDRAW_MAPPING: ColumnMapping = {
  timestamp: 'Time',
  type: 'Side',
  asset: 'Coin',
  amount: 'Amount',
  feeAmount: 'Fee',
  typeValueMap: DEFAULT_TYPE_VALUE_MAP,
  assetIsTradingPair: false
};

describe('resolveTxType', () => {
  it('resolves the Binance misspelling "Withdrawl" to transfer_out', () => {
    expect(resolveTxType('Withdrawl', DEFAULT_TYPE_VALUE_MAP)).toBe('transfer_out');
  });
  it('resolves "Deposit" to transfer_in', () => {
    expect(resolveTxType('Deposit', DEFAULT_TYPE_VALUE_MAP)).toBe('transfer_in');
  });
  it('exact-map lookup still works (buy/sell)', () => {
    expect(resolveTxType('buy', DEFAULT_TYPE_VALUE_MAP)).toBe('buy');
    expect(resolveTxType('sell', DEFAULT_TYPE_VALUE_MAP)).toBe('sell');
  });
  it('substring fallback covers unknown withdraw/deposit variants', () => {
    expect(resolveTxType('Crypto Withdrawal Completed', DEFAULT_TYPE_VALUE_MAP)).toBe('transfer_out');
    expect(resolveTxType('Fiat Deposit', DEFAULT_TYPE_VALUE_MAP)).toBe('transfer_in');
  });
  it('returns undefined for unknown non-transfer types', () => {
    expect(resolveTxType('foobar', DEFAULT_TYPE_VALUE_MAP)).toBeUndefined();
    expect(resolveTxType('', DEFAULT_TYPE_VALUE_MAP)).toBeUndefined();
  });
});

describe('inferOptionalColumns', () => {
  it('detects Network / TXID / ambiguous Address from Binance withdrawal headers', () => {
    const cols = inferOptionalColumns(WITHDRAW_HEADERS);
    expect(cols.network).toBe('Network');
    expect(cols.txHash).toBe('TXID');
    expect(cols.address).toBe('Address');
    expect(cols.toAddress).toBeUndefined();
    expect(cols.fromAddress).toBeUndefined();
  });
  it('detects "TX ID" (spaced) as txHash', () => {
    expect(inferOptionalColumns(['Time', 'TX ID']).txHash).toBe('TX ID');
  });
  it('prefers clearly-named To/From and suppresses ambiguous address then', () => {
    const cols = inferOptionalColumns(['To', 'From', 'Address']);
    expect(cols.toAddress).toBe('To');
    expect(cols.fromAddress).toBe('From');
    expect(cols.address).toBeUndefined();
  });
});

describe('parseWithMapping — withdrawal robustness + chain/txHash/address (Issues 4 & 5)', () => {
  it('parses a SOL withdrawal row (misspelled Side) with chain/txHash/counterparty', () => {
    const rows = [
      {
        Time: '2024-03-08 13:00:40',
        Coin: 'SOL',
        Network: 'SOL',
        Side: 'Withdrawl',
        Amount: '10',
        Fee: '0.01',
        Address: SOL_ADDR,
        TXID: SOL_HASH,
        Status: 'Completed'
      }
    ];
    const { transactions, addressColumnAmbiguous } = parseWithMapping(rows, WITHDRAW_MAPPING, 'USD');
    expect(transactions).toHaveLength(1);
    const t = transactions[0];
    expect(t.type).toBe('transfer_out');
    expect(t.chain).toBe('solana');
    expect(t.txHash).toBe(SOL_HASH);
    expect(t.counterpartyAddress).toBe(SOL_ADDR);
    expect(t.walletAddress).toBeUndefined();
    expect(t.sourceRef?.startsWith('chash:')).toBe(true);
    expect(addressColumnAmbiguous).toBe(true);
  });

  it('parses an ETH withdrawal (Network ETH, 0x TXID)', () => {
    const rows = [
      {
        Time: '2024-02-25 16:25:22',
        Coin: 'USDC',
        Network: 'ETH',
        Side: 'Withdrawl',
        Amount: '2989.37',
        Fee: '7',
        Address: ETH_ADDR,
        TXID: ETH_HASH,
        Status: 'Completed'
      }
    ];
    const { transactions } = parseWithMapping(rows, WITHDRAW_MAPPING, 'USD');
    expect(transactions[0].chain).toBe('ethereum');
    expect(transactions[0].txHash).toBe(ETH_HASH);
  });

  it('handles an ADA row → chain cardano, no crash', () => {
    const rows = [
      {
        Time: '2024-02-25 16:25:22',
        Coin: 'ADA',
        Network: 'ADA',
        Side: 'Withdrawl',
        Amount: '100',
        Fee: '0.2',
        Address: 'addr1qxy',
        TXID: 'ada_tx_ref_that_is_not_a_hash',
        Status: 'Completed'
      }
    ];
    const { transactions } = parseWithMapping(rows, WITHDRAW_MAPPING, 'USD');
    expect(transactions[0].chain).toBe('cardano');
    // ADA ref is not a recognized hash shape → not stored as txHash.
    expect(transactions[0].txHash).toBeUndefined();
  });

  it('parses a deposit row (implied transfer_in) → walletAddress = Address, TX ID hash', () => {
    const rows = [
      {
        Time: '2024-03-08 12:48:31',
        Coin: 'USDT',
        Network: 'ETH',
        Amount: '300',
        Address: ETH_ADDR,
        'TX ID': ETH_HASH,
        Status: 'Completed'
      }
    ];
    const mapping: ColumnMapping = {
      timestamp: 'Time',
      type: '__t',
      asset: 'Coin',
      amount: 'Amount',
      typeValueMap: { transfer_in: 'transfer_in' },
      assetIsTradingPair: false
    };
    const withType = rows.map((r) => ({ ...r, __t: 'transfer_in' }));
    const { transactions, addressColumnAmbiguous } = parseWithMapping(withType, mapping, 'USD');
    expect(transactions[0].type).toBe('transfer_in');
    expect(transactions[0].walletAddress).toBe(ETH_ADDR);
    expect(transactions[0].counterpartyAddress).toBeUndefined();
    expect(transactions[0].chain).toBe('ethereum');
    expect(transactions[0].txHash).toBe(ETH_HASH);
    expect(addressColumnAmbiguous).toBe(true);
  });

  it('maps clearly-named From/To per asymmetric semantics (not ambiguous)', () => {
    const rows = [
      {
        Time: '2024-01-01 00:00:00',
        Coin: 'ETH',
        Type: 'Deposit',
        Amount: '1',
        From: '0xfromCounterparty',
        To: '0xmyWallet'
      },
      {
        Time: '2024-01-02 00:00:00',
        Coin: 'ETH',
        Type: 'Withdrawal',
        Amount: '2',
        From: '0xmyWallet',
        To: '0xtoCounterparty'
      }
    ];
    const mapping: ColumnMapping = {
      timestamp: 'Time',
      type: 'Type',
      asset: 'Coin',
      amount: 'Amount',
      typeValueMap: DEFAULT_TYPE_VALUE_MAP,
      assetIsTradingPair: false
    };
    const { transactions, addressColumnAmbiguous } = parseWithMapping(rows, mapping, 'USD');
    // transfer_in: To=wallet, From=counterparty
    expect(transactions[0].walletAddress).toBe('0xmyWallet');
    expect(transactions[0].counterpartyAddress).toBe('0xfromCounterparty');
    // transfer_out: To=counterparty, From=wallet
    expect(transactions[1].walletAddress).toBe('0xmyWallet');
    expect(transactions[1].counterpartyAddress).toBe('0xtoCounterparty');
    expect(addressColumnAmbiguous).toBe(false);
  });

  it('auto-infers Network/TXID/Address even when the mapping does not set them (AI/manual shape)', () => {
    const rows = [
      {
        Time: '2024-03-08 13:00:40',
        Coin: 'SOL',
        Network: 'SOL',
        Side: 'Withdrawl',
        Amount: '10',
        Fee: '0.01',
        Address: SOL_ADDR,
        TXID: SOL_HASH,
        Status: 'Completed'
      }
    ];
    // The AI/manual ColumnMapping only sets the core fields.
    const mapping: ColumnMapping = {
      timestamp: 'Time',
      type: 'Side',
      asset: 'Coin',
      amount: 'Amount',
      typeValueMap: DEFAULT_TYPE_VALUE_MAP,
      assetIsTradingPair: false
    };
    const { transactions } = parseWithMapping(rows, mapping, 'USD');
    expect(transactions[0].chain).toBe('solana');
    expect(transactions[0].txHash).toBe(SOL_HASH);
    expect(transactions[0].counterpartyAddress).toBe(SOL_ADDR);
  });
});

describe('genericHistoryParser.detect — withdrawal headers', () => {
  it('still detects the Binance withdrawal header set (date + coin + amount)', () => {
    expect(genericHistoryParser.detect(WITHDRAW_HEADERS)).toBe(true);
  });
});
