import type { ReactNode } from 'react';
import type { AccountScopeResolution } from '@/lib/ledger/derivedPostings';
import type { SourceCoverageRow } from '@/lib/reconcile/sourceCoverage';
import type { SourcePresentation } from '@/lib/sources/sourcePresentation';
import type { TaxPolicyResolution } from '@/lib/taxonomy/taxPolicy';
import type { Transaction } from '@/types/transaction';

export function TransactionDetailsTab({
  scope, coverage, authorityGeneration, transaction, presentation, taxPolicy, children
}: {
  scope: AccountScopeResolution;
  coverage?: SourceCoverageRow;
  authorityGeneration?: number;
  transaction?: Transaction;
  presentation?: SourcePresentation;
  taxPolicy?: TaxPolicyResolution;
  children: ReactNode;
}) {
  return (
    <div role="tabpanel" id="transaction-panel-details" aria-labelledby="transaction-tab-details" className="grid min-w-0 max-w-full gap-4 lg:grid-cols-[minmax(0,1fr)_310px]">
      <section className="min-w-0 rounded-2xl border border-hi/10 bg-elev-1 p-4 sm:p-5"><header className="mb-4 min-w-0"><p className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-low">Transaction facts</p><h3 className="mt-1 text-base font-extrabold text-hi">Imported event details</h3><p className="mt-1 text-xs text-low">Persisted facts and evidence from the selected source row.</p></header>{children}</section>
      <aside className="min-w-0 space-y-3">
        <section className="rounded-2xl border border-hi/10 bg-elev-1 p-4">
          <p className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-low">Persisted source and account evidence</p>
          <div className="mt-2 space-y-2">
            <Fact label="Source identity" value={presentation?.sourceKey ?? 'No exact source identity available'} />
            <Fact label="Account identity" value={presentation?.accountKey ?? 'No exact account identity available'} />
            <Fact label="Resolution" value={presentation ? `${presentation.status} · ${presentation.primaryLabel}` : 'Unavailable'} />
            <Fact label="Original event reference" value={transaction?.txHash ?? transaction?.sourceRef ?? 'Not recorded'} />
            <Fact label="Ownership evidence" value={presentation?.account ? `${presentation.account.ownershipStatus} · revision ${presentation.account.lifecycleRevision}` : 'No durable account decision'} />
            {presentation?.linkedDeletedSourceEvidence && <>
              <Fact
                label="Linked deleted API provenance"
                value={`${presentation.linkedDeletedSourceEvidence.source} · ${presentation.linkedDeletedSourceEvidence.sourceIdentityId} · ${presentation.linkedDeletedSourceEvidence.apiIdentity}`}
              />
              <Fact
                label="Linked deleted API status"
                value={`deleted · ${new Date(presentation.linkedDeletedSourceEvidence.deletedAt).toISOString()}`}
              />
            </>}
          </div>
        </section>
        <section className="rounded-2xl border border-hi/10 bg-elev-1 p-4">
          <p className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-low">Derived interpretations</p>
          <p className="mt-1 text-[11px] leading-relaxed text-low">These values are projections or policy outcomes. They do not rewrite the persisted source event.</p>
          <div className="mt-2 space-y-2">
            <Fact label="Custody projection" value={`${scope.scopeStatus} · ${scope.accountScopeId} · ${scope.accountClass}`} />
            <Fact label="Safety" value={transaction?.safetyState ?? (transaction?.isSpam ? 'user hidden' : 'No derived safety decision')} />
            <Fact label="Pairing" value={transaction?.internalTransferDecision ? `${transaction.internalTransferDecision} · ${transaction.internalTransferMatchMethod ?? 'method not recorded'}` : 'No derived pair decision'} />
            <Fact label="Tax policy" value={taxPolicy
              ? `${taxPolicy.treatment.replace(/_/g, ' ')} · ${taxPolicy.explanation} · ${taxPolicy.reasonCode} · ${taxPolicy.policyVersion}`
              : 'Policy outcome unavailable'} />
          </div>
        </section>
        <div className="rounded-xl border border-hi/10 bg-elev-3/40 px-3 py-3 text-xs leading-relaxed text-low">
          Source coverage: {coverage ? `${coverage.status} · generation ${coverage.generation}` : 'not available'}. Authority generation: {authorityGeneration ?? 'not available'}. Tax treatment comes from the shared report-time policy resolver.
        </div>
      </aside>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-hi/10 bg-elev-1 px-3 py-2"><p className="text-[10px] font-bold uppercase tracking-wide text-low">{label}</p><p className="mt-1 break-all text-xs font-semibold text-hi">{value}</p></div>;
}
