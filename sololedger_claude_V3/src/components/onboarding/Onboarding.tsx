import { useEffect, useState, type ReactNode } from 'react';
import {
  ShieldCheck,
  Clock,
  IndianRupee,
  Percent,
  Upload,
  ListChecks,
  TrendingUp,
  ChevronRight
} from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { SwitchModeButton } from '@/components/SwitchModeButton';
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
 * First-run onboarding (Task T3).
 *
 * India-LOCKED: we deliberately DROP the mockup's country/currency picker
 * (`aurora-onboarding.html` Step 1) since Phase 1 is India-only. Instead we
 * silently persist the India defaults (jurisdiction IN, reporting currency INR)
 * and show a brief India setup confirmation, then a welcome step that hands off
 * to the guided ConnectionWizard.
 *
 * Aurora styling follows the approved mockup for the remaining steps.
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
      className="text-center text-xs font-medium text-low transition-colors hover:text-mid focus:outline-none focus-visible:underline"
    >
      Skip setup — go straight to Import
    </button>
  );

  return (
    <div className="min-h-screen bg-canvas px-6 py-12 lg:px-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex justify-end">
          <SwitchModeButton />
        </div>
        <div className="mb-8 flex flex-col items-center gap-2">
          <BrandLogo variant="on-glass" />
          <p className="font-mono text-[10.5px] font-medium uppercase tracking-[0.22em] text-low">
            Private <span className="text-teal">·</span> Precise <span className="text-teal">·</span>{' '}
            Yours
          </p>
        </div>

        <div className="mb-6 flex justify-center gap-2" aria-hidden="true">
          {[0, 1].map((i) => (
            <span
              key={i}
              className={cn(
                'h-2 w-2 rounded-full',
                i === step ? 'bg-aurora shadow-glow' : 'border border-white/10 bg-elev-3'
              )}
            />
          ))}
        </div>

        {step === 0 ? (
          <section className="overflow-hidden rounded-2xl border border-violet/30 bg-elev-2 shadow-card">
            <div className="border-b border-white/5 px-6 py-5">
              <span className="mb-3 inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wider text-teal">
                <span className="h-1.5 w-1.5 rounded-full bg-teal shadow-glow" />
                Step 1 of 2 · Your setup
              </span>
              <h2 className="text-xl font-extrabold tracking-tight text-hi">
                Set up for India
              </h2>
              <p className="mt-2 text-sm text-mid">
                SoloLedger is tuned for Indian crypto tax — Financial Year Apr–Mar, in ₹. You can
                fine-tune everything later in Settings.
              </p>
            </div>
            <div className="space-y-4 px-6 py-5">
              <div className="rounded-xl border border-white/10 bg-elev-1 px-4">
                <ConfigRow
                  icon={<Clock className="h-4 w-4 text-teal" />}
                  label="Reporting period"
                  value="Financial Year (Apr–Mar)"
                />
                <ConfigRow
                  icon={<IndianRupee className="h-4 w-4 text-teal" />}
                  label="Currency"
                  value="₹ INR · lakh / crore"
                  last={false}
                />
                <ConfigRow
                  icon={<Percent className="h-4 w-4 text-teal" />}
                  label="Crypto tax rule"
                  value="Flat 30% + 4% cess · 1% TDS"
                  last
                />
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-gain/25 bg-gain/[0.07] px-4 py-3.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gain/15 text-gain">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <div>
                  <h4 className="text-xs font-bold text-hi">No account needed</h4>
                  <p className="mt-0.5 text-xs text-mid">
                    Everything runs on this device. Nothing has left it — and a badge tells you the
                    moment anything does.
                  </p>
                </div>
              </div>
            </div>
            <div className="flex flex-col items-stretch gap-3 border-t border-white/5 px-6 py-4">
              <Button className="w-full" onClick={() => setStep(1)}>
                Continue <ChevronRight className="h-4 w-4" />
              </Button>
              {skipLink}
            </div>
          </section>
        ) : (
          <section className="overflow-hidden rounded-2xl border border-white/10 bg-elev-2 shadow-card">
            <div className="border-b border-white/5 px-6 py-5">
              <span className="mb-3 inline-flex items-center gap-2 font-mono text-[11px] font-medium uppercase tracking-wider text-violet">
                <span className="h-1.5 w-1.5 rounded-full bg-violet shadow-glow" />
                Step 2 of 2 · You're all set
              </span>
              <h2 className="text-xl font-extrabold tracking-tight text-hi">
                Welcome to SoloLedger
              </h2>
              <p className="mt-2 text-sm text-mid">
                Set up for India — Financial Year Apr–Mar, in ₹. Here's the quickest path from messy
                trades to a number you can file.
              </p>
            </div>
            <div className="space-y-3 px-6 py-5">
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
            </div>
            <div className="flex flex-col gap-3 border-t border-white/5 px-6 py-4">
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
          </section>
        )}

        <p className="mt-6 text-center font-mono text-[11px] text-faint">
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
        !last && 'border-b border-white/5'
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
    <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-elev-3 px-4 py-3.5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-violet/15 text-violet">
        {icon}
      </span>
      <div>
        <h4 className="flex items-center gap-1.5 text-sm font-bold text-hi">{title}</h4>
        <p className="mt-0.5 text-xs text-low">{body}</p>
      </div>
    </div>
  );
}
