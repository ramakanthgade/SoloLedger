import { describe, expect, it } from 'vitest';
import {
  binanceSpotEndpointProof,
  selectAuthoritySnapshot,
  type AuthorityAssetRow,
  type AuthoritySelectionMetrics,
  type AuthoritySnapshotRow,
  type EndpointProof
} from './authoritySelection';

const NOW = 1_800_000_000_000;
function snapshot(partial: Partial<AuthoritySnapshotRow> = {}): AuthoritySnapshotRow {
  return {
    snapshotId: 's1', generation: 1, scopeId: 'exchange:c1', authorityKind: 'api',
    authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
    asOf: NOW - 1_000, capturedAt: NOW - 1_000, sourceIdentityId: 'c1',
    endpointProof: binanceSpotEndpointProof(), status: 'complete', ...partial
  };
}
function asset(partial: Partial<AuthorityAssetRow> = {}): AuthorityAssetRow {
  return {
    id: 'a1', snapshotId: 's1', generation: 1, scopeId: 'exchange:c1', accountClass: 'spot',
    assetKey: 'asset:BTC', asset: 'BTC', quantity: 2, ...partial
  };
}
const csvProof = (): EndpointProof => ({
  authorityKind: 'csv', provider: 'binance', operation: 'journal_export',
  parametersClass: 'full_history', requestedAccountClasses: ['spot'],
  provenAccountClasses: ['spot'], exhaustiveBalances: true
});

describe('selectAuthoritySnapshot', () => {
  it('selects compatible API over CSV regardless of input order', () => {
    const csv = snapshot({
      snapshotId: 'csv', generation: 2, authorityKind: 'csv', authorityClass: 'journal_final_balance',
      endpointProof: csvProof(), declaredCurrentThrough: NOW
    });
    const result = selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [csv, snapshot()],
      assets: [asset({ snapshotId: 'csv', generation: 2 }), asset()], now: NOW
    });
    expect(result.selectedSnapshot?.snapshotId).toBe('s1');
    expect(result.authorityStatus).toBe('current');
  });

  it('prefers a current compatible CSV generation to stale API evidence', () => {
    const staleApi = snapshot({ asOf: NOW - 86_400_001 });
    const currentCsv = snapshot({
      snapshotId: 'csv', generation: 2, authorityKind: 'csv',
      authorityClass: 'journal_final_balance', endpointProof: csvProof(), declaredCurrentThrough: NOW
    });
    const result = selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [staleApi, currentCsv],
      assets: [asset(), asset({ snapshotId: 'csv', generation: 2 })], now: NOW,
      comparisonAt: currentCsv.asOf
    });
    expect(result.selectedSnapshot?.snapshotId).toBe('csv');
    expect(result.authorityStatus).toBe('current');
  });

  it('never grants Spot authority to Funding/Margin/Futures/Options', () => {
    for (const accountClass of ['funding', 'margin', 'futures', 'options'] as const) {
      expect(selectAuthoritySnapshot({
        scopeId: 'exchange:c1', accountClass, snapshots: [snapshot()], assets: [asset()], now: NOW
      }).authorityStatus).toBe('missing');
    }
  });

  it('marks missing asOf and mixed generations non-comparable', () => {
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [snapshot({ asOf: undefined })], assets: [asset()], now: NOW
    }).authorityStatus).toBe('non_comparable');
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [snapshot()], assets: [asset({ generation: 99 })], now: NOW
    }).authorityStatus).toBe('non_comparable');
  });

  it('retains coherent untimestamped CSV rows as explicitly non-comparable reconstructed evidence', () => {
    const csv = snapshot({
      authorityKind: 'csv', authorityClass: 'journal_final_balance', asOf: undefined,
      endpointProof: csvProof()
    });
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [csv], assets: [asset()], now: NOW
    })).toMatchObject({
      authorityStatus: 'non_comparable', selectedSnapshot: { snapshotId: 's1' },
      selectedAssets: [expect.objectContaining({ asset: 'BTC' })]
    });
  });

  it('lets untimestamped reconstruction evidence outrank stale API, but not current API', () => {
    const reconstructed = snapshot({
      snapshotId: 'csv', generation: 2, authorityKind: 'csv', authorityClass: 'journal_final_balance',
      asOf: undefined, capturedAt: NOW, endpointProof: csvProof()
    });
    const reconstructedAsset = asset({ snapshotId: 'csv', generation: 2, quantity: 0.5 });
    const stale = selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot',
      snapshots: [snapshot({ asOf: NOW - 86_400_001 }), reconstructed],
      assets: [asset(), reconstructedAsset], now: NOW
    });
    expect(stale).toMatchObject({
      authorityStatus: 'non_comparable', selectedSnapshot: { snapshotId: 'csv' },
      selectedAssets: [expect.objectContaining({ quantity: 0.5 })]
    });

    const current = selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [snapshot(), reconstructed],
      assets: [asset(), reconstructedAsset], now: NOW
    });
    expect(current).toMatchObject({ authorityStatus: 'current', selectedSnapshot: { snapshotId: 's1' } });
  });

  it('accepts an empty generation as confirmed zero only with exhaustive proof', () => {
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [snapshot()], assets: [], now: NOW
    })).toMatchObject({
      authorityStatus: 'current', selectedSnapshot: { snapshotId: 's1' }, selectedAssets: []
    });
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot',
      snapshots: [snapshot({ endpointProof: { ...binanceSpotEndpointProof(), exhaustiveBalances: false } })],
      assets: [], now: NOW
    })).toMatchObject({ authorityStatus: 'non_comparable', selectedAssets: [] });
  });

  it('rejects non-empty current-balance evidence without exhaustive quantity proof', () => {
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot',
      snapshots: [snapshot({ endpointProof: { ...binanceSpotEndpointProof(), exhaustiveBalances: false } })],
      assets: [asset()], now: NOW
    })).toMatchObject({ authorityStatus: 'non_comparable', selectedAssets: [] });

    const walletScope = 'wallet:evm:1:0xabc';
    expect(selectAuthoritySnapshot({
      scopeId: walletScope, accountClass: 'wallet', snapshots: [snapshot({
        scopeId: walletScope, authorityKind: 'rpc', authorityClass: 'wallet_balance',
        accountClass: 'wallet', coveredAccountClasses: ['wallet'],
        endpointProof: {
          authorityKind: 'rpc', provider: 'alchemy', operation: 'balance', parametersClass: 'wallet',
          requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'], exhaustiveBalances: false
        }
      })], assets: [asset({ scopeId: walletScope, accountClass: 'wallet' })], now: NOW
    })).toMatchObject({ authorityStatus: 'non_comparable', selectedAssets: [] });
  });

  it('rejects a non-empty row whose generation is absent or differs from its snapshot', () => {
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [snapshot()],
      assets: [asset({ generation: 2 })], now: NOW
    }).authorityStatus).toBe('non_comparable');
  });

  it('rejects duplicate snapshot identity instead of revisiting one asset generation', () => {
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot',
      snapshots: [snapshot(), snapshot({ generation: 2 })], assets: [asset()], now: NOW
    }).authorityStatus).toBe('non_comparable');
  });

  it('uses injected clocks: API/RPC expire at 24h', () => {
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [snapshot({ asOf: NOW - 86_400_001 })], assets: [asset()], now: NOW
    }).authorityStatus).toBe('stale');
  });

  it('rejects API/RPC evidence after comparisonAt and permits exact or past evidence', () => {
    const cases = [
      {
        scopeId: 'exchange:c1', accountClass: 'spot' as const,
        authority: snapshot({ asOf: NOW - 1_000 }), row: asset()
      },
      {
        scopeId: 'wallet:evm:1:0xabc', accountClass: 'wallet' as const,
        authority: snapshot({
          scopeId: 'wallet:evm:1:0xabc', authorityKind: 'rpc', authorityClass: 'wallet_balance',
          accountClass: 'wallet', coveredAccountClasses: ['wallet'],
          endpointProof: {
            authorityKind: 'rpc', provider: 'alchemy', operation: 'balance', parametersClass: 'wallet',
            requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'], exhaustiveBalances: true
          }
        }),
        row: asset({ scopeId: 'wallet:evm:1:0xabc', accountClass: 'wallet' })
      }
    ];
    for (const testCase of cases) {
      expect(selectAuthoritySnapshot({
        scopeId: testCase.scopeId, accountClass: testCase.accountClass,
        snapshots: [testCase.authority], assets: [testCase.row], now: NOW,
        comparisonAt: testCase.authority.asOf! - 1
      }).authorityStatus).toBe('non_comparable');
      expect(selectAuthoritySnapshot({
        scopeId: testCase.scopeId, accountClass: testCase.accountClass,
        snapshots: [testCase.authority], assets: [testCase.row], now: NOW,
        comparisonAt: testCase.authority.asOf
      }).authorityStatus).toBe('current');
      expect(selectAuthoritySnapshot({
        scopeId: testCase.scopeId, accountClass: testCase.accountClass,
        snapshots: [testCase.authority], assets: [testCase.row], now: NOW,
        comparisonAt: testCase.authority.asOf! + 1
      }).authorityStatus).toBe('current');
    }
  });

  it('selects eligible past evidence instead of a newer generation from after comparisonAt', () => {
    const past = snapshot({ snapshotId: 'past', generation: 1, asOf: NOW - 2 * 86_400_000 });
    const future = snapshot({ snapshotId: 'future', generation: 2, asOf: NOW });
    const selected = selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [future, past],
      assets: [
        asset({ id: 'future-row', snapshotId: 'future', generation: 2, quantity: 0 }),
        asset({ id: 'past-row', snapshotId: 'past', generation: 1, quantity: 2 })
      ],
      now: NOW, comparisonAt: NOW - 86_400_000
    });
    expect(selected).toMatchObject({
      authorityStatus: 'stale', selectedSnapshot: { snapshotId: 'past' },
      selectedAssets: [expect.objectContaining({ quantity: 2 })]
    });
  });

  it('indexes many authority generations once and selects with linear work', () => {
    const count = 5_000;
    const snapshots = Array.from({ length: count }, (_, index) => snapshot({
      snapshotId: `snapshot-${index}`, generation: index + 1, capturedAt: NOW + index
    }));
    const assets = snapshots.map((row, index) => asset({
      id: `asset-${index}`, snapshotId: row.snapshotId, generation: row.generation, quantity: index
    }));
    const metrics: AuthoritySelectionMetrics = {
      assetIndexVisits: 0, snapshotVisits: 0, coherenceAssetVisits: 0, candidateComparisons: 0
    };

    const selected = selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots, assets, now: NOW, metrics
    });

    expect(selected.selectedSnapshot?.generation).toBe(count);
    expect(selected.selectedAssets[0].quantity).toBe(count - 1);
    expect(metrics).toEqual({
      assetIndexVisits: count,
      snapshotVisits: count,
      coherenceAssetVisits: count,
      candidateComparisons: count - 1
    });
  });

  it.each([
    [NOW - 2_000, 'non_comparable'],
    [NOW - 1_000, 'current'],
    [NOW, 'stale']
  ] as const)('classifies CSV comparisonAt %s against asOf before/equal/after', (comparisonAt, expected) => {
    const csv = snapshot({
      authorityKind: 'csv', authorityClass: 'journal_final_balance',
      endpointProof: csvProof(),
      declaredCurrentThrough: NOW - 10_000
    });
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [csv], assets: [asset()],
      now: NOW, comparisonAt
    }).authorityStatus).toBe(expected);
  });

  it('validates endpoint class proof and authority-kind/scope compatibility', () => {
    for (const endpointProof of [
      { ...binanceSpotEndpointProof(), requestedAccountClasses: ['spot'] as const, provenAccountClasses: ['funding'] as const },
      { ...binanceSpotEndpointProof(), requestedAccountClasses: ['funding'] as const, provenAccountClasses: ['spot'] as const }
    ]) {
      expect(selectAuthoritySnapshot({
        scopeId: 'exchange:c1', accountClass: 'spot',
        snapshots: [snapshot({ endpointProof: {
          ...endpointProof,
          requestedAccountClasses: [...endpointProof.requestedAccountClasses],
          provenAccountClasses: [...endpointProof.provenAccountClasses]
        } })],
        assets: [asset()], now: NOW
      }).authorityStatus).toBe('non_comparable');
    }
    for (const accountClass of ['funding', 'margin', 'futures', 'options'] as const) {
      const relabeled = snapshot({
        accountClass, coveredAccountClasses: [accountClass]
      });
      expect(selectAuthoritySnapshot({
        scopeId: 'exchange:c1', accountClass, snapshots: [relabeled],
        assets: [asset({ accountClass })], now: NOW
      }).authorityStatus).toBe('non_comparable');
    }
    expect(selectAuthoritySnapshot({
      scopeId: 'wallet:evm:1:0xabc', accountClass: 'wallet',
      snapshots: [snapshot({
        scopeId: 'wallet:evm:1:0xabc', authorityKind: 'rpc', authorityClass: 'wallet_balance',
        accountClass: 'wallet', coveredAccountClasses: ['wallet'],
        endpointProof: {
          authorityKind: 'rpc', provider: 'alchemy', operation: 'balance', parametersClass: 'wallet',
          requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'], exhaustiveBalances: true
        }
      })],
      assets: [asset({ scopeId: 'wallet:evm:1:0xabc', accountClass: 'wallet' })], now: NOW
    }).authorityStatus).toBe('current');
    expect(selectAuthoritySnapshot({
      scopeId: 'wallet:evm:1:0xabc', accountClass: 'wallet',
      snapshots: [snapshot({
        scopeId: 'wallet:evm:1:0xabc', accountClass: 'wallet', coveredAccountClasses: ['wallet'],
        endpointProof: { ...binanceSpotEndpointProof(), requestedAccountClasses: ['wallet'], provenAccountClasses: ['wallet'] }
      })], assets: [], now: NOW
    }).authorityStatus).toBe('non_comparable');

    const rpcOnExchange = snapshot({
      authorityKind: 'rpc', authorityClass: 'wallet_balance',
      endpointProof: {
        authorityKind: 'rpc', provider: 'alchemy', operation: 'balance', parametersClass: 'wallet',
        requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true
      }
    });
    expect(selectAuthoritySnapshot({
      scopeId: 'exchange:c1', accountClass: 'spot', snapshots: [rpcOnExchange], assets: [asset()], now: NOW
    }).authorityStatus).toBe('non_comparable');

    const fileCsv = snapshot({
      scopeId: 'file:batch:spot', authorityKind: 'csv', authorityClass: 'journal_final_balance',
      endpointProof: csvProof()
    });
    expect(selectAuthoritySnapshot({
      scopeId: 'file:batch:spot', accountClass: 'spot', snapshots: [fileCsv],
      assets: [asset({ scopeId: 'file:batch:spot' })], now: NOW, comparisonAt: fileCsv.asOf
    }).authorityStatus).toBe('current');
    expect(selectAuthoritySnapshot({
      scopeId: 'wallet:evm:1:0xabc', accountClass: 'spot',
      snapshots: [{ ...fileCsv, scopeId: 'wallet:evm:1:0xabc' }],
      assets: [asset({ scopeId: 'wallet:evm:1:0xabc' })], now: NOW, comparisonAt: fileCsv.asOf
    }).authorityStatus).toBe('non_comparable');
  });
});
