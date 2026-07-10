import { useState } from 'react';
import { cn } from '@/lib/utils';
import { PLAN_CATALOG, SELECTED_PLAN_KEY, type PaidPlanId } from '@/lib/saas/planCatalog';

type LandingPlansSectionProps = {
  onSelectPlan: (planId: PaidPlanId) => void;
};

export function LandingPlansSection({ onSelectPlan }: LandingPlansSectionProps) {
  const [hovered, setHovered] = useState<PaidPlanId | null>(null);

  return (
    <section className="relative py-20">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-teal-50/60 to-transparent" />
      <div className="relative mx-auto max-w-6xl px-6 lg:px-8">
        <div className="text-center">
          <span className="inline-flex rounded-full bg-navy px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-teal-200">
            Simple yearly pricing
          </span>
          <h2 className="mt-5 font-display text-4xl font-bold text-navy sm:text-5xl">
            Pick a plan. Start free.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-lg text-slate-600">
            Start free with up to 100 transactions. Upgrade when you need more volume.
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {PLAN_CATALOG.map((p) => {
            const Icon = p.icon;
            const active = hovered === p.id || p.featured;
            return (
              <button
                key={p.id}
                type="button"
                onMouseEnter={() => setHovered(p.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => {
                  sessionStorage.setItem(SELECTED_PLAN_KEY, p.id);
                  onSelectPlan(p.id);
                }}
                className={cn(
                  'group relative flex flex-col rounded-2xl border bg-white p-5 text-left shadow-lg transition duration-300',
                  p.featured
                    ? 'border-emerald-300 ring-2 ring-emerald-400/40 lg:-translate-y-2'
                    : 'border-slate-200 hover:-translate-y-1 hover:border-teal-300',
                  active && 'shadow-xl shadow-teal-900/10'
                )}
              >
                {p.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-emerald-500 px-3 py-0.5 text-[10px] font-bold uppercase text-white">
                    Popular
                  </span>
                )}
                <div
                  className={cn(
                    'mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md',
                    p.accent
                  )}
                >
                  <Icon className="h-6 w-6" />
                </div>
                <span className="text-lg font-bold text-navy">{p.name}</span>
                <span className="mt-1 font-display text-3xl font-bold text-emerald-700">
                  {p.price}
                  <span className="text-sm font-normal text-slate-400">{p.period}</span>
                </span>
                <span className="mt-2 text-sm font-semibold text-teal-700">{p.limit}</span>
                <span className="mt-1 text-xs text-slate-500">{p.tagline}</span>
                <span className="mt-4 text-sm font-semibold text-navy group-hover:text-teal-700">
                  {p.contactOnly ? 'Contact us →' : p.id === 'starter' ? 'Start free →' : 'Get started →'}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
