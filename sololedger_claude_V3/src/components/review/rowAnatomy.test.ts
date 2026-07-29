import { describe, it, expect } from 'vitest';
import type { Transaction } from '@/types/transaction';
import {
  buildTxSummary,
  txFlow,
  truncateAddress,
  OWN_ACCOUNT_SIDE,
  type FlowCtx,
  type SummaryCtx
} from './rowAnatomy';

let seq = 0;
function tx(over: Partial<Transaction>): Transaction {
  seq += 1;
  return {
    id: `tx${seq}`,
    timestamp: Date.UTC(2026, 2, 1, 14, 30),
    type: 'buy',
    asset: 'BTC',
    amount: 0.5,
    fiatCurrency: 'USD',
    source: 'binance',
    flags: [],
    isInternalTransfer: false,
    ...over
  } as Transaction;
}

const LEDGER_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER_ADDR = '0xaaaaaaaabbbbbbbbccccccccddddddddeeeeeeee';

const resolveWallet = (addr: string) =>
  addr.toLowerCase() === LEDGER_ADDR.toLowerCase() ? 'Ledger' : undefined;

const flowCtx = (over?: Partial<FlowCtx>): FlowCtx => ({
  assetLabel: 'BTC',
  ...over
});

const summaryCtx = (over?: Partial<SummaryCtx>): SummaryCtx => ({
  assetLabel: 'BTC',
  sourceLabel: 'Binance',
  typeLabel: 'Buy',
  ...over
});

describe('truncateAddress', () => {
  it('shortens long addresses and passes short ones through', () => {
    expect(truncateAddress(LEDGER_ADDR)).toBe('0x1234…5678');
    expect(truncateAddress('short')).toBe('short');
    expect(truncateAddress(undefined)).toBe('—');
  });
});

describe('txFlow — the row-face sent → received flow', () => {
  it('trade: both asset legs with cost basis under the sent leg and value + gain under the received leg', () => {
    const t = tx({
      type: 'trade',
      asset: 'LPT',
      amount: 954.5,
      counterAsset: 'USDT',
      counterAmount: 4850.6,
      fiatCurrency: 'INR',
      fiatValue: 404700
    });
    const flow = txFlow(t, flowCtx({
      assetLabel: 'LPT',
      counterLabel: 'USDT',
      disposal: { costBasis: 416389.81, gain: -11689.81 }
    }));
    expect(flow.sent).toMatchObject({ kind: 'asset', symbol: 'LPT', amount: 954.5, sign: '−' });
    expect(flow.sent?.subline).toBe('cost ₹4,16,389.81');
    expect(flow.received).toMatchObject({ kind: 'asset', symbol: 'USDT', amount: 4850.6, sign: '+' });
    expect(flow.received?.subline).toBe('≈ ₹4,04,700.00');
    expect(flow.received?.gain).toEqual({ kind: 'loss', formatted: '₹11,689.81' });
  });

  it('sell: asset leg out, fiat leg in, gain/loss on the fiat leg', () => {
    const t = tx({ type: 'sell', amount: 0.2, fiatValue: 12000 });
    const flow = txFlow(t, flowCtx({ disposal: { costBasis: 10000, gain: 2000 } }));
    expect(flow.sent).toMatchObject({ kind: 'asset', symbol: 'BTC', amount: 0.2, sign: '−', subline: 'cost $10,000.00' });
    expect(flow.received).toMatchObject({ kind: 'fiat', amount: 12000, currency: 'USD' });
    expect(flow.received?.gain).toEqual({ kind: 'gain', formatted: '$2,000.00' });
  });

  it('crypto-to-crypto sell: shows the counter-asset leg (Sold LPT → USDT), ₹ as a subline', () => {
    const t = tx({ type: 'sell', asset: 'LPT', amount: 954.5, counterAsset: 'USDT', counterAmount: 4850.6, fiatCurrency: 'INR', fiatValue: 404700 });
    const flow = txFlow(t, flowCtx({ assetLabel: 'LPT', counterLabel: 'USDT' }));
    expect(flow.sent).toMatchObject({ kind: 'asset', symbol: 'LPT', amount: 954.5, sign: '−' });
    // NOT a fiat leg — the original pair is preserved.
    expect(flow.received).toMatchObject({ kind: 'asset', symbol: 'USDT', amount: 4850.6, sign: '+' });
    expect(flow.received?.subline).toBe('≈ ₹4,04,700.00');
  });

  it('crypto-to-crypto buy: shows the counter-asset paid leg (Bought LPT with USDT)', () => {
    const t = tx({ type: 'buy', asset: 'LPT', amount: 954.5, counterAsset: 'USDT', counterAmount: 4850.6, fiatCurrency: 'INR', fiatValue: 404700 });
    const flow = txFlow(t, flowCtx({ assetLabel: 'LPT', counterLabel: 'USDT' }));
    expect(flow.sent).toMatchObject({ kind: 'asset', symbol: 'USDT', amount: 4850.6, sign: '−', subline: '≈ ₹4,04,700.00' });
    expect(flow.received).toMatchObject({ kind: 'asset', symbol: 'LPT', amount: 954.5, sign: '+' });
  });

  it('sell with no cost-basis data: "cost —", never an invented "cost ₹0.00"', () => {
    // A disposal whose amount matched no lots comes back from the engine with
    // costBasis 0 — that is UNKNOWN, not zero.
    const t = tx({ type: 'sell', amount: 1, fiatCurrency: 'INR', fiatValue: 9405090.64 });
    const flow = txFlow(t, flowCtx({ disposal: { costBasis: 0, gain: 9405090.64 } }));
    expect(flow.sent?.subline).toBe('cost —');
  });

  it('trade with no cost-basis data: "cost —" under the sent leg too', () => {
    const t = tx({
      type: 'trade',
      asset: 'LPT',
      amount: 164,
      counterAsset: 'USDT',
      counterAmount: 880,
      fiatCurrency: 'INR',
      fiatValue: 74060
    });
    const flow = txFlow(t, flowCtx({ assetLabel: 'LPT', counterLabel: 'USDT', disposal: { costBasis: 0, gain: 74060 } }));
    expect(flow.sent?.subline).toBe('cost —');
  });

  it('buy: fiat leg out, asset leg in, no gain (not a disposal)', () => {
    const t = tx({ type: 'buy', amount: 0.5, fiatValue: 25000 });
    const flow = txFlow(t, flowCtx());
    expect(flow.sent).toMatchObject({ kind: 'fiat', amount: 25000, currency: 'USD' });
    expect(flow.received).toMatchObject({ kind: 'asset', symbol: 'BTC', amount: 0.5, sign: '+' });
    expect(flow.received?.gain).toBeUndefined();
  });

  it('transfer_in: single honest asset leg when no counterparty was recorded', () => {
    const t = tx({ type: 'transfer_in', asset: 'SOL', amount: 10 });
    const flow = txFlow(t, flowCtx({ assetLabel: 'SOL' }));
    expect(flow.sent).toBeNull();
    expect(flow.received).toMatchObject({ kind: 'asset', symbol: 'SOL', amount: 10, sign: '+' });
  });

  it('transfer_in: counterparty endpoint uses the wallet NAME when known, shortened address otherwise', () => {
    const t = tx({ type: 'transfer_in', asset: 'ETH', amount: 0.5 });
    const named = txFlow(t, flowCtx({ assetLabel: 'ETH', fromAddr: LEDGER_ADDR, resolveWallet }));
    expect(named.sent).toMatchObject({ kind: 'endpoint', label: 'Ledger', title: LEDGER_ADDR, isName: true });
    const unknown = txFlow(t, flowCtx({ assetLabel: 'ETH', fromAddr: OTHER_ADDR, resolveWallet }));
    expect(unknown.sent).toMatchObject({ kind: 'endpoint', label: '0xaaaa…eeee', isName: false });
  });

  it('transfer_out: asset leg out, destination endpoint in', () => {
    const t = tx({ type: 'transfer_out', asset: 'ETH', amount: 0.5 });
    const flow = txFlow(t, flowCtx({ assetLabel: 'ETH', toAddr: LEDGER_ADDR, resolveWallet }));
    expect(flow.sent).toMatchObject({ kind: 'asset', sign: '−' });
    expect(flow.received).toMatchObject({ kind: 'endpoint', label: 'Ledger', isName: true });
  });

  it('fee: single sent leg, never an invented received leg', () => {
    const t = tx({ type: 'fee', asset: 'SOL', amount: 0.001 });
    const flow = txFlow(t, flowCtx({ assetLabel: 'SOL' }));
    expect(flow.sent).toMatchObject({ kind: 'asset', symbol: 'SOL', sign: '−' });
    expect(flow.received).toBeNull();
  });

  it('income: single received leg with the fiat value beneath', () => {
    const t = tx({ type: 'income', asset: 'ETH', amount: 0.01, fiatValue: 30 });
    const flow = txFlow(t, flowCtx({ assetLabel: 'ETH' }));
    expect(flow.sent).toBeNull();
    expect(flow.received).toMatchObject({ kind: 'asset', sign: '+', subline: '≈ $30.00' });
  });

  it('trade without a recorded counter-asset stays a single leg (nothing invented)', () => {
    const t = tx({ type: 'trade', asset: 'ABC', amount: 3 });
    const flow = txFlow(t, flowCtx({ assetLabel: 'ABC' }));
    expect(flow.sent).not.toBeNull();
    expect(flow.received).toBeNull();
  });
});

describe('buildTxSummary — plain-English one-liners per type', () => {
  it('sell with a loss: "You sold … on Binance" + a loss tail', () => {
    const t = tx({ type: 'sell', asset: 'LPT', amount: 954.5, fiatCurrency: 'INR', fiatValue: 404700 });
    const s = buildTxSummary(t, summaryCtx({
      assetLabel: 'LPT',
      disposal: { costBasis: 416389.81, gain: -11689.81 }
    }));
    expect(s.lead).toBe('You sold 954.5000 LPT for ₹4,04,700.00 on Binance');
    expect(s.tail).toEqual({ kind: 'loss', formatted: '₹11,689.81' });
  });

  it('sell with a gain has a gain tail; buy has none', () => {
    const sell = buildTxSummary(
      tx({ type: 'sell', amount: 0.2, fiatValue: 12000 }),
      summaryCtx({ disposal: { costBasis: 10000, gain: 2000 } })
    );
    expect(sell.lead).toBe('You sold 0.200000 BTC for $12,000.00 on Binance');
    expect(sell.tail).toEqual({ kind: 'gain', formatted: '$2,000.00' });

    const buy = buildTxSummary(tx({ type: 'buy', amount: 0.5, fiatValue: 25000 }), summaryCtx());
    expect(buy.lead).toBe('You bought 0.500000 BTC for $25,000.00 on Binance');
    expect(buy.tail).toBeUndefined();
  });

  it('crypto-to-crypto sell keeps the original pair: "You sold LPT for USDT (≈ ₹…)"', () => {
    const t = tx({ type: 'sell', asset: 'LPT', amount: 954.5, counterAsset: 'USDT', counterAmount: 4850.6, fiatCurrency: 'INR', fiatValue: 404700 });
    const s = buildTxSummary(t, summaryCtx({ assetLabel: 'LPT', counterLabel: 'USDT' }));
    expect(s.lead).toBe('You sold 954.5000 LPT for 4850.60 USDT (≈ ₹4,04,700.00) on Binance');
  });

  it('crypto-to-crypto buy keeps the original pair: "You bought LPT for USDT (≈ ₹…)"', () => {
    const t = tx({ type: 'buy', asset: 'LPT', amount: 954.5, counterAsset: 'USDT', counterAmount: 4850.6, fiatCurrency: 'INR', fiatValue: 404700 });
    const s = buildTxSummary(t, summaryCtx({ assetLabel: 'LPT', counterLabel: 'USDT' }));
    expect(s.lead).toBe('You bought 954.5000 LPT for 4850.60 USDT (≈ ₹4,04,700.00) on Binance');
  });

  it('trade: "You swapped X for Y on Binance"', () => {
    const t = tx({ type: 'trade', asset: 'LPT', amount: 954.5, counterAsset: 'USDT', counterAmount: 4850.6, fiatCurrency: 'INR', fiatValue: 404700 });
    const s = buildTxSummary(t, summaryCtx({ assetLabel: 'LPT', counterLabel: 'USDT' }));
    expect(s.lead).toBe('You swapped 954.5000 LPT for 4850.60 USDT on Binance');
  });

  it('transfer_in: wallet name wins — "You received 0.5 ETH in Ledger wallet"', () => {
    const t = tx({ type: 'transfer_in', asset: 'ETH', amount: 0.5 });
    const s = buildTxSummary(t, summaryCtx({
      assetLabel: 'ETH',
      sourceLabel: 'Ethereum',
      toAddr: LEDGER_ADDR,
      resolveWallet
    }));
    expect(s.lead).toBe('You received 0.500000 ETH in Ledger wallet');
  });

  it('transfer_in: falls back to the shortened address, then to the import source', () => {
    const t = tx({ type: 'transfer_in', asset: 'ETH', amount: 0.5 });
    const unknown = buildTxSummary(t, summaryCtx({ assetLabel: 'ETH', sourceLabel: 'Ethereum', toAddr: OTHER_ADDR, resolveWallet }));
    expect(unknown.lead).toBe('You received 0.500000 ETH to 0xaaaa…eeee');
    const noAddr = buildTxSummary(t, summaryCtx({ assetLabel: 'ETH', sourceLabel: 'Ethereum' }));
    expect(noAddr.lead).toBe('You received 0.500000 ETH — imported from Ethereum');
  });

  it('transfer_in: a name that already says "wallet" is not doubled', () => {
    const t = tx({ type: 'transfer_in', asset: 'ETH', amount: 0.5 });
    const s = buildTxSummary(t, summaryCtx({
      assetLabel: 'ETH',
      sourceLabel: 'Ethereum',
      toAddr: OTHER_ADDR,
      resolveWallet: () => 'My Phantom wallet'
    }));
    expect(s.lead).toBe('You received 0.500000 ETH in My Phantom wallet');
  });

  it('transfer_out: from-name and to-address', () => {
    const t = tx({ type: 'transfer_out', asset: 'ETH', amount: 0.5 });
    const s = buildTxSummary(t, summaryCtx({
      assetLabel: 'ETH',
      sourceLabel: 'Ethereum',
      fromAddr: LEDGER_ADDR,
      toAddr: OTHER_ADDR,
      resolveWallet
    }));
    expect(s.lead).toBe('You sent 0.500000 ETH from Ledger wallet to 0xaaaa…eeee');
  });

  it('income: "You received X as income worth V on <source>"', () => {
    const t = tx({ type: 'income', asset: 'ETH', amount: 0.01, fiatValue: 30, source: 'rpc:ethereum' });
    const s = buildTxSummary(t, summaryCtx({ assetLabel: 'ETH', sourceLabel: 'Ethereum' }));
    expect(s.lead).toBe('You received 0.010000 ETH as income worth $30.00 on Ethereum');
  });

  it('fee: from-name when the wallet is known, else the source', () => {
    const t = tx({ type: 'fee', asset: 'SOL', amount: 0.001, source: 'rpc:solana' });
    const named = buildTxSummary(t, summaryCtx({ assetLabel: 'SOL', sourceLabel: 'Solana', fromAddr: LEDGER_ADDR, resolveWallet }));
    expect(named.lead).toBe('You paid 0.001000 SOL as a network fee from Ledger wallet');
    const unnamed = buildTxSummary(t, summaryCtx({ assetLabel: 'SOL', sourceLabel: 'Solana' }));
    expect(unnamed.lead).toBe('You paid 0.001000 SOL as a network fee on Solana');
  });

  it('manual entries read "via manual entry", not "on Manual entry"', () => {
    const t = tx({ type: 'buy', amount: 1, fiatValue: 100, source: 'manual' });
    const s = buildTxSummary(t, summaryCtx({ sourceLabel: 'Manual entry' }));
    expect(s.lead).toBe('You bought 1.0000 BTC for $100.00 via manual entry');
  });
});

describe('OWN_ACCOUNT_SIDE', () => {
  it('marks the own-account side per type (source brand fallback in the facts grid)', () => {
    expect(OWN_ACCOUNT_SIDE.sell).toBe('from');
    expect(OWN_ACCOUNT_SIDE.buy).toBe('to');
    expect(OWN_ACCOUNT_SIDE.trade).toBe('both');
    expect(OWN_ACCOUNT_SIDE.transfer_in).toBe('to');
    expect(OWN_ACCOUNT_SIDE.transfer_out).toBe('from');
    expect(OWN_ACCOUNT_SIDE.fee).toBe('from');
  });
});
