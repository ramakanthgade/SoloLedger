import { useState } from 'react';
import { useAuth } from '@/lib/saas/authContext';
import { startCheckout } from '@/lib/saas/api';
import {
  ENTERPRISE_BASE_PRICE_INR,
  ENTERPRISE_BASE_UNITS,
  ENTERPRISE_OVERAGE_PER_THOUSAND_INR,
  enterprisePriceInr,
  formatPlanLabel,
  formatUnitLimit
} from '@/lib/saas/plans';
import { PLAN_CATALOG, SELECTED_PLAN_KEY } from '@/lib/saas/planCatalog';
import { Button } from '@/components/ui/button';

const inr = (amount: number) => `₹${amount.toLocaleString('en-IN')}`;

/** Live Enterprise total line: base-only at 0 packs, full breakdown above. */
function enterpriseTotalLabel(extraPacks: number): string {
  const base = inr(ENTERPRISE_BASE_PRICE_INR);
  const baseUnits = ENTERPRISE_BASE_UNITS.toLocaleString('en-IN');
  if (extraPacks <= 0) return `Total: ${base}/year (${baseUnits} events included)`;
  const total = inr(enterprisePriceInr(ENTERPRISE_BASE_UNITS + extraPacks * 1_000));
  const packsCost = inr(extraPacks * ENTERPRISE_OVERAGE_PER_THOUSAND_INR);
  return `Total: ${total}/year (${base} for ${baseUnits} events + ${packsCost} for ${extraPacks} extra 1,000-event packs)`;
}

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
        {!user.subscriptionActive && (
          <p className="mt-2 text-sm text-warn">
            Renewal needed — pick a plan below to reactivate your subscription.
          </p>
        )}
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
              className={`flex items-center justify-between gap-4 px-6 py-4 ${highlight ? 'bg-violet/10' : ''}`}
            >
              <div className="min-w-0 flex-1">
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
                  <>
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
                    <p className="mt-1 text-xs text-low">{enterpriseTotalLabel(extraPacks)}</p>
                  </>
                )}
              </div>
              {!isCurrent && (
                <div className="shrink-0">
                  <Button
                    variant="secondary"
                    disabled={busy === p.id}
                    onClick={() => upgrade(p.id)}
                  >
                    {busy === p.id ? '…' : 'Select'}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {error && <p className="px-6 pb-4 text-sm text-loss">{error}</p>}
    </div>
  );
}
