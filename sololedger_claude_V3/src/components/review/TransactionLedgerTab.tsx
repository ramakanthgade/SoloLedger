import type { DerivedPosting } from '@/lib/ledger/derivedPostings';
import { formatCompactAmount } from '@/lib/utils';

function evidenceLabel(posting: DerivedPosting): string {
  return posting.evidence.map((evidence) => {
    if (evidence.kind === 'opening_balance') return `Opening ${evidence.provenance}`;
    if (evidence.kind === 'suppressed_twin') return `${evidence.source} twin ${evidence.sourceRef ?? evidence.transactionId}`;
    if (evidence.kind === 'deleted_source') return `${evidence.source} deleted-source evidence`;
    return `${evidence.source} ${evidence.sourceRef ?? evidence.transactionId}`;
  }).join(' · ');
}
const postingDescription: Record<DerivedPosting['role'], string> = { principal: 'Primary asset movement', counter: 'Counter-asset consideration', fee: 'Transaction fee withheld', opening_balance: 'Dated opening balance' };

export function TransactionLedgerTab({ postings, runningBalances }: {
  postings: readonly DerivedPosting[];
  runningBalances: ReadonlyMap<string, number>;
}) {
  return (
    <div role="tabpanel" id="transaction-panel-ledger" aria-labelledby="transaction-tab-ledger">
      <header className="mb-4"><p className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-low">Signed postings</p><h3 className="mt-1 text-base font-extrabold text-hi">Balance movements</h3><p className="mt-1 text-xs text-low">Custody movements created by this transaction, with source provenance and globally indexed balances.</p></header>
      <div className="overflow-x-auto rounded-xl border border-hi/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50" role="region" aria-label="Transaction custody postings table" tabIndex={0}>
        <table className="w-full min-w-[700px] text-xs">
          <thead className="bg-elev-3/60 text-left text-[10px] uppercase tracking-wide text-low"><tr><th className="px-3 py-2">Posting</th><th className="px-3 py-2">Ledger</th><th className="px-3 py-2">Evidence</th><th className="px-3 py-2 text-right">Signed change</th><th className="px-3 py-2 text-right">Running balance</th></tr></thead>
          <tbody>{postings.map((posting) => <tr key={posting.id} className="border-t border-hi/10">
            <td className="px-3 py-2 font-semibold text-hi">{postingDescription[posting.role]}<span className="block font-normal text-low">{new Date(posting.effectiveAt).toLocaleString()}</span></td>
            <td className="px-3 py-2">{posting.asset}<span className="block capitalize text-low">{posting.accountClass} · {posting.evidence[0] && 'source' in posting.evidence[0] ? posting.evidence[0].source : 'Opening evidence'}</span></td>
            <td className="max-w-[18rem] px-3 py-2 text-low">{evidenceLabel(posting) || 'No evidence reference'}</td>
            <td className={posting.signedQuantity >= 0 ? 'px-3 py-2 text-right font-bold text-gain' : 'px-3 py-2 text-right font-bold text-loss'}>{posting.signedQuantity >= 0 ? '+' : '−'}{formatCompactAmount(Math.abs(posting.signedQuantity))} {posting.asset}</td>
            <td className="px-3 py-2 text-right font-semibold tabular-figures text-hi">{formatCompactAmount(runningBalances.get(posting.id) ?? 0)} {posting.asset}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {postings.length === 0 && <p className="py-5 text-center text-xs text-low">No custody postings were derived for this transaction.</p>}
      <p className="mt-3 rounded-lg border border-primary/20 bg-primary/[0.05] px-3 py-2 text-xs leading-relaxed text-low">Signed postings explain custody only. Running balances use the globally ordered history; valuation illustrations and authority quantities are excluded.</p>
    </div>
  );
}
