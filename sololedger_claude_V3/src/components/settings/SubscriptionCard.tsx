import { useState } from 'react';
import { useAuth } from '@/lib/saas/authContext';
import { startCheckout } from '@/lib/saas/api';
import { formatPlanLabel, formatTxLimit } from '@/lib/saas/plans';
import { Sparkles, Zap, Crown, Building2, Rocket } from 'lucide-react';
import { cn } from '@/lib/utils';

type PlanCard = {
  id: 'starter' | 'standard' | 'pro' | 'small_business' | 'enterprise';
  name: string;
  price: string;
  period: string;
  limit: string;
  icon: typeof Zap;
  accent: string;
  featured?: boolean;
  contactOnly?: boolean;
};

const PLANS: PlanCard[] = [
  {
    id: 'starter',
    name: 'Starter',
    price: '$50',
    period: '/year',
    limit: '100 transactions',
    icon: Zap,
    accent: 'from-teal-500 to-emerald-600'
  },
  {
    id: 'standard',
    name: 'Standard',
    price: '$100',
    period: '/year',
    limit: '500 transactions',
    icon: Sparkles,
    accent: 'from-emerald-500 to-teal-600',
    featured: true
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$500',
    period: '/year',
    limit: '1,000 transactions',
    icon: Crown,
    accent: 'from-navy to-teal-700'
  },
  {
    id: 'small_business',
    name: 'Small business',
    price: '$1,500',
    period: '/year',
    limit: '5,000 transactions',
    icon: Building2,
    accent: 'from-violet-600 to-teal-600'
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 'Contact',
    period: ' us',
    limit: 'Unlimited transactions',
    icon: Rocket,
    accent: 'from-amber-500 to-orange-600',
    contactOnly: true
  }
];

export function SubscriptionCard() {
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!user || user.role === 'admin') return null;

  const upgrade = async (plan: string) => {
    if (plan === 'enterprise') {
      setError('Enterprise plans — contact support for unlimited volume pricing.');
      return;
    }
    setBusy(plan);
    setError(null);
    try {
      const url = await startCheckout(plan);
      if (url) window.location.href = url;
      else setError('Checkout is not configured yet — contact support.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-teal-200 bg-gradient-to-br from-teal-50 via-white to-emerald-50 shadow-md">
      <div className="border-b border-teal-100 bg-gradient-to-r from-navy via-teal-900 to-emerald-800 px-6 py-6 text-white">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-100">Your subscription</p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="font-display text-3xl font-bold capitalize">{formatPlanLabel(user.plan)}</h3>
            <p className="mt-2 text-base text-teal-50">
              Up to{' '}
              <strong className="text-2xl text-white">{formatTxLimit(user.txLimit)}</strong>{' '}
              <span className="text-teal-100">transactions per year</span>
            </p>
          </div>
          {!user.subscriptionActive && (
            <span className="rounded-full bg-amber-400 px-4 py-1.5 text-sm font-bold text-navy shadow">
              Renew to continue
            </span>
          )}
        </div>
        {user.plan === 'trial' && (
          <p className="mt-4 rounded-xl bg-white/10 px-4 py-3 text-sm text-teal-50">
            14-day trial — wallet lookup & live pricing included. No API keys to configure.
          </p>
        )}
      </div>

      <div className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {PLANS.map((p) => {
          const Icon = p.icon;
          return (
            <button
              key={p.id}
              type="button"
              disabled={busy === p.id}
              onClick={() => upgrade(p.id)}
              className={cn(
                'group relative flex flex-col rounded-xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg',
                p.featured ? 'border-emerald-300 ring-2 ring-emerald-300/50' : 'border-slate-200',
                busy === p.id && 'opacity-60'
              )}
            >
              {p.featured && (
                <span className="absolute -top-2.5 left-4 rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
                  Popular
                </span>
              )}
              <div className={cn('mb-3 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br text-white', p.accent)}>
                <Icon className="h-5 w-5" />
              </div>
              <span className="text-lg font-bold text-navy">{p.name}</span>
              <span className="mt-1 font-display text-2xl font-bold text-emerald-700">
                {p.price}
                <span className="text-sm font-normal text-mist-400">{p.period}</span>
              </span>
              <span className="mt-2 text-sm text-mist-400">{p.limit}</span>
              <span className="mt-4 text-sm font-semibold text-teal-700 group-hover:underline">
                {p.contactOnly ? 'Contact us →' : 'Upgrade →'}
              </span>
            </button>
          );
        })}
      </div>
      {error && <p className="px-6 pb-4 text-sm text-loss">{error}</p>}
    </div>
  );
}
