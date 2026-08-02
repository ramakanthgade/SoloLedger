import { describe, expect, it } from 'vitest';
import type { Transaction } from '@/types/transaction';
import {
  derivePostings,
  deriveTransactionPostings,
  resolveAccountScope,
  type DerivedPostingContext
} from './derivedPostings';
import { postingBalances } from './postingBalances';
import { stitchBinanceTransactionHistory } from '@/lib/parsers/binanceStitch';
import { buildCsvImportEvidenceGeneration } from '@/lib/parsers/importEvidence';
import { associateSourceCoverageScope } from '@/lib/reconcile/sourceCoverage';

function tx(partial: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1', timestamp: 1_700_000_000_000, type: 'buy', asset: 'BTC', amount: 2,
    fiatCurrency: 'USD', source: 'manual', flags: [], isInternalTransfer: false,
    ...partial
  };
}

const context: DerivedPostingContext = {
  exchangeConnections: [{ id: 'conn-1', exchange: 'binance', provenAccountClasses: ['spot'] }]
};

function totals(rows: ReturnType<typeof deriveTransactionPostings>) {
  return Object.fromEntries(rows.map((row) => [row.asset, row.signedQuantity]));
}

describe('deriveTransactionPostings', () => {
  it.each([
    ['buy', 2], ['transfer_in', 2], ['income', 2], ['gift_received', 2],
    ['nft_mint', 2], ['nft_buy', 2], ['defi_withdraw', 2],
    ['sell', -2], ['transfer_out', -2], ['gift_sent', -2],
    ['nft_sell', -2], ['defi_deposit', -2], ['trade', -2], ['other', 0]
  ] as const)('emits the canonical %s principal sign', (type, expected) => {
    const rows = deriveTransactionPostings(tx({ type }), context);
    expect(rows.find((row) => row.role === 'principal')?.signedQuantity ?? 0).toBe(expected);
  });

  it('emits stable principal/counter/fee phases, ordinals, ids, and no valuation fields', () => {
    const transaction = tx({
      id: 'swap', source: 'binance_api', importBatchId: 'conn-1', type: 'trade',
      asset: 'ETH', amount: 2, counterAsset: 'BTC', counterAmount: 0.1,
      feeAsset: 'BNB', feeAmount: 0.01, fiatValue: 5_000
    });
    const first = deriveTransactionPostings(transaction, context);
    const second = deriveTransactionPostings(transaction, context);
    expect(first).toEqual(second);
    expect(first.map(({ role, postingPhase, ordinal }) => ({ role, postingPhase, ordinal }))).toEqual([
      { role: 'principal', postingPhase: 10, ordinal: 0 },
      { role: 'counter', postingPhase: 20, ordinal: 0 },
      { role: 'fee', postingPhase: 30, ordinal: 0 }
    ]);
    expect(totals(first)).toEqual({ ETH: -2, BTC: 0.1, BNB: -0.01 });
    for (const posting of first) {
      expect(posting.id).toContain(`${posting.postingPhase}:${posting.ordinal}:${posting.assetKey}`);
      expect(posting).not.toHaveProperty('fiatValue');
      expect(posting).not.toHaveProperty('costBasis');
      expect(posting).not.toHaveProperty('gain');
    }
  });

  it('keeps one posting set and both evidence refs for a CSV survivor/API twin', () => {
    const api = tx({
      id: 'api', source: 'binance_api', sourceRef: 'same', importBatchId: 'conn-1',
      raw: { tradeId: 'native-1' }
    });
    const survivor = tx({
      id: 'csv', source: 'binance', sourceRef: 'same', importBatchId: 'csv-file',
      dedupMatchedApiId: 'conn-1:buy:BTC:native-1', dedupMatchedApiRow: api
    });
    const postings = derivePostings([survivor], context);
    expect(postings).toHaveLength(1);
    expect(postings[0].evidence.map((ref) => ref.kind)).toEqual(['transaction', 'suppressed_twin']);
    expect(postings[0].accountScopeId).toBe('exchange:conn-1');
  });

  it('preserves duplicate cardinality for two CSV survivors and two exact API identities', () => {
    const survivors = [1, 2].map((index) => {
      const api = tx({
        id: `api-${index}`, source: 'binance_api', sourceRef: 'same-economic-ref',
        importBatchId: 'conn-1', raw: { tradeId: `native-${index}` }
      });
      return tx({
        id: `csv-${index}`, source: 'binance', sourceRef: `same-economic-ref#h${index}`,
        dedupMatchedApiRow: api, dedupMatchedApiId: `identity-${index}`
      });
    });
    const postings = derivePostings(survivors, context);
    expect(postings).toHaveLength(2);
    expect(new Set(postings.map((posting) => posting.id)).size).toBe(2);
    expect(new Set(postings.flatMap((posting) => posting.evidence)
      .filter((evidence) => evidence.kind === 'suppressed_twin')
      .map((evidence) => evidence.apiIdentity)).size).toBe(2);
  });

  it.each(['hyperliquid_trades', 'wazirx_ledger'])('emits one fee-role debit for %s fee rows', (source) => {
    const postings = deriveTransactionPostings(tx({
      type: 'fee', source, asset: 'USDC', amount: 3, feeAsset: 'USDC', feeAmount: 3,
      category: source === 'hyperliquid_trades' ? 'perp' : undefined
    }), context);
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({ role: 'fee', postingPhase: 30, asset: 'USDC', signedQuantity: -3 });
  });

  it('does not add a second fee debit when standalone feeAmount names another asset', () => {
    const postings = deriveTransactionPostings(tx({
      type: 'fee', asset: 'HYPE', amount: 2, feeAsset: 'USDC', feeAmount: 5
    }), context);
    expect(postings).toHaveLength(1);
    expect(postings[0]).toMatchObject({ role: 'fee', asset: 'HYPE', signedQuantity: -2 });
  });

  it('makes API-first and CSV-first survivor representations custody-equivalent', () => {
    const api = tx({ id: 'api', source: 'binance_api', importBatchId: 'conn-1', sourceRef: 'same' });
    const csv = tx({ id: 'csv', source: 'binance', sourceRef: 'same', dedupMatchedApiRow: api });
    const projection = (transaction: Transaction) => derivePostings([transaction], context)
      .map(({ accountScopeId, accountClass, assetKey, signedQuantity }) => ({ accountScopeId, accountClass, assetKey, signedQuantity }));
    expect(projection(csv)).toEqual(projection(api));
  });
});

describe('resolveAccountScope', () => {
  it('resolves direct API, exact twin, and exactly-one Binance fallback', () => {
    expect(resolveAccountScope(tx({ source: 'binance_api', importBatchId: 'conn-1' }), context))
      .toMatchObject({ scopeStatus: 'resolved', accountScopeId: 'exchange:conn-1', accountClass: 'spot' });
    expect(resolveAccountScope(tx({ source: 'binance' }), context))
      .toMatchObject({ scopeStatus: 'resolved', accountScopeId: 'exchange:conn-1' });
  });

  it('does not guess among multiple Binance connections', () => {
    const result = resolveAccountScope(tx({ source: 'binance' }), {
      exchangeConnections: [...context.exchangeConnections, { id: 'conn-2', exchange: 'binance' }]
    });
    expect(result).toMatchObject({ scopeStatus: 'unresolved', reason: 'multiple_binance_connections' });
  });

  it.each([
    ['Spot', 'spot'], ['Funding', 'funding'], ['Cross Margin', 'margin'],
    ['USD-M Futures', 'futures'], ['Options', 'options']
  ] as const)('partitions Binance %s as %s', (Account, accountClass) => {
    expect(resolveAccountScope(tx({ source: 'binance', raw: { Account } }), context).accountClass).toBe(accountClass);
  });

  it('uses parser class provenance for sell/convert/dust while live Binance ownership controls scope', () => {
    const parsed = stitchBinanceTransactionHistory([
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Funding', Operation: 'Transaction Sold', Coin: 'BTC', Change: '-0.1' },
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Funding', Operation: 'Transaction Revenue', Coin: 'USDT', Change: '5000' },
      { UTC_Time: '2025-01-01 00:00:00', Account: 'Funding', Operation: 'Transaction Fee', Coin: 'USDT', Change: '-1' },
      { UTC_Time: '2025-01-01 00:01:00', Account: 'Margin', Operation: 'Sell', Coin: 'ETH', Change: '-2' },
      { UTC_Time: '2025-01-01 00:01:00', Account: 'Margin', Operation: 'Buy', Coin: 'USDT', Change: '4000' },
      { UTC_Time: '2025-01-01 00:01:00', Account: 'Margin', Operation: 'Fee', Coin: 'USDT', Change: '-1' },
      { UTC_Time: '2025-01-01 00:02:00', Account: 'Funding', Operation: 'Binance Convert', Coin: 'BTC', Change: '-1' },
      { UTC_Time: '2025-01-01 00:02:00', Account: 'Funding', Operation: 'Binance Convert', Coin: 'ETH', Change: '10' },
      { UTC_Time: '2025-01-01 00:03:00', Account: 'Margin', Operation: 'Small Assets Exchange BNB', Coin: 'SOL', Change: '-1', Remark: 'dust' },
      { UTC_Time: '2025-01-01 00:03:00', Account: 'Margin', Operation: 'Small Assets Exchange BNB', Coin: 'BNB', Change: '0.1', Remark: 'dust' }
    ]);
    const imported = parsed.transactions.map((transaction) => ({
      ...transaction,
      importBatchId: 'csv-classes'
    }));
    const generation = buildCsvImportEvidenceGeneration({
      sourceIdentityId: 'csv-classes', parserId: 'binance', parsedBeforeDedup: imported.length,
      savedAfterDedup: imported.length, savedTransactions: imported,
      evidence: { ...parsed.evidence, declaredHistory: { completeHistory: true } },
      completedAt: 100, generation: 1
    });

    expect(imported.map((transaction) => transaction.parserAccountClass)).toEqual([
      'funding', 'margin', 'funding', 'margin'
    ]);
    expect(imported.map((transaction) => Object.keys(transaction.raw ?? {})[0])).toEqual([
      'sold', 'sell', 'out', 'spent'
    ]);
    const withoutConnection = derivePostings(imported, { exchangeConnections: [] });
    expect(new Set(withoutConnection.map((posting) => posting.accountScopeId))).toEqual(new Set([
      'file:csv-classes:funding', 'file:csv-classes:margin'
    ]));
    expect(new Set(withoutConnection.map((posting) => posting.accountScopeId))).toEqual(
      new Set(generation.coverage.map((coverage) => coverage.scopeId))
    );

    const oneConnection = [{ id: 'live-binance', exchange: 'binance', provenAccountClasses: ['spot' as const] }];
    const linked = derivePostings(imported, { exchangeConnections: oneConnection });
    expect(new Set(linked.map((posting) => posting.accountScopeId))).toEqual(new Set(['exchange:live-binance']));
    expect(new Set(linked.map((posting) => posting.accountClass))).toEqual(new Set(['funding', 'margin']));
    const associatedCoverage = generation.coverage.map((coverage) =>
      associateSourceCoverageScope(coverage, oneConnection));
    expect(associatedCoverage.every((association) => association.scopeStatus === 'resolved' &&
      association.accountScopeId === 'exchange:live-binance')).toBe(true);
    expect(generation.coverage.map((coverage) => coverage.scopeId)).toEqual([
      'file:csv-classes:funding', 'file:csv-classes:margin'
    ]);

    const multipleConnections = [
      ...oneConnection,
      { id: 'other-binance', exchange: 'binance', provenAccountClasses: ['spot' as const] }
    ];
    expect(imported.map((transaction) => resolveAccountScope(transaction, {
      exchangeConnections: multipleConnections
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({ scopeStatus: 'unresolved', accountClass: 'funding', reason: 'multiple_binance_connections' }),
      expect.objectContaining({ scopeStatus: 'unresolved', accountClass: 'margin', reason: 'multiple_binance_connections' })
    ]));
    expect(generation.coverage.map((coverage) => associateSourceCoverageScope(coverage, multipleConnections)))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ scopeStatus: 'unresolved', accountClass: 'funding' }),
        expect.objectContaining({ scopeStatus: 'unresolved', accountClass: 'margin' })
      ]));
  });

  it('retains explicit unknown class when unique live Binance ownership resolves exchange scope', () => {
    expect(resolveAccountScope(tx({
      source: 'binance', importBatchId: 'csv-unknown', parserAccountClass: 'unknown'
    }), context)).toMatchObject({
      accountScopeId: 'exchange:conn-1', accountClass: 'unknown'
    });
  });

  it('keeps Options file-scoped while an ordinary Binance class in the same workbook follows live ownership', () => {
    const ordinary = tx({
      id: 'ordinary-sell', source: 'binance', importBatchId: 'mixed-book', parserAccountClass: 'funding'
    });
    const options = tx({
      id: 'options-sell', source: 'binance_options', importBatchId: 'mixed-book', parserAccountClass: 'options'
    });
    const generation = buildCsvImportEvidenceGeneration({
      sourceIdentityId: 'mixed-book', parserId: 'binance+binance_options', parsedBeforeDedup: 2,
      savedAfterDedup: 2, savedTransactions: [ordinary, options], completedAt: 100, generation: 1,
      evidence: {
        declaredHistory: { completeHistory: true }, coveredAccountClasses: ['funding', 'options'],
        requiredOutcomes: [
          { id: 'journal', parserId: 'binance', accountClass: 'funding', required: true, status: 'complete',
            recognizedCount: 1, parsedCount: 1, parsedTransactionRows: [{ transactionId: ordinary.id, sourceRowCount: 1 }] },
          { id: 'options', parserId: 'binance_options', accountClass: 'options', required: true, status: 'complete',
            recognizedCount: 1, parsedCount: 1, parsedTransactionRows: [{ transactionId: options.id, sourceRowCount: 1 }] }
        ],
        recognizedCount: 2, parsedCount: 2, excludedCount: 0, skippedCount: 0, failedCount: 0,
        exclusionReasons: [], skippedReasons: [], failureReasons: []
      }
    });
    const fundingCoverage = generation.coverage.find((row) => row.accountClasses[0] === 'funding')!;
    const optionsCoverage = generation.coverage.find((row) => row.accountClasses[0] === 'options')!;
    const contexts = [
      { exchangeConnections: [] },
      { exchangeConnections: [{ id: 'only', exchange: 'binance' }] },
      { exchangeConnections: [{ id: 'one', exchange: 'binance' }, { id: 'two', exchange: 'binance' }] }
    ] satisfies DerivedPostingContext[];

    expect(contexts.map((scopeContext) => resolveAccountScope(ordinary, scopeContext))).toEqual([
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:mixed-book:funding', accountClass: 'funding' }),
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'exchange:only', accountClass: 'funding' }),
      expect.objectContaining({ scopeStatus: 'unresolved', accountClass: 'funding', reason: 'multiple_binance_connections' })
    ]);
    expect(contexts.map((scopeContext) => resolveAccountScope(options, scopeContext))).toEqual([
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:mixed-book:options', accountClass: 'options' }),
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:mixed-book:options', accountClass: 'options' }),
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:mixed-book:options', accountClass: 'options' })
    ]);
    expect(resolveAccountScope({
      ...options,
      dedupMatchedApiRow: tx({ source: 'binance_api', importBatchId: 'only' })
    }, contexts[1])).toMatchObject({
      scopeStatus: 'resolved', accountScopeId: 'exchange:only', accountClass: 'options'
    });
    expect(contexts.map((scopeContext) => associateSourceCoverageScope(
      fundingCoverage, scopeContext.exchangeConnections
    ))).toEqual([
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:mixed-book:funding' }),
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'exchange:only' }),
      expect.objectContaining({ scopeStatus: 'unresolved', reason: 'multiple_binance_connections' })
    ]);
    expect(contexts.map((scopeContext) => associateSourceCoverageScope(
      optionsCoverage, scopeContext.exchangeConnections
    ))).toEqual([
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:mixed-book:options' }),
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:mixed-book:options' }),
      expect.objectContaining({ scopeStatus: 'resolved', accountScopeId: 'file:mixed-book:options' })
    ]);
  });

  it('marks deleted direct provenance instead of falling back', () => {
    expect(resolveAccountScope(tx({ source: 'binance_api', importBatchId: 'gone' }), context))
      .toMatchObject({ scopeStatus: 'source_deleted', accountScopeId: 'exchange:gone' });
    expect(resolveAccountScope(tx({
      source: 'binance', dedupMatchedApiRow: tx({ source: 'binance_api', importBatchId: 'gone' })
    }), context)).toMatchObject({
      scopeStatus: 'source_deleted', accountScopeId: 'exchange:gone', sourceIdentityId: 'gone'
    });
  });

  it('keeps tombstoned survivor provenance deleted even when the same connection id is reused', () => {
    const survivor = tx({
      id: 'csv-tombstone', source: 'binance', importBatchId: 'csv-file',
      parserAccountClass: 'unknown',
      deletedSourceEvidence: {
        kind: 'deleted_exchange_source', sourceIdentityId: 'conn-1', transactionId: 'old-api',
        source: 'binance_api', sourceRef: 'native-1', apiIdentity: 'identity-1', deletedAt: 99
      }
    });
    expect(resolveAccountScope(survivor, context)).toMatchObject({
      scopeStatus: 'source_deleted', accountScopeId: 'exchange:conn-1', accountClass: 'unknown',
      sourceIdentityId: 'conn-1'
    });
    expect(derivePostings([survivor], context)[0].evidence).toEqual([
      expect.objectContaining({ kind: 'transaction', role: 'survivor' }),
      expect.objectContaining({
        kind: 'deleted_source', sourceIdentityId: 'conn-1', transactionId: 'old-api',
        apiIdentity: 'identity-1', deletedAt: 99
      })
    ]);
  });

  it('uses the canonical chain namespace in wallet scope identity', () => {
    expect(resolveAccountScope(tx({
      source: 'rpc:moralis', chain: 'eth', walletAddress: '0xABC'
    }), context)).toMatchObject({ accountScopeId: 'wallet:evm:1:0xabc', accountClass: 'wallet' });
    expect(resolveAccountScope(tx({
      source: 'rpc:moralis', chain: 'custom_evm', walletAddress: '0xABC', raw: { customNetworkId: 'eip155:777' }
    }), context)).toMatchObject({ accountScopeId: 'wallet:evm:custom:eip155:777:0xabc' });
    expect(resolveAccountScope(tx({
      source: 'rpc:moralis', chain: 'custom_evm', walletAddress: '0xABC'
    }), context)).toMatchObject({
      scopeStatus: 'unresolved', accountScopeId: 'wallet:evm:custom:unresolved:0xabc',
      reason: 'missing_custom_network_identity'
    });
  });
});

describe('derivePostings manual scope shortcut', () => {
  it.each([
    ['raw Account', { Account: 'Funding' }, 'funding'],
    ['raw buy Account', { buy: { Account: 'Margin' } }, 'margin'],
    ['raw spend Account', { spend: { Account: 'Options' } }, 'options']
  ] as const)('preserves %s classification and file scope', (_label, raw, accountClass) => {
    const [posting] = derivePostings([tx({
      id: `manual-${accountClass}`, source: 'manual', importBatchId: 'manual-batch',
      type: 'transfer_in', raw
    })], context);
    expect(posting).toMatchObject({
      accountClass,
      accountScopeId: `file:manual-batch:${accountClass}`,
      signedQuantity: 2
    });
  });

  it.each([
    ['without a batch', undefined, 'manual'],
    ['with a batch', 'manual-batch', 'file:manual-batch:manual']
  ] as const)('preserves the fast manual path %s', (_label, importBatchId, accountScopeId) => {
    const [posting] = derivePostings([tx({
      id: `simple-${importBatchId ?? 'manual'}`, source: 'manual', importBatchId,
      type: 'transfer_out', raw: undefined
    })], context);
    expect(posting).toMatchObject({ accountClass: 'manual', accountScopeId, signedQuantity: -2 });
    expect(posting.evidence).toEqual([
      expect.objectContaining({ kind: 'transaction', role: 'direct' })
    ]);
  });
});

describe('opening balances and internal custody', () => {
  it('keeps the bulk derivation path identical to per-transaction derivation', () => {
    const transactions = [
      tx({ id: 'api-trade', timestamp: 1, source: 'binance_api', importBatchId: 'conn-1', type: 'trade',
        asset: 'ETH', counterAsset: 'USDC', counterAmount: 2_000, feeAsset: 'ETH', feeAmount: 0.01 }),
      tx({ id: 'csv', timestamp: 2, source: 'binance', raw: { Account: 'Funding' }, type: 'transfer_in' }),
      tx({ id: 'wallet', timestamp: 3, source: 'rpc:moralis', chain: 'ethereum', walletAddress: '0xABC', type: 'transfer_out' }),
      tx({ id: 'fee', timestamp: 4, source: 'manual', type: 'fee' }),
      tx({ id: 'spam', timestamp: 5, source: 'manual', isSpam: true })
    ];
    expect(derivePostings(transactions, context)).toEqual(
      transactions.flatMap((transaction) => deriveTransactionPostings(transaction, context))
    );
  });

  it('selects absolute openings by cutoff and retains historical openings', () => {
    const rows = derivePostings([
      tx({ id: 'before', timestamp: 10, source: 'binance_api', importBatchId: 'conn-1', amount: 2 }),
      tx({ id: 'between', timestamp: 30, source: 'binance_api', importBatchId: 'conn-1', amount: 3 }),
      tx({ id: 'after', timestamp: 50, source: 'binance_api', importBatchId: 'conn-1', amount: 4 })
    ], {
      ...context,
      openingBalances: [{
        id: 'open', logicalKey: 'k', scopeId: 'exchange:conn-1', accountClass: 'spot',
        assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 10, effectiveAt: 20,
        provenance: 'user_confirmed', createdAt: 1, updatedAt: 1, supersededAt: 40
      }, {
        id: 'open-2', logicalKey: 'k2', scopeId: 'exchange:conn-1', accountClass: 'spot',
        assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 20, effectiveAt: 40,
        provenance: 'user_confirmed', createdAt: 2, updatedAt: 2
      }]
    });
    const balance = (asOf: number) => [...postingBalances(rows, { asOf }).values()][0];
    expect(balance(15)).toBe(2);
    expect(balance(35)).toBe(13);
    expect(balance(45)).toBe(20);
    expect(balance(55)).toBe(24);
    expect(rows.filter((row) => row.role === 'opening_balance')).toHaveLength(2);
  });

  it('rejects an opening that shares an exact instant with source activity', () => {
    expect(() => derivePostings([
      tx({ timestamp: 20, source: 'binance_api', importBatchId: 'conn-1' })
    ], { ...context, openingBalances: [{
      id: 'open', logicalKey: 'k', scopeId: 'exchange:conn-1', accountClass: 'spot',
      assetKey: 'asset:BTC', asset: 'BTC', absoluteQuantity: 10, effectiveAt: 20,
      provenance: 'user_confirmed', createdAt: 1, updatedAt: 1
    }] })).toThrow('ambiguous opening balance instant');
  });

  it('keeps same-scope internal legs so they net, and keeps one-sided movement visible', () => {
    const pair = derivePostings([
      tx({ id: 'out', type: 'transfer_out', amount: 4, source: 'binance', raw: { Account: 'Spot' }, isInternalTransfer: true }),
      tx({ id: 'in', type: 'transfer_in', amount: 4, source: 'binance', raw: { Account: 'Funding' }, isInternalTransfer: true })
    ], context);
    expect(pair.reduce((sum, row) => sum + row.signedQuantity, 0)).toBe(0);
    expect(derivePostings([tx({ type: 'transfer_out', amount: 4, isInternalTransfer: true })], context)[0].signedQuantity).toBe(-4);
  });
});
