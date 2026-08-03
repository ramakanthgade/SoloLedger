import { describe, expect, it } from 'vitest';
import type { OpeningBalanceRow } from '@/lib/ledger/derivedPostings';
import type { AuthorityAssetRow, AuthoritySnapshotRow, EndpointProof } from '@/lib/reconcile/authoritySelection';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { Transaction } from '@/types/transaction';
import {
  appendHoldingsProjection,
  buildHoldingsProjection,
  type HoldingsProjectionInput
} from './holdingsProjection';

const NOW = 1_800_000_000_000;

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', timestamp: NOW - 1_000, type: 'transfer_in', asset: 'BTC', amount: 2,
    fiatCurrency: 'USD', source: 'manual', flags: [], isInternalTransfer: false,
    ...overrides
  };
}

function proof(overrides: Partial<EndpointProof> = {}): EndpointProof {
  return {
    authorityKind: 'api', provider: 'binance', operation: 'balance', parametersClass: 'spot',
    requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true,
    ...overrides
  };
}

function snapshot(overrides: Partial<AuthoritySnapshotRow> = {}): AuthoritySnapshotRow {
  return {
    snapshotId: 's1', generation: 1, scopeId: 'exchange:c1', authorityKind: 'api',
    authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
    asOf: NOW, capturedAt: NOW, sourceIdentityId: 'c1', endpointProof: proof(), status: 'complete',
    ...overrides
  };
}

function authorityAsset(overrides: Partial<AuthorityAssetRow> = {}): AuthorityAssetRow {
  return {
    id: 'a1', snapshotId: 's1', generation: 1, scopeId: 'exchange:c1', accountClass: 'spot',
    assetKey: 'asset:BTC', asset: 'BTC', quantity: 7, ...overrides
  };
}

function coverage(overrides: Partial<SourceCoverageRow> = {}): SourceCoverageRow {
  return {
    id: 'coverage-1', generation: 1, scopeId: 'exchange:c1', sourceIdentityId: 'c1', evidenceId: 'e1',
    kind: 'api', accountClasses: ['spot'], endpoints: ['history'], authoritySnapshotId: 's1',
    authorityAsOf: NOW, requestedHistoryStart: 0, requestedHistoryEnd: NOW,
    observedHistoryStart: 0, observedHistoryEnd: NOW, startedAt: 0, completedAt: NOW,
    status: 'complete', paginationExhausted: true,
    endpointOutcomes: [{
      endpoint: 'history', accountClass: 'spot', required: true, status: 'complete', requestedStart: 0,
      requestedEnd: NOW, observedStart: 0, observedEnd: NOW, paginationRequired: true,
      paginationExhausted: true
    }],
    ...overrides
  };
}

function input(overrides: Partial<HoldingsProjectionInput> = {}): HoldingsProjectionInput {
  return {
    transactions: [], exchangeConnections: [{ id: 'c1', exchange: 'binance' }], openingBalances: [],
    snapshots: [], assets: [], coverage: [], now: NOW, ...overrides
  };
}

function apiTx(overrides: Partial<Transaction> = {}): Transaction {
  return tx({ source: 'binance_api', importBatchId: 'c1', parserAccountClass: 'spot', ...overrides });
}

describe('buildHoldingsProjection', () => {
  it('agrees with posting quantities for ordinary consumer holdings and exposes the prepared projection', () => {
    const result = buildHoldingsProjection(input({
      transactions: [tx({ id: 'in', amount: 5 }), tx({ id: 'out', type: 'transfer_out', amount: 2 })]
    }));
    expect(result.holdings).toEqual([
      expect.objectContaining({ assetKey: 'asset:BTC', quantity: 3, amount: 3 })
    ]);
    expect(result.slices[0]).toMatchObject({ scopeId: 'manual', postingQuantity: 3, quantity: 3 });
    expect(result.preparedPostings.source).toBe(result.postings);
  });

  it('uses current API authority and retains confirmed zero as slice evidence only', () => {
    const current = buildHoldingsProjection(input({
      transactions: [apiTx()], snapshots: [snapshot()], assets: [authorityAsset()], coverage: [coverage()]
    }));
    expect(current.holdings[0]).toMatchObject({ quantity: 7, verificationStatus: 'verified_authority' });

    const zero = buildHoldingsProjection(input({
      transactions: [apiTx()], snapshots: [snapshot()],
      assets: [authorityAsset({ quantity: 0 })], coverage: [coverage()]
    }));
    expect(zero.holdings).toEqual([]);
    expect(zero.slices[0]).toMatchObject({ quantity: 0, authorityQuantity: 0, verificationStatus: 'verified_authority' });
  });

  it('falls back to postings for stale authority', () => {
    const result = buildHoldingsProjection(input({
      transactions: [apiTx()], snapshots: [snapshot({ asOf: NOW - 86_400_001 })],
      assets: [authorityAsset()], coverage: [coverage()]
    }));
    expect(result.holdings[0]).toMatchObject({ quantity: 2, verificationStatus: 'posting_fallback' });
    expect(result.holdings[0].sourceVerification[0]).toMatchObject({ fallbackReason: 'stale_authority' });
  });

  it('keeps uncovered Options posting-derived beside verified Spot', () => {
    const result = buildHoldingsProjection(input({
      exchangeConnections: [{ id: 'c1', exchange: 'binance', provenAccountClasses: ['spot', 'options'] }],
      transactions: [apiTx(), apiTx({ id: 'option', amount: 3, parserAccountClass: 'options' })],
      snapshots: [snapshot()], assets: [authorityAsset()], coverage: [coverage()]
    }));
    expect(result.slices.find((row) => row.accountClass === 'spot')).toMatchObject({ quantity: 7 });
    expect(result.slices.find((row) => row.accountClass === 'options')).toMatchObject({
      quantity: 3, fallbackReason: 'missing_authority'
    });
    expect(result.holdings[0]).toMatchObject({ quantity: 10, verificationStatus: 'mixed' });
  });

  it('uses exhaustive absence as a verified zero', () => {
    const result = buildHoldingsProjection(input({
      transactions: [apiTx({ asset: 'ETH' })], snapshots: [snapshot()], assets: [], coverage: [coverage()]
    }));
    expect(result.holdings).toEqual([]);
    expect(result.slices[0]).toMatchObject({ assetKey: 'asset:ETH', quantity: 0, authorityQuantity: 0 });
  });

  it('keeps manual holdings additive and preserves negative posting quantities', () => {
    const additive = buildHoldingsProjection(input({
      transactions: [apiTx(), tx({ id: 'manual', amount: 3 })], snapshots: [snapshot()],
      assets: [authorityAsset()], coverage: [coverage()]
    }));
    expect(additive.holdings[0].quantity).toBe(10);

    const negative = buildHoldingsProjection(input({
      transactions: [tx({ type: 'transfer_out', amount: 4 })]
    }));
    expect(negative.holdings[0]).toMatchObject({ quantity: -4, amount: -4, costBasis: 0 });
  });

  it('preserves wallet contract identity, Base58 case, and native SOL separation', () => {
    const wallet = 'Base58Wallet';
    const result = buildHoldingsProjection(input({
      exchangeConnections: [],
      transactions: [
        tx({ id: 'one', source: 'rpc:helius', chain: 'solana', walletAddress: wallet, asset: 'TOKEN', contractAddress: 'MintCaseA' }),
        tx({ id: 'two', source: 'rpc:helius', chain: 'solana', walletAddress: wallet, asset: 'TOKEN', contractAddress: 'mintcasea', amount: 3 }),
        tx({ id: 'sol', source: 'rpc:helius', chain: 'solana', walletAddress: wallet, asset: 'SOL', amount: 4 })
      ]
    }));
    expect(new Set(result.holdings.map((row) => row.assetKey))).toEqual(new Set([
      'solana:MintCaseA', 'solana:mintcasea', 'solana:native'
    ]));
    expect(result.holdings.find((row) => row.assetKey === 'solana:MintCaseA')).toMatchObject({
      contractAddress: 'MintCaseA', chain: 'solana'
    });
  });

  it('does not leak display metadata from a filtered-out custody scope', () => {
    const contractAddress = '0x00000000000000000000000000000000000000ab';
    const result = buildHoldingsProjection(input({
      exchangeConnections: [
        { id: 'c1', exchange: 'binance' },
        { id: 'c2', exchange: 'binance' }
      ],
      transactions: [
        apiTx({
          id: 'selected', asset: 'SELECTED', chain: 'ethereum', contractAddress,
          importBatchId: 'c1', timestamp: NOW - 2_000
        }),
        apiTx({
          id: 'excluded-newer', asset: 'EXCLUDED', chain: 'ethereum', contractAddress,
          importBatchId: 'c2', timestamp: NOW - 1_000
        })
      ],
      scopeFilter: { scopeIds: ['exchange:c1'] }
    }));
    expect(result.holdings[0]).toMatchObject({
      asset: 'SELECTED', assetKey: `evm:1:${contractAddress}`, contractAddress
    });
  });

  it('does not leak display metadata from a posting after the comparison cutoff', () => {
    const contractAddress = '0x00000000000000000000000000000000000000ac';
    const result = buildHoldingsProjection(input({
      exchangeConnections: [],
      transactions: [
        tx({
          id: 'included', asset: 'AT-CUTOFF', chain: 'ethereum', contractAddress,
          timestamp: NOW - 2_000
        }),
        tx({
          id: 'future', asset: 'FUTURE', chain: 'ethereum', contractAddress,
          timestamp: NOW
        })
      ],
      comparisonAt: NOW - 1_000
    }));
    expect(result.holdings[0]).toMatchObject({ asset: 'AT-CUTOFF', quantity: 2, contractAddress });
  });

  it('does not attach standalone fee-leg metadata when its posting uses the principal key', () => {
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const wrappedSolMint = 'So11111111111111111111111111111111111111112';
    const result = buildHoldingsProjection(input({
      exchangeConnections: [],
      transactions: [tx({
        id: 'standalone-fee', type: 'fee', asset: 'EPjF…TDt1v', amount: 1,
        source: 'rpc:helius', chain: 'solana', walletAddress: 'WalletAddress',
        contractAddress: usdcMint, feeAsset: 'SOL', raw: { feeMint: wrappedSolMint }
      })]
    }));
    expect(result.holdings[0]).toMatchObject({
      assetKey: `solana:${usdcMint}`, contractAddress: usdcMint, quantity: -1
    });
    expect(result.holdings[0].asset).not.toBe('SOL');
  });

  it('resolves a known Solana mint label while preserving its export identity', () => {
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const result = buildHoldingsProjection(input({
      exchangeConnections: [],
      transactions: [tx({
        id: 'known-mint', asset: 'EPjF…TDt1v', source: 'rpc:helius', chain: 'solana',
        walletAddress: 'WalletAddress', contractAddress: usdcMint
      })]
    }));
    expect(result.holdings[0]).toMatchObject({
      asset: 'USDC', assetKey: `solana:${usdcMint}`, chain: 'solana', contractAddress: usdcMint
    });
  });

  it('includes authority-only assets with canonical metadata and zero cost basis', () => {
    const result = buildHoldingsProjection(input({
      snapshots: [snapshot()],
      assets: [authorityAsset({ assetKey: 'evm:1:0xabc', asset: 'TOKEN', quantity: 4 })],
      coverage: [coverage()]
    }));
    expect(result.holdings[0]).toMatchObject({
      assetKey: 'evm:1:0xabc', quantity: 4, costBasis: 0, chain: '1', contractAddress: '0xabc'
    });
  });

  it('preserves authority-only custom EVM contract and native identities', () => {
    const result = buildHoldingsProjection(input({
      snapshots: [snapshot()],
      assets: [
        authorityAsset({
          id: 'custom-contract', assetKey: 'evm:custom:eip155:99999:0xtoken',
          asset: 'TOKEN', quantity: 4
        }),
        authorityAsset({
          id: 'custom-native', assetKey: 'evm:custom:eip155:99999:native',
          asset: 'COIN', quantity: 2
        })
      ],
      coverage: [coverage()]
    }));
    expect(result.holdings.find((row) => row.assetKey.endsWith(':0xtoken'))).toMatchObject({
      chain: 'custom_evm', contractAddress: '0xtoken', quantity: 4, costBasis: 0
    });
    expect(result.holdings.find((row) => row.assetKey.endsWith(':native'))).toMatchObject({
      chain: 'custom_evm', contractAddress: undefined, quantity: 2, costBasis: 0
    });
  });

  it('applies opening balances as absolute resets', () => {
    const opening: OpeningBalanceRow = {
      id: 'opening', logicalKey: 'logical', scopeId: 'manual', accountClass: 'manual',
      assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 10, effectiveAt: NOW - 2_000,
      provenance: 'user_confirmed', createdAt: NOW, updatedAt: NOW
    };
    const result = buildHoldingsProjection(input({
      transactions: [
        tx({ id: 'before', timestamp: NOW - 3_000, type: 'buy', amount: 10, fiatValue: 1_000 }),
        tx({ id: 'after', timestamp: NOW - 1_000, type: 'buy', amount: 2, fiatValue: 200 })
      ],
      openingBalances: [opening]
    }));
    expect(result.holdings[0]).toMatchObject({ quantity: 12, costBasis: 200 });
  });

  it('isolates opening display-cost resets by exact scope and account class', () => {
    const openings: OpeningBalanceRow[] = [{
      id: 'opening', logicalKey: 'logical', scopeId: 'exchange:c1', accountClass: 'spot',
      assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 10, effectiveAt: NOW - 2_000,
      provenance: 'user_confirmed', createdAt: NOW, updatedAt: NOW
    }];
    const result = buildHoldingsProjection(input({
      exchangeConnections: [
        { id: 'c1', exchange: 'binance', provenAccountClasses: ['spot', 'options'] },
        { id: 'c2', exchange: 'binance', provenAccountClasses: ['spot'] }
      ],
      transactions: [
        apiTx({ id: 'c1-before', timestamp: NOW - 3_000, type: 'buy', amount: 10, fiatValue: 1_000 }),
        apiTx({ id: 'c1-after', timestamp: NOW - 1_000, type: 'buy', amount: 2, fiatValue: 200 }),
        apiTx({ id: 'c1-options', parserAccountClass: 'options', type: 'buy', amount: 1, fiatValue: 300 }),
        apiTx({ id: 'c2-spot', importBatchId: 'c2', type: 'buy', amount: 1, fiatValue: 400 })
      ],
      openingBalances: openings
    }));
    expect(result.holdings[0]).toMatchObject({ quantity: 14, costBasis: 900 });
    expect(result.holdings[0].sourceVerification).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeId: 'exchange:c1', accountClass: 'spot', quantity: 12 }),
      expect.objectContaining({ scopeId: 'exchange:c1', accountClass: 'options', quantity: 1 }),
      expect.objectContaining({ scopeId: 'exchange:c2', accountClass: 'spot', quantity: 1 })
    ]));
  });

  it('keeps custom EVM contract cost keyed by its canonical network identity', () => {
    const result = buildHoldingsProjection(input({
      exchangeConnections: [],
      transactions: [tx({
        source: 'rpc:custom', chain: 'custom_evm', walletAddress: '0xAbC',
        contractAddress: '0xToken', raw: { customNetworkId: 'eip155:99999' },
        type: 'buy', asset: 'TOKEN', amount: 2, fiatValue: 500
      })]
    }));
    expect(result.holdings[0]).toMatchObject({
      assetKey: 'evm:custom:eip155:99999:0xtoken', quantity: 2, costBasis: 500,
      chain: 'custom_evm', contractAddress: '0xToken'
    });
  });

  it('filters exact scopes before aggregation', () => {
    const result = buildHoldingsProjection(input({
      exchangeConnections: [{ id: 'c1', exchange: 'binance' }, { id: 'c2', exchange: 'binance' }],
      transactions: [apiTx({ amount: 2 }), apiTx({ id: 'other', importBatchId: 'c2', amount: 5 })],
      scopeFilter: { scopeIds: ['exchange:c2'], accountClasses: ['spot'] }
    }));
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0].scopeId).toBe('exchange:c2');
    expect(result.holdings[0].quantity).toBe(5);
  });

  it('overlays positive per-unit legacy cost without overriding authority quantity', () => {
    const result = buildHoldingsProjection(input({
      transactions: [apiTx({ type: 'buy', amount: 2, fiatValue: 200 })],
      snapshots: [snapshot()], assets: [authorityAsset({ quantity: 7 })], coverage: [coverage()]
    }));
    expect(result.holdings[0]).toMatchObject({ quantity: 7, amount: 7, costBasis: 700 });
  });

  it('preserves legacy canonical cost reduction across unresolved transaction scopes', () => {
    const result = buildHoldingsProjection(input({
      exchangeConnections: [],
      transactions: [
        tx({ id: 'btc-buy', source: 'binance', type: 'buy', asset: 'BTC', amount: 0.5, fiatValue: 25_000 }),
        tx({ id: 'btc-sell', source: 'binance', type: 'sell', asset: 'BTC', amount: 0.2, fiatValue: 12_000 }),
        tx({ id: 'eth-buy', source: 'binance', type: 'buy', asset: 'ETH', amount: 1, fiatValue: 10_000 })
      ]
    }));
    expect(result.holdings.find((holding) => holding.assetKey === 'asset:BTC')).toMatchObject({
      quantity: 0.3, costBasis: 15_000
    });
    expect(result.holdings.find((holding) => holding.assetKey === 'asset:ETH')).toMatchObject({
      quantity: 1, costBasis: 10_000
    });
    expect(result.holdings.reduce((sum, holding) => sum + holding.costBasis, 0)).toBe(25_000);
  });

  it('uses the ordered single-pass cost path without changing unordered projection semantics', () => {
    const rows = [
      tx({ id: 'buy', timestamp: NOW - 2_000, type: 'buy', amount: 2, fiatValue: 200 }),
      tx({ id: 'sell', timestamp: NOW - 1_000, type: 'sell', amount: 0.5, fiatValue: 80 })
    ];
    const ordered = buildHoldingsProjection(input({ transactions: rows }));
    const unordered = buildHoldingsProjection(input({ transactions: [...rows].reverse() }));
    expect(ordered.holdings).toEqual(unordered.holdings);
    expect(ordered.chartPostingCostsEquivalent).toBe(true);
  });

  it('extends a strictly chronological ledger with full-projection semantics', () => {
    const original = [
      tx({ id: 'buy', timestamp: NOW - 3_000, type: 'buy', amount: 2, fiatValue: 200 }),
      tx({ id: 'sell', timestamp: NOW - 2_000, type: 'sell', amount: 0.5, fiatValue: 80 })
    ];
    const appended = tx({
      id: 'append', timestamp: NOW - 1_000, type: 'transfer_in', amount: 1, fiatValue: 150
    });
    const previous = buildHoldingsProjection(input({ transactions: original }));
    const nextInput = input({ transactions: [...original, appended] });
    const incremental = appendHoldingsProjection(previous, nextInput, appended);
    const rebuilt = buildHoldingsProjection(nextInput);

    expect(incremental).toEqual(rebuilt);
    expect(incremental?.postings.slice(0, previous.postings.length)).toEqual(previous.postings);
    expect(incremental?.preparedPostings.source).toBe(incremental?.postings);
  });

  it('declines an append that could alter historical ordering', () => {
    const original = [tx({ id: 'original', timestamp: NOW - 1_000 })];
    const previous = buildHoldingsProjection(input({ transactions: original }));
    const sameInstant = tx({ id: 'later-id', timestamp: NOW - 1_000 });

    expect(appendHoldingsProjection(
      previous,
      input({ transactions: [...original, sameInstant] }),
      sameInstant
    )).toBeUndefined();
  });

  it('declines a transaction that is not the final projection input', () => {
    const original = [tx({ id: 'original', timestamp: NOW - 3_000 })];
    const previous = buildHoldingsProjection(input({ transactions: original }));
    const allegedAppend = tx({ id: 'middle', timestamp: NOW - 2_000 });
    const final = tx({ id: 'final', timestamp: NOW - 1_000 });

    expect(appendHoldingsProjection(
      previous,
      input({ transactions: [...original, allegedAppend, final] }),
      allegedAppend
    )).toBeUndefined();
  });

  it('declines a same-timestamp append after a prior transaction with no postings', () => {
    const original = [
      tx({ id: 'holding', timestamp: NOW - 2_000 }),
      tx({ id: 'zero-posting', timestamp: NOW - 1_000, amount: 0 })
    ];
    const previous = buildHoldingsProjection(input({ transactions: original }));
    const appended = tx({ id: 'append', timestamp: NOW - 1_000 });
    const nextInput = input({ transactions: [...original, appended] });

    expect(previous.postings[previous.postings.length - 1].effectiveAt).toBe(NOW - 2_000);
    expect(appendHoldingsProjection(previous, nextInput, appended)).toBeUndefined();
    expect(buildHoldingsProjection(nextInput).chartPostingCostsEquivalent).toBe(false);
  });

  it('retains a zero-balance canonical identity when a mismatched fee revives its key', () => {
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const wrappedSolMint = 'So11111111111111111111111111111111111111112';
    const wallet = 'WalletAddress';
    const acquired = tx({
      id: 'usdc-in', timestamp: NOW - 3_000, type: 'transfer_in', asset: 'USDC', amount: 2,
      source: 'rpc:helius', chain: 'solana', walletAddress: wallet, contractAddress: usdcMint
    });
    const disposed = tx({
      id: 'usdc-out', timestamp: NOW - 2_000, type: 'transfer_out', asset: 'USDC', amount: 2,
      source: 'rpc:helius', chain: 'solana', walletAddress: wallet, contractAddress: usdcMint
    });
    const fee = tx({
      id: 'usdc-fee', timestamp: NOW - 1_000, type: 'fee', asset: 'EPjF…TDt1v', amount: 1,
      source: 'rpc:helius', chain: 'solana', walletAddress: wallet, contractAddress: usdcMint,
      feeAsset: 'SOL', raw: { feeMint: wrappedSolMint }
    });
    const previous = buildHoldingsProjection(input({ transactions: [acquired, disposed] }));
    const nextInput = input({ transactions: [acquired, disposed, fee] });
    const incremental = appendHoldingsProjection(previous, nextInput, fee);
    const rebuilt = buildHoldingsProjection(nextInput);

    expect(previous.holdings).toEqual([]);
    expect(previous.displayIdentityIndex.get(`solana:${usdcMint}`)).toEqual({
      asset: 'USDC', chain: 'solana', contractAddress: usdcMint
    });
    expect(incremental).toEqual(rebuilt);
    expect(incremental?.holdings[0]).toMatchObject({
      assetKey: `solana:${usdcMint}`,
      asset: 'USDC',
      chain: 'solana',
      contractAddress: usdcMint,
      quantity: -1
    });
  });

  it('keeps special custody chart semantics off the posting-cost fast path', () => {
    const result = buildHoldingsProjection(input({
      transactions: [tx({ isInternalTransfer: true })]
    }));
    expect(result.chartPostingCostsEquivalent).toBe(false);
  });

  it('keeps account-scoped and ordering-sensitive costs on the custody chart path', () => {
    const scoped = buildHoldingsProjection(input({
      transactions: [tx({ importBatchId: 'batch-1' })]
    }));
    const sameInstantTrade = buildHoldingsProjection(input({
      transactions: [tx({ type: 'trade', counterAsset: 'ETH', counterAmount: 2 })]
    }));
    expect(scoped.chartPostingCostsEquivalent).toBe(false);
    expect(sameInstantTrade.chartPostingCostsEquivalent).toBe(false);
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY]
  ])('rejects %s fiat values from posting-cost chart equivalence', (_label, fiatValue) => {
    const result = buildHoldingsProjection(input({
      transactions: [tx({ type: 'buy', fiatValue })]
    }));
    expect(result.chartPostingCostsEquivalent).toBe(false);
  });

  it('rejects same-timestamp input whose custody ordering can differ from posting ordering', () => {
    const result = buildHoldingsProjection(input({
      transactions: [
        tx({ id: 'z-sell', timestamp: NOW, type: 'sell', amount: 1 }),
        tx({ id: 'a-buy', timestamp: NOW, type: 'buy', amount: 1, fiatValue: 100 })
      ]
    }));
    expect(result.chartPostingCostsEquivalent).toBe(false);
  });
});
