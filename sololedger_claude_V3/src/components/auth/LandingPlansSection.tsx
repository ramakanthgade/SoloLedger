import { useState } from 'react';
import { cn } from '@/lib/utils';
import { PLAN_CATALOG, SELECTED_PLAN_KEY, type PlanId } from '@/lib/saas/planCatalog';

type LandingPlansSectionProps = {
  onSelectPlan: (planId: PlanId) => void;
};

export function LandingPlansSection({ onSelectPlan }: LandingPlansSectionProps) {
  const [hovered, setHovered] = useState<PlanId | null>(null);

  return (
    <section className="relative py-20">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-violet/10 to-transparent" />
      <div className="relative mx-auto max-w-6xl px-6 lg:px-8">
        <div className="text-center">
          <span className="inline-flex rounded-full bg-violet/15 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-blue">
            Simple yearly pricing
          </span>
          <h2 className="mt-5 font-display text-4xl font-bold text-hi sm:text-5xl">
            Pick a plan. Start free.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-lg text-mid">
            Start free with up to 100 taxable disposals + income events. Upgrade when you need more volume.
          </p>
        </div>

        <div className="mx-auto mt-8 max-w-3xl rounded-2xl border border-violet/20 bg-elev-2/70 p-5 text-center shadow-card">
          <p className="text-sm leading-relaxed text-mid">
            <strong className="text-hi">Up to ~25× cheaper per underlying transaction.</strong>{' '}
            Other exchanges bill every raw transaction; we only count your{' '}
            <strong className="text-hi">taxable disposals + income events</strong>. A 20,000-line
            trade history is often a few hundred taxable events — so you pay for what you file, not
            every line. (Actual saving varies with your trading style — typically ~1.5–4 raw
            transactions per disposal.)
          </p>
        </div>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
                  'group relative flex flex-col rounded-2xl border bg-elev-2 p-5 text-left shadow-card transition duration-300',
                  p.featured
                    ? 'stat-card-featured border-violet/40 lg:-translate-y-2'
                    : 'border-white/10 hover:-translate-y-1 hover:border-violet/40',
                  active && 'shadow-glow'
                )}
              >
                {p.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-gain px-3 py-0.5 text-[10px] font-bold uppercase text-[#0A0B1A]">
                    Popular
                  </span>
                )}
                <div
                  className={cn(
                    'mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br text-[#0A0B1A] shadow-soft',
                    p.accent
                  )}
                >
                  <Icon className="h-6 w-6" />
                </div>
                <span className="text-lg font-bold text-hi">{p.name}</span>
                <span className="mt-1 font-display text-3xl font-bold text-gain">
                  {p.price}
                  <span className="text-sm font-normal text-faint">{p.period}</span>
                </span>
                <span className="mt-2 text-sm font-semibold text-blue">{p.limit}</span>
                <span className="mt-1 text-xs text-low">{p.tagline}</span>
                <span className="mt-4 text-sm font-semibold text-hi group-hover:text-blue">
                  {p.contactOnly ? 'Contact us →' : p.id === 'local' ? 'Start free →' : 'Get started →'}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
