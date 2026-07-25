import { useEffect, useState, type ReactNode } from 'react';
import {
  ShieldCheck,
  Clock,
  IndianRupee,
  Percent,
  Upload,
  ListChecks,
  TrendingUp,
  ChevronRight,
  Lock
} from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { SwitchModeButton } from '@/components/SwitchModeButton';
import { BrandIcon, brandLabel } from '@/components/connections/brandIcons';
import { getSettings, saveSettings } from '@/lib/storage/db';
import { cn } from '@/lib/utils';

interface OnboardingProps {
  /** Called when the user finishes onboarding and wants to import. */
  onStartImport: () => void;
  /**
   * Called when the user skips the guided setup and wants to go straight to the
   * Import screen (e.g. to use Wallet Lookup instead of an exchange CSV).
   */
  onSkip?: () => void;
}

/**
 * Popular first-connection sources, mirroring the approved onboarding mockup
 * (flows-reports.html §Onboarding, step 2 logo grid). Real brand logos only —
 * locked decision 25 Jul — rendered through the shared BrandIcon registry so
 * tile contrast (brand-color tiles, white light-chips, hairline strokes) is
 * correct in both themes. Presentational here: the actual source pick happens
 * inside the ConnectionWizard this screen hands off to.
 */
const POPULAR_SOURCES: { id: string; kind: string }[] = [
  { id: 'binance', kind: 'Exchange' },
  { id: 'coindcx', kind: 'Exchange' },
  { id: 'wazirx', kind: 'Exchange' },
  { id: 'metamask', kind: 'Wallet' },
  { id: 'trustwallet', kind: 'Wallet' },
  { id: 'ledger', kind: 'Hardware' }
];

/**
 * First-run onboarding (Task T3).
 *
 * India-LOCKED: we deliberately DROP the mockup's country/currency picker
 * (`aurora-onboarding.html` Step 1) since Phase 1 is India-only. Instead we
 * silently persist the India defaults (jurisdiction IN, reporting currency INR)
 * and show a brief India setup confirmation, then a welcome step that hands off
 * to the guided ConnectionWizard.
 *
 * Ember & Slate restyle: the approved flows-reports onboarding anatomy —
 * brand header with the canonical tagline, a segmented step-progress rail,
 * left-aligned headlines (aurora-gradient accent on the welcome hero), a
 * real-logo source grid, privacy reassurance copy, and one clear primary CTA
 * per step with a ghost back/skip.
 */
export function Onboarding({ onStartImport, onSkip }: OnboardingProps) {
  const [step, setStep] = useState<0 | 1>(0);

  // Silently lock in India + INR via the existing settings persistence. This
  // preserves any other settings already present and is safe to run on mount.
  useEffect(() => {
    void (async () => {
      const settings = await getSettings();
      if (settings.jurisdiction !== 'IN' || settings.reportingCurrency !== 'INR') {
        await saveSettings({ ...settings, jurisdiction: 'IN', reportingCurrency: 'INR' });
      }
    })();
  }, []);

  const skipLink = onSkip && (
    <button
      type="button"
      onClick={onSkip}
      className="inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-center text-xs font-medium text-low transition-colors hover:text-mid focus:outline-none focus-visible:underline"
    >
      Skip setup — go straight to Import
    </button>
  );

  return (
    <div className="min-h-screen bg-canvas px-6 py-8 sm:py-10 lg:px-8">
      <div className="mx-auto max-w-2xl">
        <header className="flex items-center justify-between gap-4">
          <BrandLogo variant="on-glass" />
          <SwitchModeButton />
        </header>

        <main className="mt-10">
          {/* Segmented progress rail (mockup `.wiz` step indicator): completed
              segments in gain, the current segment in primary, pending in
              elev-3. */}
          <div className="flex items-center gap-3.5">
            <span className="whitespace-nowrap font-mono text-[11px] font-medium uppercase tracking-[0.18em] text-low">
              Step {step + 1} of 2 · {step === 0 ? 'Your setup' : "You're all set"}
            </span>
            <div
              className="flex flex-1 gap-1.5"
              role="group"
              aria-label={`Progress: step ${step + 1} of 2`}
            >
              {[0, 1].map((i) => (
                <span
                  key={i}
                  aria-current={i === step ? 'step' : undefined}
                  className={cn(
                    'h-[5px] flex-1 rounded-full',
                    i < step ? 'bg-gain' : i === step ? 'bg-primary' : 'bg-elev-3'
                  )}
                />
              ))}
            </div>
          </div>

          {step === 0 ? (
            <>
              <h1 className="mt-6 text-[28px] font-extrabold tracking-tight text-hi sm:text-[32px]">
                Set up for India
              </h1>
              <p className="mt-2 text-[15px] leading-relaxed text-mid">
                SoloLedger is tuned for Indian crypto tax — Financial Year Apr–Mar, in ₹. You can
                fine-tune everything later in Settings.
              </p>

              <div className="mt-6 space-y-4">
                <section className="rounded-2xl border border-hi/10 bg-elev-2 px-5 py-2 shadow-card">
                  <ConfigRow
                    icon={<Clock className="h-4 w-4 text-accent" />}
                    label="Reporting period"
                    value="Financial Year (Apr–Mar)"
                  />
                  <ConfigRow
                    icon={<IndianRupee className="h-4 w-4 text-accent" />}
                    label="Currency"
                    value="₹ INR · lakh / crore"
                  />
                  <ConfigRow
                    icon={<Percent className="h-4 w-4 text-accent" />}
                    label="Crypto tax rule"
                    value="Flat 30% + 4% cess · 1% TDS"
                    last
                  />
                </section>

                <div className="flex items-start gap-3 rounded-xl border border-gain/25 bg-gain/[0.07] px-4 py-3.5">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gain/15 text-gain">
                    <ShieldCheck className="h-4 w-4" />
                  </span>
                  <div>
                    <h2 className="text-xs font-bold text-hi">No account needed</h2>
                    <p className="mt-0.5 text-xs text-mid">
                      Everything runs on this device. Nothing has left it — and a badge tells you
                      the moment anything does.
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex flex-col gap-2">
                <Button className="w-full" onClick={() => setStep(1)}>
                  Continue <ChevronRight className="h-4 w-4" />
                </Button>
                {skipLink}
              </div>
            </>
          ) : (
            <>
              <h1 className="mt-6 text-[28px] font-extrabold tracking-tight text-hi sm:text-[32px]">
                Welcome to{' '}
                <span className="bg-aurora bg-clip-text text-transparent">SoloLedger</span>
              </h1>
              <p className="mt-2 text-[15px] leading-relaxed text-mid">
                Set up for India — Financial Year Apr–Mar, in ₹. Here's the quickest path from
                messy trades to a number you can file.
              </p>

              <div className="mt-6 space-y-3">
                <NextStep
                  icon={<Upload className="h-4 w-4" />}
                  title="1 · Import your trades"
                  body="Drop in a CSV from CoinDCX, WazirX, ZebPay, Binance and more — we'll guide you export-to-import."
                />
                <NextStep
                  icon={<ListChecks className="h-4 w-4" />}
                  title="2 · Review what we read"
                  body="We match transfers and fill in prices. You confirm anything flagged — it stays honest."
                />
                <NextStep
                  icon={<TrendingUp className="h-4 w-4" />}
                  title="3 · Know what you owe"
                  body="See your 30% liability, your 1% TDS credit, and a Schedule VDA report ready to file."
                />

                {/* Source grid — real brand logos (never letter chips), the
                    same six sources the approved mockup shows. */}
                <section className="overflow-hidden rounded-2xl border border-hi/10 bg-elev-2 shadow-card">
                  <div className="border-b border-hi/5 px-5 py-4">
                    <h2 className="text-sm font-bold text-hi">
                      Bring history from the apps you already use
                    </h2>
                    <p className="mt-1 text-xs text-low">
                      Exchanges, wallets and hardware — read-only, and parsed on this device.
                    </p>
                  </div>
                  <ul
                    className="grid grid-cols-2 gap-2.5 px-5 py-4 sm:grid-cols-3"
                    aria-label="Popular sources"
                  >
                    {POPULAR_SOURCES.map((source) => (
                      <li
                        key={source.id}
                        className="flex items-center gap-3 rounded-xl border border-hi/15 bg-elev-1 px-3 py-2.5"
                      >
                        <BrandIcon id={source.id} fallback={brandLabel(source.id)} size={36} />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-semibold text-hi">
                            {brandLabel(source.id)}
                          </span>
                          <span className="block text-[11px] text-low">{source.kind}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>

                <p className="flex items-start gap-2.5 rounded-xl border border-hi/10 bg-elev-1 px-3.5 py-3 text-xs font-medium leading-relaxed text-mid">
                  <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gain" aria-hidden="true" />
                  <span>
                    Your ledger lives in this browser — not on our servers. Export or erase it
                    anytime.
                  </span>
                </p>
              </div>

              <div className="mt-6 flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <Button variant="ghost" onClick={() => setStep(0)}>
                    Back
                  </Button>
                  <Button className="flex-1" onClick={onStartImport}>
                    Import my first trades <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
                {skipLink}
              </div>
            </>
          )}
        </main>

        <p className="mt-10 font-mono text-[11px] text-faint">
          Every tax figure in SoloLedger is an estimate to help you file — not tax advice.
        </p>
      </div>
    </div>
  );
}

function ConfigRow({
  icon,
  label,
  value,
  last
}: {
  icon: ReactNode;
  label: string;
  value: string;
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between py-3 text-[13px]',
        !last && 'border-b border-hi/5'
      )}
    >
      <span className="flex items-center gap-2.5 text-low">
        {icon}
        {label}
      </span>
      <span className="font-semibold text-hi">{value}</span>
    </div>
  );
}

function NextStep({
  icon,
  title,
  body
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-hi/10 bg-elev-3 px-4 py-3.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
        {icon}
      </span>
      <div>
        <h3 className="flex items-center gap-1.5 text-sm font-bold text-hi">{title}</h3>
        <p className="mt-0.5 text-xs text-low">{body}</p>
      </div>
    </div>
  );
}
