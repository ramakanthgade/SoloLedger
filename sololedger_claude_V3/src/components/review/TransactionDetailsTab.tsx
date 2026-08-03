import type { ReactNode } from 'react';
import type { AccountScopeResolution } from '@/lib/ledger/derivedPostings';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';

export function TransactionDetailsTab({
  scope, coverage, authorityGeneration, children
}: {
  scope: AccountScopeResolution;
  coverage?: SourceCoverageRow;
  authorityGeneration?: number;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id="transaction-panel-details" aria-labelledby="transaction-tab-details" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_310px]">
      <section className="rounded-2xl border border-hi/10 bg-elev-1 p-4 sm:p-5"><header className="mb-4"><p className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-low">Transaction facts</p><h3 className="mt-1 text-base font-extrabold text-hi">Imported event details</h3><p className="mt-1 text-xs text-low">Persisted facts and evidence from the selected source row.</p></header>{children}</section>
      <aside className="space-y-3"><section className="rounded-2xl border border-hi/10 bg-elev-1 p-4"><p className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-low">Custody evidence</p><div className="mt-2 space-y-2"><Fact label="Custody scope" value={scope.accountScopeId} /><Fact label="Account class" value={scope.accountClass} /><Fact label="Source coverage" value={coverage ? `${coverage.status} · generation ${coverage.generation}` : 'No coverage evidence available'} /></div></section>
      <div className="rounded-xl border border-hi/10 bg-elev-3/40 px-3 py-3 text-xs leading-relaxed text-low">Authority generation: {authorityGeneration ?? 'not available'}. These are persisted custody and source-evidence facts; they do not certify tax correctness.</div></aside>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-hi/10 bg-elev-1 px-3 py-2"><p className="text-[10px] font-bold uppercase tracking-wide text-low">{label}</p><p className="mt-1 break-all text-xs font-semibold text-hi">{value}</p></div>;
}
