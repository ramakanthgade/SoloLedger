import type { Transaction } from '@/types/transaction';
import type { AuthoritySelection } from '@/lib/reconcile/authoritySelection';
import { reconcileDerivedPostings } from '@/lib/reconcile/sourceReconcile';
import { derivePostings } from './derivedPostings';
import {
  buildChartPrefixIndex, buildRunningBalanceIndex, postingBalances, preparePostingAggregation
} from './postingBalances';

function transaction(id: string, timestamp: number, amount: number): Transaction {
  return {
    id, timestamp, type: amount >= 0 ? 'transfer_in' : 'transfer_out', asset: 'BTC',
    amount: Math.abs(amount), fiatCurrency: 'USD', source: 'manual', flags: [], isInternalTransfer: false
  };
}

export function buildPostingPerformanceFixtures(): Transaction[] {
  return Array.from({ length: 30_000 }, (_, index): Transaction => {
    const base = transaction(`p-${index}`, index * 1_000, index % 3 ? 2 : -1);
    if (index % 10 === 0) return {
      ...base, type: 'trade', asset: 'ETH', amount: 1, counterAsset: 'USDC', counterAmount: 2000,
      feeAsset: 'ETH', feeAmount: 0.001, source: 'binance_api', importBatchId: 'conn-perf'
    };
    if (index % 4 === 0) return {
      ...base, asset: 'USDT', source: 'binance', raw: { Account: 'Funding' }
    };
    if (index % 2 === 0) return {
      ...base, asset: 'USDC', chain: 'ethereum', contractAddress: '0xA0b8',
      source: 'rpc:moralis', walletAddress: '0xWallet'
    };
    return { ...base, asset: 'BTC', source: 'manual', importBatchId: 'manual-perf' };
  });
}

const authority: AuthoritySelection = {
  authorityStatus: 'current',
  selectedSnapshot: {
    snapshotId: 'perf', generation: 1, scopeId: 'exchange:conn-perf', authorityKind: 'api',
    authorityClass: 'exchange_balance', accountClass: 'spot', coveredAccountClasses: ['spot'],
    asOf: 30_000_000, capturedAt: 30_000_000, sourceIdentityId: 'conn-perf', status: 'complete',
    endpointProof: {
      authorityKind: 'api', provider: 'binance', operation: 'fetchBalance', parametersClass: 'spot',
      requestedAccountClasses: ['spot'], provenAccountClasses: ['spot'], exhaustiveBalances: true
    }
  },
  selectedAssets: [{
    id: 'perf:ETH', snapshotId: 'perf', generation: 1, scopeId: 'exchange:conn-perf',
    accountClass: 'spot', assetKey: 'asset:ETH', asset: 'ETH', quantity: 0
  }],
  diagnostics: []
};

export function runPostingPerformanceScenario(fixtures: readonly Transaction[]) {
  const postings = derivePostings(fixtures, {
    exchangeConnections: [{ id: 'conn-perf', exchange: 'binance' }]
  });
  const prepared = preparePostingAggregation(postings);
  const metrics = { postingVisits: 0 };
  const balances = postingBalances(postings, { metrics }, prepared);
  const running = buildRunningBalanceIndex(postings, metrics, prepared);
  const chart = buildChartPrefixIndex(postings, 'day', metrics, prepared);
  const reconciliation = reconcileDerivedPostings({
    scopeId: 'exchange:conn-perf', accountClass: 'spot', assetKey: 'asset:ETH', asset: 'ETH',
    postings, authority, coverage: { status: 'complete' }, scopeStatus: 'resolved'
  });
  return { postings, balances, running, chart, reconciliation, metrics };
}
