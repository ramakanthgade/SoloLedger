import {
  ArrowRight,
  Bot,
  Check,
  FileSpreadsheet,
  Globe2,
  Lock,
  Repeat,
  Server,
  Shield,
  Sparkles,
  TrendingUp,
  Wallet
} from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { LandingPlansSection } from '@/components/auth/LandingPlansSection';
import { ChoosePathSection } from '@/components/auth/ChoosePathSection';
import type { AppMode } from '@/lib/saas/mode';
import type { PlanId } from '@/lib/saas/planCatalog';

type LandingPageProps = {
  /** Pick a usage mode (from the Choose-your-path cards or plan cards). */
  onSelectMode: (mode: AppMode) => void;
  /** Go to hosted sign-in (header "Sign in" link). */
  onSignIn: () => void;
};

const HERO_PILLS = [
  { icon: Lock, label: 'Local-first', tone: 'text-primary' },
  { icon: Wallet, label: 'Solana-ready', tone: 'text-accent' },
  { icon: Shield, label: 'No tx storage', tone: 'text-gain' }
];

const DIFFERENTIATORS = [
  {
    icon: TrendingUp,
    title: 'Precision cost basis',
    line: 'FIFO & specific ID — multi-currency reports.',
    tile: 'bg-primary/10 text-primary'
  },
  {
    icon: Repeat,
    title: 'Jupiter DCA, decoded',
    line: 'Auto-compute every DCA fill — exact amounts, not guesses.',
    tile: 'bg-accent/10 text-accent'
  },
  {
    icon: FileSpreadsheet,
    title: 'CSV or wallet sync',
    line: 'Exchange exports or one-address Solana import.',
    tile: 'bg-gain/10 text-gain'
  },
  {
    icon: Bot,
    title: 'AI tax advisor',
    line: 'Opt-in — sends an aggregated summary, never raw wallets or hashes.',
    // AI moment: the ember→amber aurora gradient is reserved for exactly this.
    tile: 'bg-aurora text-on-aurora'
  }
];

const PRIVACY_TILES = [
  { icon: Lock, title: 'Local by default', line: 'Imports, calculations and reports run on your device.' },
  { icon: Server, title: 'Opt-in network', line: 'Wallet lookup and the AI advisor stay off until you turn them on.' },
  { icon: Shield, title: 'You see every exit', line: 'A live badge shows the moment anything leaves your device.' },
  { icon: Globe2, title: 'You hold the keys', line: 'Cross-device backups are encrypted on your device first — we can’t read them.' }
];

function scrollToChoose() {
  document.getElementById('choose')?.scrollIntoView({ behavior: 'smooth' });
}

export function LandingPage({ onSelectMode, onSignIn }: LandingPageProps) {
  // Local plan is account-free; every paid tier is a hosted plan → register.
  const handlePlan = (planId: PlanId) => onSelectMode(planId === 'local' ? 'local' : 'hosted');

  return (
    <div className="min-h-screen bg-canvas text-hi">
      <header className="sticky top-0 z-30 border-b border-hi/10 bg-canvas/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3 lg:px-8">
          <BrandLogo variant="on-glass" />
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onSignIn} className="hidden sm:inline-flex">
              Sign in
            </Button>
            <Button onClick={scrollToChoose}>Get started free</Button>
          </div>
        </div>
      </header>

      {/* Hero — warm paper canvas with a subtle ember hearth glow */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-24 top-4 h-80 w-80 rounded-full bg-primary/10 blur-3xl" />
          <div className="absolute -right-16 top-24 h-96 w-96 rounded-full bg-accent/10 blur-3xl" />
          <div className="absolute -bottom-16 left-1/3 h-72 w-72 rounded-full bg-accent/[0.08] blur-3xl" />
        </div>
        <div className="relative mx-auto max-w-6xl px-6 pb-16 pt-14 lg:px-8 lg:pb-24 lg:pt-20">
          <div className="flex flex-wrap gap-2">
            {HERO_PILLS.map(({ icon: Icon, label, tone }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 rounded-full border border-hi/10 bg-elev-1 px-3 py-1 text-xs font-bold text-mid shadow-xs"
              >
                <Icon className={`h-3.5 w-3.5 ${tone}`} />
                {label}
              </span>
            ))}
          </div>

          <h1 className="mt-8 max-w-4xl font-display text-5xl font-extrabold leading-[1.06] tracking-tight text-hi sm:text-6xl">
            Crypto taxes in minutes.{' '}
            <span className="bg-aurora bg-clip-text text-transparent">
              Nothing ever leaves your device.
            </span>
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-mid sm:text-xl">
            Private. Precise. Built for Solana — and every major chain. Network features (wallet lookup, AI advisor)
            are opt-in.
          </p>

          <div className="mt-10 flex flex-wrap gap-4">
            <Button size="lg" onClick={scrollToChoose} className="px-8 text-base">
              Start for free (up to 100 transactions)
              <ArrowRight className="h-5 w-5" />
            </Button>
            <Button size="lg" variant="secondary" onClick={onSignIn} className="px-8 text-base">
              Sign in
            </Button>
          </div>
          <p className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-low">
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4 text-gain" />
              No credit card
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Check className="h-4 w-4 text-gain" />
              Wallet lookup included on free tier
            </span>
          </p>

          {/* Differentiator cards */}
          <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {DIFFERENTIATORS.map(({ icon: Icon, title, line, tile }) => (
              <div
                key={title}
                className="rounded-[20px] border border-hi/10 bg-elev-2 p-6 shadow-card transition duration-200 hover:-translate-y-1 hover:border-primary/30 hover:shadow-card-hover"
              >
                <div
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-[13px] shadow-xs ${tile}`}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-bold text-hi">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-mid">{line}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Choose how you want to use SoloLedger */}
      <ChoosePathSection onSelectMode={onSelectMode} />

      {/* Solana / Jupiter DCA */}
      <section className="border-b border-hi/10 bg-elev-1 py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 lg:grid-cols-2 lg:px-8">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-accent/25 bg-accent/10 px-4 py-1.5 text-sm font-semibold text-accent">
              <Sparkles className="h-4 w-4" />
              Built for Solana power users
            </div>
            <h2 className="mt-6 font-display text-4xl font-extrabold leading-tight tracking-tight text-hi sm:text-5xl">
              Jupiter DCA trades, automatically computed
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-mid">
              Enter a Solana address — SoloLedger imports your on-chain history, detects Jupiter recurring
              orders, resolves exact fill amounts, and classifies every DCA sell/buy. No spreadsheet stitching.
            </p>
            <Button size="lg" onClick={scrollToChoose} className="mt-8 px-8">
              Try wallet import
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
          <div className="relative">
            <div className="rounded-[20px] border border-hi/10 bg-elev-2 p-8 shadow-card">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-[13px] bg-accent/10 text-accent shadow-xs">
                <Wallet className="h-6 w-6" />
              </div>
              <ul className="mt-6 space-y-4">
                {[
                  'One-click import of Solana transactions',
                  'Jupiter DCA vault detection & fill parsing',
                  'Swaps, staking & SPL transfers classified',
                  'Secure proxy — keys never in your browser'
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3 text-hi">
                    <Check className="mt-0.5 h-5 w-5 shrink-0 text-gain" />
                    <span className="text-base">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Privacy strip */}
      <section className="py-16">
        <div className="mx-auto max-w-6xl px-6 lg:px-8">
          <h2 className="text-center font-display text-3xl font-extrabold tracking-tight text-hi sm:text-4xl">
            Privacy you can verify
          </h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PRIVACY_TILES.map(({ icon: Icon, title, line }) => (
              <div
                key={title}
                className="rounded-[20px] border border-hi/10 bg-elev-2 p-6 text-center shadow-card transition duration-200 hover:-translate-y-1 hover:border-primary/30 hover:shadow-card-hover"
              >
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-[13px] bg-primary/10 text-primary shadow-xs">
                  <Icon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-lg font-bold text-hi">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-mid">{line}</p>
              </div>
            ))}
          </div>
          <div className="mx-auto mt-10 max-w-3xl rounded-[20px] border border-hi/10 bg-elev-2 p-6 text-center shadow-card">
            <p className="text-xs font-bold uppercase tracking-widest text-primary">Automatic wallet import</p>
            <p className="mt-2 text-base text-mid">
              Requests are forwarded to blockchain providers and discarded immediately.{' '}
              <strong className="text-hi">We never store wallet addresses or transaction data.</strong>
            </p>
          </div>
        </div>
      </section>

      <LandingPlansSection onSelectPlan={handlePlan} />

      {/* CTA — brand aurora band (ember → amber; label flips per theme) */}
      <section className="bg-aurora py-16">
        <div className="mx-auto max-w-3xl px-6 text-center text-on-aurora lg:px-8">
          <h2 className="font-display text-4xl font-extrabold tracking-tight">Ready when you are</h2>
          <p className="mt-3 text-lg text-on-aurora/80">Local by default. Powerful when you need it.</p>
          <Button
            size="lg"
            onClick={scrollToChoose}
            className="mt-8 bg-hi px-10 text-base text-on-aurora shadow-pop hover:bg-hi/85"
          >
            Get started — free
          </Button>
        </div>
      </section>

      <footer className="border-t border-hi/10 py-8 text-center text-xs text-low">
        <p>SoloLedger · Private. Precise. Yours.</p>
      </footer>
    </div>
  );
}
