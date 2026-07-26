import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseBlockstreamTx, lookupManyAddresses, CHAINS } from './providers';
import { buildPortfolioHoldings } from '@/lib/portfolio/portfolioCompute';

/**
 * Round-4 regression fixtures — the user's live phantom-holdings bug.
 *
 * His Binance deposit addresses received BTC that was later swept by
 * BATCHED exchange transactions ("From 65 Inputs To Binance 4"). The old
 * parser measured an outgoing tx by outputs TO the watched address, which
 * is 0 in a batched sweep — so the 32.65574623 / 13.33 BTC receives stayed
 * on the ledger while the matching sends imported as amount-0 rows:
 * ≈46 phantom BTC on the dashboard. These fixtures pin both directions.
 */

const ADDR = '1J33sNnKbs52UjTK39kEEYDfbHijgDxyKU';

/** Binance deposit receive: 2 outputs (deposit to us, change back to sender). */
function receiveFixture(sats: number, txid = 'recv-txid') {
  return {
    txid,
    fee: 1410,
    status: { confirmed: true, block_time: 1_740_000_000 },
    vin: [
      { prevout: { scriptpubkey_address: 'bc1qsenderwallet0000000000000000000000000', value: sats + 50_000 + 1410 } }
    ],
    vout: [
      { scriptpubkey_address: ADDR, value: sats },
      { scriptpubkey_address: 'bc1qsenderchange00000000000000000000000000', value: 50_000 }
    ]
  };
}

/** Batched exchange sweep: watched address is ONE of 65 inputs; no output returns to it. */
function batchedSweepFixture(satsFromAddr: number, txid = 'sweep-txid') {
  const vin = [{ prevout: { scriptpubkey_address: ADDR, value: satsFromAddr } }];
  // 64 other deposit addresses being swept in the same batch.
  for (let i = 0; i < 64; i++) {
    vin.push({ prevout: { scriptpubkey_address: `1OtherDepositAddr${String(i).padStart(3, '0')}xxxxxxxxxx`, value: 2_000_000 } });
  }
  return {
    txid,
    fee: 21_300, // shared batch fee — paid by the exchange out of ITS outputs
    status: { confirmed: true, block_time: 1_741_000_000 },
    vin,
    vout: [
      { scriptpubkey_address: 'bc1qbinancehotwallet000000000000000000000', value: satsFromAddr + 64 * 2_000_000 - 21_300 - 5000 },
      { scriptpubkey_address: 'bc1qbinancechange0000000000000000000000', value: 5000 }
    ]
  };
}

describe('parseBlockstreamTx — incoming', () => {
  it('records a 2-output receive at the full deposit amount', () => {
    const tx = parseBlockstreamTx(receiveFixture(3_265_574_623), ADDR, 'BTC');
    expect(tx.type).toBe('transfer_in');
    expect(tx.amount).toBeCloseTo(32.65574623, 8);
    expect(tx.feeAmount).toBeUndefined();
    expect(tx.walletAddress).toBe(ADDR);
    expect(tx.sourceRef).toBe('recv-txid');
  });
});

describe('parseBlockstreamTx — outgoing', () => {
  it('records a 65-input batched sweep at the full consumed UTXO (no phantom)', () => {
    const tx = parseBlockstreamTx(batchedSweepFixture(3_265_574_623), ADDR, 'BTC');
    expect(tx.type).toBe('transfer_out');
    // The whole UTXO left the address; the batch fee is the exchange's, not ours.
    expect(tx.amount).toBeCloseTo(32.65574623, 8);
    expect(tx.feeAmount).toBeUndefined();
  });

  it('nets a sole-input send to recipient amount + full fee attribution', () => {
    const row = {
      txid: 'sole-send',
      fee: 1000,
      status: { confirmed: true, block_time: 1_742_000_000 },
      vin: [{ prevout: { scriptpubkey_address: ADDR, value: 100_000_000 } }],
      vout: [
        { scriptpubkey_address: 'bc1qrecipient00000000000000000000000000', value: 40_000_000 },
        { scriptpubkey_address: ADDR, value: 59_999_000 } // change back to self
      ]
    };
    const tx = parseBlockstreamTx(row, ADDR, 'BTC');
    expect(tx.type).toBe('transfer_out');
    expect(tx.amount).toBeCloseTo(0.4, 8);
    expect(tx.feeAsset).toBe('BTC');
    expect(tx.feeAmount).toBeCloseTo(0.00001, 8);
  });

  it('a self-consolidation nets to amount 0 with only the fee leaving', () => {
    const row = {
      txid: 'self-consolidation',
      fee: 10_000,
      status: { confirmed: true, block_time: 1_742_100_000 },
      vin: [{ prevout: { scriptpubkey_address: ADDR, value: 50_000_000 } }],
      vout: [{ scriptpubkey_address: ADDR, value: 49_990_000 }]
    };
    const tx = parseBlockstreamTx(row, ADDR, 'BTC');
    expect(tx.type).toBe('transfer_out');
    expect(tx.amount).toBe(0);
    expect(tx.feeAmount).toBeCloseTo(0.0001, 8);
  });
});

describe('phantom reproduction — receive + batched sweep net to zero holdings', () => {
  it('ledger nets to 0 BTC (the exact live bug, fixed)', () => {
    const recv = parseBlockstreamTx(receiveFixture(3_265_574_623), ADDR, 'BTC');
    const sweep = parseBlockstreamTx(batchedSweepFixture(3_265_574_623), ADDR, 'BTC');
    const holdings = buildPortfolioHoldings([recv, sweep]);
    const btc = holdings.find((h) => h.asset === 'BTC');
    expect(btc).toBeUndefined(); // fully drained — no holding row at all
  });
});

describe('fetchBitcoin pagination (chain continuation)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const pageRow = (i: number) => ({
    txid: `txid-${String(i).padStart(3, '0')}`,
    fee: 500,
    status: { confirmed: true, block_time: 1_740_000_000 + i },
    vin: [{ prevout: { scriptpubkey_address: 'bc1qsomeoneelse000000000000000000000', value: 10_000 } }],
    vout: [{ scriptpubkey_address: ADDR, value: 10_000 }]
  });

  it('follows /txs/chain/:lastTxid while pages are full', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      const rows = calls.length === 1
        ? Array.from({ length: 50 }, (_, i) => pageRow(i))
        : Array.from({ length: 30 }, (_, i) => pageRow(50 + i));
      return { ok: true, json: async () => rows } as Response;
    }));

    const chain = CHAINS.find((c) => c.id === 'bitcoin')!;
    const result = await lookupManyAddresses([ADDR], { chain });
    expect(calls.length).toBe(2);
    expect(calls[0]).toBe(`https://blockstream.info/api/address/${ADDR}/txs`);
    expect(calls[1]).toBe(`https://blockstream.info/api/address/${ADDR}/txs/chain/txid-049`);
    expect(result.transactions.length).toBe(80);
    expect(result.warnings).toEqual([]);
  });

  it('does not paginate when the first page is short (the 14–22 tx case)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, json: async () => Array.from({ length: 22 }, (_, i) => pageRow(i)) } as Response;
    }));
    const chain = CHAINS.find((c) => c.id === 'bitcoin')!;
    const result = await lookupManyAddresses([ADDR], { chain });
    expect(calls.length).toBe(1);
    expect(result.transactions.length).toBe(22);
  });
});
