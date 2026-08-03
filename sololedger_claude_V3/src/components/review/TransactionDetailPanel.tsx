import type { ReactNode } from 'react';
import type { AccountScopeResolution, DerivedPosting } from '@/lib/ledger/derivedPostings';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { TransactionCostAnalysisModel } from './transactionCostAnalysisModel';
import { TransactionDetailsTab } from './TransactionDetailsTab';
import { TransactionLedgerTab } from './TransactionLedgerTab';
import { TransactionCostAnalysisTab } from './TransactionCostAnalysisTab';

export type DetailTab = 'details' | 'ledger' | 'cost';
const TABS: Array<{ id: DetailTab; label: string }> = [{ id: 'details', label: 'Details' }, { id: 'ledger', label: 'Ledger' }, { id: 'cost', label: 'Cost Analysis' }];

export function TransactionDetailPanel(props: {
  details: ReactNode;
  scope: AccountScopeResolution;
  coverage?: SourceCoverageRow;
  authorityGeneration?: number;
  postings: readonly DerivedPosting[];
  runningBalances: ReadonlyMap<string, number>;
  costAnalysis: TransactionCostAnalysisModel;
  activeTab: DetailTab;
  onActiveTabChange: (tab: DetailTab) => void;
}) {
  const tab = props.activeTab;
  const select = props.onActiveTabChange;
  return <div className="border-t border-hi/10 bg-elev-1/40 px-4 py-4 pb-24 focus:outline-none sm:px-6 lg:pb-6" data-testid="tx-details" tabIndex={-1}>
    <div role="tablist" aria-label="Transaction detail views" className="mb-4 flex gap-5 border-b border-hi/10">
      {TABS.map((item, index) => <button key={item.id} id={`transaction-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`transaction-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => select(item.id)} onKeyDown={(event) => {
        const next = event.key === 'ArrowLeft' ? (index - 1 + TABS.length) % TABS.length
          : event.key === 'ArrowRight' ? (index + 1) % TABS.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : undefined;
        if (next == null) return;
        event.preventDefault(); select(TABS[next].id); document.getElementById(`transaction-tab-${TABS[next].id}`)?.focus();
      }} className={tab === item.id ? 'h-11 border-b-2 border-primary px-1 text-xs font-bold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50' : 'h-11 border-b-2 border-transparent px-1 text-xs font-bold text-low hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50'}>{item.label}</button>)}
    </div>
    {tab === 'details' && <TransactionDetailsTab scope={props.scope} coverage={props.coverage} authorityGeneration={props.authorityGeneration}>{props.details}</TransactionDetailsTab>}
    {tab === 'ledger' && <TransactionLedgerTab postings={props.postings} runningBalances={props.runningBalances} />}
    {tab === 'cost' && <TransactionCostAnalysisTab model={props.costAnalysis} />}
  </div>;
}
