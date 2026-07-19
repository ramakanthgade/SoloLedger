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
  it('matches across space/underscore/dash/case variants', () => {
    expect(resolveTxType('Crypto Purchase', DEFAULT_TYPE_VALUE_MAP)).toBe('buy');
    expect(resolveTxType('crypto_purchase', DEFAULT_TYPE_VALUE_MAP)).toBe('buy');
    expect(resolveTxType('crypto-purchase', DEFAULT_TYPE_VALUE_MAP)).toBe('buy');
    expect(resolveTxType('CRYPTO PURCHASE', DEFAULT_TYPE_VALUE_MAP)).toBe('buy');
    expect(resolveTxType('ACH Deposit', DEFAULT_TYPE_VALUE_MAP)).toBe('transfer_in');
    expect(resolveTxType('ach_withdrawal', DEFAULT_TYPE_VALUE_MAP)).toBe('transfer_out');
    expect(resolveTxType('Bitcoin Deposit', DEFAULT_TYPE_VALUE_MAP)).toBe('transfer_in');
    expect(resolveTxType('bitcoin-withdrawal', DEFAULT_TYPE_VALUE_MAP)).toBe('transfer_out');
    expect(resolveTxType('Market Buy', DEFAULT_TYPE_VALUE_MAP)).toBe('buy');
  });
  it('keeps the ach/bitcoin/reward mappings required by UI pre-seeding', () => {
    expect(DEFAULT_TYPE_VALUE_MAP['ach deposit']).toBe('transfer_in');
    expect(DEFAULT_TYPE_VALUE_MAP['ach withdrawal']).toBe('transfer_out');
    expect(DEFAULT_TYPE_VALUE_MAP['bitcoin deposit']).toBe('transfer_in');
    expect(DEFAULT_TYPE_VALUE_MAP['bitcoin withdrawal']).toBe('transfer_out');
    expect(DEFAULT_TYPE_VALUE_MAP['reward']).toBe('income');
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

  it('stores a real 64-hex ADA txid as txHash (unlinkable but still shown as plain text)', () => {
    const adaTxid = '908a367e192d9fb46e65a813c9ac34f13c09131d08588da62506d5affed010d1'.slice(0, 64);
    const rows = [
      {
        Time: '2023-11-22 22:53:58',
        Coin: 'ADA',
        Network: 'ADA',
        Side: 'Withdrawl',
        Amount: '1282.5736',
        Fee: '0.8',
        Address: 'addr1qx078n2l286rp0df74jf2jpgemy6g56hhvtd880779c5uz2us3y0wtmpgz4c4k77eq7zp6gn6asdz26elpen293zemms29llpq',
        TXID: adaTxid,
        Status: 'Completed'
      }
    ];
    const { transactions } = parseWithMapping(rows, WITHDRAW_MAPPING, 'USD');
    expect(transactions[0].chain).toBe('cardano');
    // A real, well-formed 64-hex Cardano txid IS stored as txHash now — Review
    // shows it as plain text (explorerTxUrl still returns null for cardano,
    // so it never becomes a link), instead of falling back to the synthetic
    // chash: sourceRef.
    expect(transactions[0].txHash).toBe(adaTxid);
  });

  it('does NOT store a truncated/invalid ETH TXID as txHash (no broken link)', () => {
    const rows = [
      {
        Time: '2024-02-25 16:25:22',
        Coin: 'USDC',
        Network: 'ETH',
        Side: 'Withdrawl',
        Amount: '10',
        Fee: '1',
        Address: ETH_ADDR,
        TXID: '0xdeadbeef',
        Status: 'Completed'
      }
    ];
    const { transactions } = parseWithMapping(rows, WITHDRAW_MAPPING, 'USD');
    expect(transactions[0].chain).toBe('ethereum');
    expect(transactions[0].txHash).toBeUndefined();
  });

  it('stores a full 64-hex BTC txid (no 0x) with chain bitcoin', () => {
    const btcTxid = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b';
    const rows = [
      {
        Time: '2024-02-25 16:25:22',
        Coin: 'BTC',
        Network: 'BTC',
        Side: 'Withdrawl',
        Amount: '0.05',
        Fee: '0.0001',
        Address: 'bc1qxy',
        TXID: btcTxid,
        Status: 'Completed'
      }
    ];
    const { transactions } = parseWithMapping(rows, WITHDRAW_MAPPING, 'USD');
    expect(transactions[0].chain).toBe('bitcoin');
    expect(transactions[0].txHash).toBe(btcTxid);
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
