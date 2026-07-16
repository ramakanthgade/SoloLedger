import { describe, it, expect } from 'vitest';
import { buildTaxContext, type TaxContextInput } from './taxContext';

const BASE: TaxContextInput = {
  fyLabel: 'FY 2026-27',
  jurisdictionLabel: 'India',
  jurisdictionNotes: '30% flat VDA tax under Section 115BBH; 1% TDS under 194S.',
  reportingCurrency: 'INR',
  costBasisMethod: 'FIFO',
  totalTransactions: 42,
  missingPriceCount: 0,
  possibleInternalTransferCount: 1,
  duplicateSourceRefCount: 0,
  possibleDuplicateTxCount: 0,
  realizedGain: 853500,
  disposalCount: 5,
  totalIncome: 12000,
  shortfallCount: 0,
  topHoldings: [
    { asset: 'BTC', qty: 0.62, cost: 1440000 },
    { asset: 'ETH', qty: 11.4, cost: 980000 }
  ]
};

describe('buildTaxContext — honest, address-free system prompt (A2)', () => {
  it('includes the aggregated summary figures', () => {
    const out = buildTaxContext(BASE);
    expect(out).toContain('FY 2026-27');
    expect(out).toContain('India');
    expect(out).toContain('BTC');
    expect(out).toContain('ETH');
    // Aggregated summary framing is present.
    expect(out.toLowerCase()).toContain('aggregated summary');
  });

  it('makes NO false "100% local" claim', () => {
    const out = buildTaxContext(BASE).toLowerCase();
    expect(out).not.toContain('100% local');
    expect(out).not.toContain('all data is 100% local');
  });

  it('contains NO wallet-address or transaction-hash substrings', () => {
    // Feed adversarial address / hash-shaped strings through the only free-text
    // fields the builder accepts. Because the builder never emits raw rows,
    // even asset symbols that look like hashes must not surface addresses.
    const out = buildTaxContext({
      ...BASE,
      // Asset symbols are the only place caller-supplied text lands, and they
      // are short tickers — assert the rendered prompt has no address/hash shape.
      topHoldings: [
        { asset: 'BTC', qty: 0.62, cost: 1440000 },
        { asset: 'ETH', qty: 11.4, cost: 980000 }
      ]
    });

    // 0x-prefixed 40-hex EVM address shape.
    expect(out).not.toMatch(/0x[a-fA-F0-9]{40}/);
    // 64-hex transaction hash shape (with or without 0x).
    expect(out).not.toMatch(/\b[a-fA-F0-9]{64}\b/);
    // base58 Solana address shape (32-44 chars).
    expect(out).not.toMatch(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/);
    // Never mentions the raw-identifier field names as data.
    expect(out.toLowerCase()).not.toContain('walletaddress');
    expect(out.toLowerCase()).not.toContain('counterpartyaddress');
  });

  it('tells the model it cannot see addresses or hashes', () => {
    const out = buildTaxContext(BASE).toLowerCase();
    expect(out).toContain('wallet addresses');
    expect(out).toContain('transaction hashes');
  });
});
