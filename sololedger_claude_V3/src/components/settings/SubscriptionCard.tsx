import { useState } from 'react';
import { useAuth } from '@/lib/saas/authContext';
import { startCheckout } from '@/lib/saas/api';
import { formatPlanLabel, formatTxLimit } from '@/lib/saas/plans';
import { PLAN_CATALOG, SELECTED_PLAN_KEY } from '@/lib/saas/planCatalog';

export function SubscriptionCard() {
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!user || user.role === 'admin') return null;

  const selectedFromLanding =
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SELECTED_PLAN_KEY) : null;

  const upgrade = async (plan: string) => {
    if (plan === 'enterprise') {
      setError('Enterprise plans — contact support for unlimited volume pricing.');
      return;
    }
    setBusy(plan);
    setError(null);
    try {
      const url = await startCheckout(plan);
      if (url) {
        sessionStorage.removeItem(SELECTED_PLAN_KEY);
        window.location.href = url;
      } else setError('Checkout is not configured yet — contact support.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-2xl border border-teal-200 bg-white shadow-sm">
      <div className="border-b border-teal-100 px-6 py-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">Subscription</p>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h3 className="font-display text-2xl font-bold capitalize text-navy">
              {formatPlanLabel(user.plan)}
            </h3>
            <p className="mt-1 text-sm text-mist-400">
              {formatTxLimit(user.txLimit)} transactions per year
              {!user.subscriptionActive && ' · renewal needed'}
            </p>
          </div>
          {user.plan === 'trial' && (
            <span className="rounded-full bg-teal-100 px-3 py-1 text-xs font-semibold text-teal-800">
              14-day trial
            </span>
          )}
        </div>
        {selectedFromLanding && selectedFromLanding !== user.plan && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            You selected <strong>{formatPlanLabel(selectedFromLanding)}</strong> on the landing page — choose it
            below to upgrade.
          </p>
        )}
      </div>

      <div className="divide-y divide-slate-100">
        {PLAN_CATALOG.map((p) => {
          const isCurrent = user.plan === p.id;
          const highlight = selectedFromLanding === p.id;
          return (
            <div
              key={p.id}
              className={`flex flex-wrap items-center justify-between gap-3 px-6 py-4 ${highlight ? 'bg-teal-50/60' : ''}`}
            >
              <div>
                <p className="font-semibold text-navy">
                  {p.name}
                  {p.featured && (
                    <span className="ml-2 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-800">
                      Popular
                    </span>
                  )}
                  {isCurrent && (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-600">
                      Current
                    </span>
                  )}
                </p>
                <p className="text-sm text-mist-400">
                  {p.price}
                  {p.period} · {p.limit} · {p.tagline}
                </p>
              </div>
              {!isCurrent && (
                <button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => upgrade(p.id)}
                  className="rounded-lg border border-teal-300 bg-white px-4 py-2 text-sm font-semibold text-teal-800 transition hover:bg-teal-50 disabled:opacity-50"
                >
                  {busy === p.id ? '…' : p.contactOnly ? 'Contact' : 'Select'}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="px-6 pb-4 text-sm text-loss">{error}</p>}
    </div>
  );
}
