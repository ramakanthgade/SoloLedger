import { cn } from '@/lib/utils';
import { PLAN_CATALOG, SELECTED_PLAN_KEY, type PlanId } from '@/lib/saas/planCatalog';

type LandingPlansSectionProps = {
  onSelectPlan: (planId: PlanId) => void;
};

export function LandingPlansSection({ onSelectPlan }: LandingPlansSectionProps) {
  return (
    <section className="py-20">
      <div className="mx-auto max-w-6xl px-6 lg:px-8">
        <div className="text-center">
          <span className="inline-flex rounded-full border border-primary/20 bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-widest text-primary">
            Simple yearly pricing
          </span>
          <h2 className="mt-5 font-display text-4xl font-extrabold tracking-tight text-hi sm:text-5xl">
            Pick a plan. Start free.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-lg text-mid">
            Start free with up to 100 taxable disposals + income events. Upgrade when you need more volume.
          </p>
        </div>

        <div className="mx-auto mt-8 max-w-3xl rounded-[20px] border border-hi/10 bg-elev-2 p-5 text-center shadow-card">
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
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  sessionStorage.setItem(SELECTED_PLAN_KEY, p.id);
                  onSelectPlan(p.id);
                }}
                className={cn(
                  'group relative flex flex-col rounded-[20px] border bg-elev-2 p-6 text-left shadow-card transition duration-300',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                  p.featured
                    ? 'stat-card-featured border-primary/40 lg:-translate-y-2'
                    : 'border-hi/10 hover:-translate-y-1 hover:border-primary/30 hover:shadow-card-hover'
                )}
              >
                {p.featured && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-gain px-3 py-0.5 text-[10px] font-bold uppercase tracking-wide text-on-aurora">
                    Popular
                  </span>
                )}
                <div
                  className={cn(
                    'mb-4 inline-flex h-12 w-12 items-center justify-center rounded-[13px] bg-gradient-to-br text-on-aurora shadow-xs',
                    p.accent
                  )}
                >
                  <Icon className="h-6 w-6" />
                </div>
                <span className="text-lg font-bold text-hi">{p.name}</span>
                <span className="mt-1 font-display text-3xl font-extrabold tracking-tight text-hi">
                  {p.price}
                  <span className="text-sm font-normal text-faint">{p.period}</span>
                </span>
                <span className="mt-2 text-sm font-semibold text-primary">{p.limit}</span>
                <span className="mt-1 text-xs leading-relaxed text-low">{p.tagline}</span>
                <span className="mt-4 text-sm font-semibold text-hi group-hover:text-primary">
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
