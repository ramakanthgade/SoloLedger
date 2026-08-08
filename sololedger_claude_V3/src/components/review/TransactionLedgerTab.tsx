import type { DerivedPosting } from '@/lib/ledger/derivedPostings';
import { formatCompactAmount } from '@/lib/utils';

const postingDescription: Record<DerivedPosting['role'], string> = { principal: 'Primary asset movement', counter: 'Counter-asset consideration', liability: 'Loan liability movement', fee: 'Transaction fee withheld', opening_balance: 'Dated opening balance' };

function ledgerLabel(posting: DerivedPosting): string {
  const labels: Record<DerivedPosting['accountClass'], string> = {
    wallet: 'Wallet', spot: 'Exchange', funding: 'Funding account', futures: 'Futures account',
    margin: 'Margin account', options: 'Options account', manual: 'Manual entry', unknown: 'Other account'
  };
  return labels[posting.accountClass];
}

function signedChange(posting: DerivedPosting): string {
  return `${posting.signedQuantity >= 0 ? '+' : '−'}${formatCompactAmount(Math.abs(posting.signedQuantity))} ${posting.asset}`;
}

export function TransactionLedgerTab({ postings, runningBalances }: {
  postings: readonly DerivedPosting[];
  runningBalances: ReadonlyMap<string, number>;
}) {
  return (
    <div role="tabpanel" id="transaction-panel-ledger" aria-labelledby="transaction-tab-ledger" className="min-w-0 max-w-full">
      <header className="mb-4"><p className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-low">Ledger</p><h3 className="mt-1 text-base font-extrabold text-hi">Balance changes</h3><p className="mt-1 text-xs text-low">How this transaction changed each asset balance.</p></header>
      <div className="min-w-0 max-w-full sm:hidden" role="region" aria-label="Transaction custody postings">
        <ul className="grid min-w-0 gap-3" data-testid="ledger-mobile-postings">
          {postings.map((posting) => {
            return <li key={posting.id} className="min-w-0 rounded-xl border border-hi/10 bg-elev-1 p-3" data-testid="ledger-mobile-posting">
              <article className="min-w-0" aria-label={postingDescription[posting.role]}>
                <dl className="grid min-w-0 gap-3 text-xs">
                  <div className="min-w-0">
                    <dt className="text-[10px] font-extrabold uppercase tracking-wide text-low" data-testid="ledger-mobile-label">Posting</dt>
                    <dd className="mt-1 min-w-0 font-semibold text-hi">{postingDescription[posting.role]}<span className="block break-words font-normal text-low">{new Date(posting.effectiveAt).toLocaleString()}</span></dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[10px] font-extrabold uppercase tracking-wide text-low" data-testid="ledger-mobile-label">Asset / ledger</dt>
                    <dd className="mt-1 min-w-0 font-semibold text-hi">{posting.asset}<span className="block break-words font-normal text-low">{ledgerLabel(posting)}</span></dd>
                  </div>
                  <div className="grid min-w-0 grid-cols-2 gap-3 border-t border-hi/10 pt-3">
                    <div className="min-w-0">
                      <dt className="text-[10px] font-extrabold uppercase tracking-wide text-low" data-testid="ledger-mobile-label">Signed change</dt>
                      <dd className={posting.signedQuantity >= 0 ? 'mt-1 min-w-0 break-words font-bold text-gain' : 'mt-1 min-w-0 break-words font-bold text-loss'}>{signedChange(posting)}</dd>
                    </div>
                    <div className="min-w-0 text-right">
                      <dt className="text-[10px] font-extrabold uppercase tracking-wide text-low" data-testid="ledger-mobile-label">Running balance</dt>
                      <dd className="mt-1 min-w-0 break-words font-semibold tabular-figures text-hi">{formatCompactAmount(runningBalances.get(posting.id) ?? 0)} {posting.asset}</dd>
                    </div>
                  </div>
                </dl>
              </article>
            </li>;
          })}
        </ul>
      </div>
      <div className="hidden max-w-full overflow-x-auto rounded-xl border border-hi/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:block" role="region" aria-label="Transaction custody postings table" tabIndex={0}>
        <table className="w-full min-w-[600px] text-xs">
          <thead className="bg-elev-3/60 text-left text-[10px] uppercase tracking-wide text-low"><tr><th className="px-3 py-2">Posting</th><th className="px-3 py-2">Asset / ledger</th><th className="px-3 py-2 text-right">Signed change</th><th className="px-3 py-2 text-right">Running balance</th></tr></thead>
          <tbody>{postings.map((posting) => <tr key={posting.id} className="border-t border-hi/10">
            <td className="px-3 py-2 font-semibold text-hi">{postingDescription[posting.role]}<span className="block font-normal text-low">{new Date(posting.effectiveAt).toLocaleString()}</span></td>
            <td className="px-3 py-2">{posting.asset}<span className="block text-low">{ledgerLabel(posting)}</span></td>
            <td className={posting.signedQuantity >= 0 ? 'px-3 py-2 text-right font-bold text-gain' : 'px-3 py-2 text-right font-bold text-loss'}>{signedChange(posting)}</td>
            <td className="px-3 py-2 text-right font-semibold tabular-figures text-hi">{formatCompactAmount(runningBalances.get(posting.id) ?? 0)} {posting.asset}</td>
          </tr>)}</tbody>
        </table>
      </div>
      {postings.length === 0 && <p className="py-5 text-center text-xs text-low">No custody postings were derived for this transaction.</p>}
    </div>
  );
}
