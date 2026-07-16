import {
  ArrowRight,
  Bot,
  FileSpreadsheet,
  Globe2,
  Lock,
  Repeat,
  Server,
  Shield,
  Sparkles,
  TrendingUp,
  Wallet,
  Zap
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
  { icon: Lock, label: 'Local-first', color: 'bg-violet/15 text-blue' },
  { icon: Wallet, label: 'Solana-ready', color: 'bg-teal/15 text-teal' },
  { icon: Shield, label: 'No tx storage', color: 'bg-gain/15 text-gain' }
];

const DIFFERENTIATORS = [
  {
    icon: TrendingUp,
    title: 'Precision cost basis',
    line: 'FIFO & specific ID — multi-currency reports.',
    gradient: 'from-violet to-blue'
  },
  {
    icon: Repeat,
    title: 'Jupiter DCA, decoded',
    line: 'Auto-compute every DCA fill — exact amounts, not guesses.',
    gradient: 'from-violet to-[#a78bfa]'
  },
  {
    icon: FileSpreadsheet,
    title: 'CSV or wallet sync',
    line: 'Exchange exports or one-address Solana import.',
    gradient: 'from-warn to-[#FF8A3D]'
  },
  {
    icon: Bot,
    title: 'AI tax advisor',
    line: 'Opt-in — sends an aggregated summary, never raw wallets or hashes.',
    gradient: 'from-blue to-teal'
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
    <div className="min-h-screen bg-base text-hi">
      <header className="sticky top-0 z-30 border-b border-white/10 bg-base/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4 lg:px-8">
          <BrandLogo variant="on-glass" />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSignIn}
              className="hidden text-sm font-semibold text-mid hover:text-hi sm:inline"
            >
              Sign in
            </button>
            <Button
              onClick={scrollToChoose}
              className="h-9 rounded-full bg-aurora px-5 text-[#0A0B1A] hover:brightness-105"
            >
              Get started free
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-24 top-4 h-80 w-80 rounded-full bg-violet/20 blur-3xl" />
          <div className="absolute -right-16 top-24 h-96 w-96 rounded-full bg-blue/[0.16] blur-3xl" />
          <div className="absolute -bottom-16 left-1/3 h-72 w-72 rounded-full bg-teal/[0.14] blur-3xl" />
        </div>
        <div className="relative mx-auto max-w-6xl px-6 pb-16 pt-14 lg:px-8 lg:pb-24 lg:pt-20">
          <div className="flex flex-wrap gap-2">
            {HERO_PILLS.map(({ icon: Icon, label, color }) => (
              <span
                key={label}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide ${color}`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </span>
            ))}
          </div>

          <h1 className="mt-8 max-w-4xl font-display text-5xl font-bold leading-[1.05] tracking-tight text-hi sm:text-6xl lg:text-7xl">
            Crypto taxes that{' '}
            <span className="bg-aurora bg-clip-text text-transparent">
              stay on your device by default
            </span>
          </h1>
          <p className="mt-6 max-w-2xl text-xl text-mid sm:text-2xl">
            Private. Precise. Built for Solana — and every major chain. Network features (wallet lookup, AI advisor)
            are opt-in.
          </p>

          <div className="mt-10 flex flex-wrap gap-4">
            <Button
              onClick={scrollToChoose}
              className="h-14 rounded-full bg-aurora px-10 text-lg font-semibold text-[#0A0B1A] shadow-glow hover:brightness-105"
            >
              Start for free (up to 100 transactions)
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
            <Button
              onClick={onSignIn}
              className="h-14 rounded-full border border-white/10 bg-white/[0.03] px-8 text-base text-hi hover:border-violet/50 hover:bg-violet/[0.08]"
            >
              Sign in
            </Button>
          </div>
          <p className="mt-4 text-sm text-low">No credit card · Wallet lookup included on free tier</p>

          {/* Differentiator cards */}
          <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {DIFFERENTIATORS.map(({ icon: Icon, title, line, gradient }) => (
              <div
                key={title}
                className="group rounded-2xl border border-white/10 bg-elev-2 p-5 shadow-card transition hover:-translate-y-1 hover:border-violet/40 hover:shadow-card-hover"
              >
                <div
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-[#0A0B1A] shadow-soft ${gradient}`}
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
      <section className="border-y border-white/[0.06] bg-gradient-to-br from-elev-1 via-elev-2 to-elev-3 py-20 text-hi">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 lg:grid-cols-2 lg:px-8">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-blue/[0.14] px-4 py-1.5 text-sm font-semibold text-blue">
              <Sparkles className="h-4 w-4" />
              Built for Solana power users
            </div>
            <h2 className="mt-6 font-display text-4xl font-bold leading-tight text-hi sm:text-5xl">
              Jupiter DCA trades, automatically computed
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-mid">
              Enter a Solana address — SoloLedger imports your on-chain history, detects Jupiter recurring
              orders, resolves exact fill amounts, and classifies every DCA sell/buy. No spreadsheet stitching.
            </p>
            <Button
              onClick={scrollToChoose}
              className="mt-8 h-12 rounded-full bg-hi px-8 font-semibold text-[#0A0B1A] hover:bg-[#e4e6ff]"
            >
              Try wallet import
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
          <div className="relative">
            <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-8 shadow-card backdrop-blur-sm">
              <Wallet className="h-12 w-12 text-blue" />
              <ul className="mt-6 space-y-4">
                {[
                  'One-click import of Solana transactions',
                  'Jupiter DCA vault detection & fill parsing',
                  'Swaps, staking & SPL transfers classified',
                  'Secure proxy — keys never in your browser'
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3 text-hi">
                    <Zap className="mt-0.5 h-5 w-5 shrink-0 text-warn" />
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
          <h2 className="text-center font-display text-3xl font-bold text-hi sm:text-4xl">
            Privacy you can verify
          </h2>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {PRIVACY_TILES.map(({ icon: Icon, title, line }) => (
              <div
                key={title}
                className="rounded-2xl border border-white/10 bg-elev-2 p-6 text-center shadow-card transition hover:border-violet/30 hover:shadow-card-hover"
              >
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet/25 to-blue/25 text-blue">
                  <Icon className="h-7 w-7" />
                </div>
                <h3 className="mt-4 text-lg font-bold text-hi">{title}</h3>
                <p className="mt-1 text-sm text-mid">{line}</p>
              </div>
            ))}
          </div>
          <div className="mx-auto mt-10 max-w-3xl rounded-2xl border border-white/10 bg-gradient-to-r from-elev-1 to-elev-3 p-6 text-center shadow-card-hover">
            <p className="text-xs font-bold uppercase tracking-widest text-teal">Automatic wallet import</p>
            <p className="mt-2 text-base text-mid">
              Requests are forwarded to blockchain providers and discarded immediately.{' '}
              <strong className="text-hi">We never store wallet addresses or transaction data.</strong>
            </p>
          </div>
        </div>
      </section>

      <LandingPlansSection onSelectPlan={handlePlan} />

      {/* CTA */}
      <section className="bg-aurora py-16">
        <div className="mx-auto max-w-3xl px-6 text-center text-[#0A0B1A] lg:px-8">
          <h2 className="font-display text-4xl font-bold">Ready when you are</h2>
          <p className="mt-3 text-lg text-[#0A0B1A]/70">Local by default. Powerful when you need it.</p>
          <Button
            onClick={scrollToChoose}
            className="mt-8 h-12 rounded-full bg-hi px-10 text-base font-semibold text-[#0A0B1A] hover:bg-[#e4e6ff]"
          >
            Get started — free
          </Button>
        </div>
      </section>

      <footer className="border-t border-white/10 py-8 text-center text-xs text-low">
        <p>SoloLedger · Private. Precise. Yours.</p>
      </footer>
    </div>
  );
}
