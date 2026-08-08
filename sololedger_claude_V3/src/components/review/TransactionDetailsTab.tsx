import type { ReactNode } from 'react';

export function TransactionDetailsTab({ children }: { children: ReactNode }) {
  return (
    <div role="tabpanel" id="transaction-panel-details" aria-labelledby="transaction-tab-details" className="min-w-0 max-w-full">
      <section className="min-w-0 rounded-2xl border border-hi/10 bg-elev-1 p-4 sm:p-5"><header className="mb-4 min-w-0"><p className="text-[10px] font-extrabold uppercase tracking-[0.08em] text-low">Transaction details</p><h3 className="mt-1 text-base font-extrabold text-hi">Imported event</h3><p className="mt-1 text-xs text-low">The useful facts recorded for this transaction.</p></header>{children}</section>
    </div>
  );
}
