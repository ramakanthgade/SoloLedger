import { useState } from 'react';
import { useAuth } from '@/lib/saas/authContext';
import { startCheckout } from '@/lib/saas/api';
import { formatPlanLabel, formatUnitLimit } from '@/lib/saas/plans';
import { PLAN_CATALOG, SELECTED_PLAN_KEY } from '@/lib/saas/planCatalog';
import { Button } from '@/components/ui/button';

export function SubscriptionCard() {
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Enterprise only: N prepaid 1,000-event packs above the 10,000 base.
  const [extraPacks, setExtraPacks] = useState(0);

  if (!user || user.role === 'admin') return null;

  const selectedFromLanding =
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(SELECTED_PLAN_KEY) : null;

  const upgrade = async (plan: string) => {
    if (plan === 'local') {
      setError('Local is free forever — up to 100 taxable disposals + income events per tax year.');
      return;
    }
    setBusy(plan);
    setError(null);
    try {
      const url = await startCheckout(plan, plan === 'enterprise' ? extraPacks : 0);
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
    <div className="rounded-2xl border border-white/10 bg-elev-2 shadow-card">
      <div className="border-b border-white/5 px-6 py-5">
        <p className="font-mono text-xs font-semibold uppercase tracking-wider text-violet">Subscription</p>
        <div className="mt-2 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <h3 className="font-display text-2xl font-bold capitalize text-hi">
              {formatPlanLabel(user.plan)}
            </h3>
            <p className="mt-1 text-sm text-low">
              {formatUnitLimit(user.includedUnits)} taxable disposals + income events per tax year
              {!user.subscriptionActive && ' · renewal needed'}
            </p>
          </div>
          {user.plan === 'local' && (
            <span className="rounded-full bg-violet/15 px-3 py-1 text-xs font-semibold text-violet">
              Free tier
            </span>
          )}
        </div>
        {selectedFromLanding && selectedFromLanding !== user.plan && (
          <p className="mt-3 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-warn">
            You selected <strong>{formatPlanLabel(selectedFromLanding)}</strong> on the landing page — choose it
            below to upgrade.
          </p>
        )}
      </div>

      <div className="divide-y divide-white/5">
        {PLAN_CATALOG.map((p) => {
          const isCurrent = user.plan === p.id;
          const highlight = selectedFromLanding === p.id;
          return (
            <div
              key={p.id}
              className={`flex flex-wrap items-center justify-between gap-3 px-6 py-4 ${highlight ? 'bg-violet/10' : ''}`}
            >
              <div>
                <p className="font-semibold text-hi">
                  {p.name}
                  {p.featured && (
                    <span className="ml-2 rounded bg-gain/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-gain">
                      Popular
                    </span>
                  )}
                  {isCurrent && (
                    <span className="ml-2 rounded bg-elev-3 px-1.5 py-0.5 text-[10px] font-bold uppercase text-mid">
                      Current
                    </span>
                  )}
                </p>
                <p className="text-sm text-low">
                  {p.price}
                  {p.period} · {p.limit} · {p.tagline}
                </p>
                {p.id === 'enterprise' && (
                  <label className="mt-2 flex items-center gap-2 text-xs text-low">
                    Extra 1,000-event packs
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={extraPacks}
                      aria-label="Enterprise extra 1,000-event packs"
                      onChange={(e) => setExtraPacks(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                      className="h-8 w-20 rounded-lg border border-white/10 bg-elev-3 px-2 text-right font-mono text-sm text-hi"
                    />
                    <span className="text-low">
                      → {formatUnitLimit(10_000 + extraPacks * 1_000)} events
                    </span>
                  </label>
                )}
              </div>
              {!isCurrent && (
                <Button
                  variant="secondary"
                  disabled={busy === p.id}
                  onClick={() => upgrade(p.id)}
                >
                  {busy === p.id ? '…' : p.contactOnly ? 'Contact' : 'Select'}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="px-6 pb-4 text-sm text-loss">{error}</p>}
    </div>
  );
}
