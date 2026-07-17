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
import type { PaidPlanId } from '@/lib/saas/planCatalog';

type LandingPageProps = {
  onSignIn: () => void;
  onGetStarted: () => void;
};

const HERO_PILLS = [
  { icon: Lock, label: 'Local-first', color: 'bg-violet/15 text-blue' },
  { icon: Wallet, label: 'Solana-ready', color: 'bg-purple-100 text-purple-800' },
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
    gradient: 'from-violet-500 to-purple-600'
  },
  {
    icon: FileSpreadsheet,
    title: 'CSV or wallet sync',
    line: 'Exchange exports or one-address Solana import.',
    gradient: 'from-amber-500 to-orange-500'
  },
  {
    icon: Bot,
    title: 'AI tax advisor',
    line: 'Opt-in — sends an aggregated summary, never raw wallets or hashes.',
    gradient: 'from-elev-1 to-blue'
  }
];

const PRIVACY_TILES = [
  { icon: Lock, title: 'Local by default', line: 'Imports, calculations and reports run on your device.' },
  { icon: Server, title: 'Opt-in network', line: 'Wallet lookup and the AI advisor stay off until you turn them on.' },
  { icon: Shield, title: 'You see every exit', line: 'A live badge shows the moment anything leaves your device.' },
  { icon: Globe2, title: 'You hold the keys', line: 'Cross-device backups are encrypted on your device first — we can’t read them.' }
];

export function LandingPage({ onSignIn, onGetStarted }: LandingPageProps) {
  const handlePlan = (_planId: PaidPlanId) => onGetStarted();

  return (
    <div className="min-h-screen bg-[#faf9f6] text-hi">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-[#faf9f6]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4 lg:px-8">
          <BrandLogo variant="on-glass" />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSignIn}
              className="hidden text-sm font-medium text-hi/80 hover:text-hi sm:inline"
            >
              Sign in
            </button>
            <Button onClick={onGetStarted} className="rounded-full bg-elev-1 px-5 hover:bg-elev-2">
              Get started free
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-20 top-10 h-72 w-72 rounded-full bg-violet/20 blur-3xl" />
          <div className="absolute right-0 top-32 h-96 w-96 rounded-full bg-amber-200/40 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-gain/30 blur-3xl" />
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

          <h1 className="mt-8 max-w-4xl font-display text-5xl font-bold leading-[1.05] text-hi sm:text-6xl lg:text-7xl">
            Crypto taxes that{' '}
            <span className="bg-gradient-to-r from-violet via-blue to-blue bg-clip-text text-transparent">
              stay on your device by default
            </span>
          </h1>
          <p className="mt-6 max-w-2xl text-xl text-slate-600 sm:text-2xl">
            Private. Precise. Built for Solana — and every major chain. Network features (wallet lookup, AI advisor)
            are opt-in.
          </p>

          <div className="mt-10 flex flex-wrap gap-4">
            <Button
              onClick={onGetStarted}
              className="h-14 rounded-full bg-gradient-to-r from-violet to-blue px-10 text-lg font-semibold shadow-lg shadow-glow hover:from-violet hover:to-blue"
            >
              Start for free (up to 100 transactions)
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>
            <Button onClick={onSignIn} className="h-14 rounded-full px-8 text-base">
              Sign in
            </Button>
          </div>
          <p className="mt-4 text-sm text-slate-500">No credit card · Wallet lookup included on free tier</p>

          {/* Differentiator cards */}
          <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {DIFFERENTIATORS.map(({ icon: Icon, title, line, gradient }) => (
              <div
                key={title}
                className="group rounded-2xl border border-white/80 bg-white/80 p-5 shadow-lg backdrop-blur-sm transition hover:-translate-y-1 hover:shadow-xl"
              >
                <div
                  className={`inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-md ${gradient}`}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 text-lg font-bold text-hi">{title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{line}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Solana / Jupiter DCA */}
      <section className="border-y border-slate-200/80 bg-gradient-to-br from-elev-1 via-elev-2 to-blue py-20 text-white">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 lg:grid-cols-2 lg:px-8">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-1.5 text-sm font-semibold text-blue">
              <Sparkles className="h-4 w-4" />
              Built for Solana power users
            </div>
            <h2 className="mt-6 font-display text-4xl font-bold leading-tight sm:text-5xl">
              Jupiter DCA trades, automatically computed
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-blue">
              Enter a Solana address — SoloLedger imports your on-chain history, detects Jupiter recurring
              orders, resolves exact fill amounts, and classifies every DCA sell/buy. No spreadsheet stitching.
            </p>
            <Button
              onClick={onGetStarted}
              className="mt-8 h-12 rounded-full bg-white px-8 font-semibold text-hi hover:bg-violet/10"
            >
              Try wallet import
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
          <div className="relative">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-8 backdrop-blur-sm">
              <Wallet className="h-12 w-12 text-blue" />
              <ul className="mt-6 space-y-4">
                {[
                  'One-click import of Solana transactions',
                  'Jupiter DCA vault detection & fill parsing',
                  'Swaps, staking & SPL transfers classified',
                  'Secure proxy — keys never in your browser'
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3 text-hi">
                    <Zap className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
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
                className="rounded-2xl border border-slate-100 bg-white p-6 text-center shadow-sm transition hover:shadow-md"
              >
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet/20 to-blue text-blue">
                  <Icon className="h-7 w-7" />
                </div>
                <h3 className="mt-4 text-lg font-bold text-hi">{title}</h3>
                <p className="mt-1 text-sm text-slate-600">{line}</p>
              </div>
            ))}
          </div>
          <div className="mx-auto mt-10 max-w-3xl rounded-2xl bg-gradient-to-r from-slate-800 to-blue p-6 text-center text-white shadow-xl">
            <p className="text-xs font-bold uppercase tracking-widest text-blue">Automatic wallet import</p>
            <p className="mt-2 text-base text-hi">
              Requests are forwarded to blockchain providers and discarded immediately.{' '}
              <strong className="text-white">We never store wallet addresses or transaction data.</strong>
            </p>
          </div>
        </div>
      </section>

      <LandingPlansSection onSelectPlan={handlePlan} />

      {/* CTA */}
      <section className="bg-gradient-to-r from-violet to-blue py-16">
        <div className="mx-auto max-w-3xl px-6 text-center text-white lg:px-8">
          <h2 className="font-display text-4xl font-bold">Ready when you are</h2>
          <p className="mt-3 text-lg text-blue">Local by default. Powerful when you need it.</p>
          <Button
            onClick={onGetStarted}
            className="mt-8 h-12 rounded-full bg-white px-10 text-base font-semibold text-hi hover:bg-violet/10"
          >
            Get started — free
          </Button>
        </div>
      </section>

      <footer className="border-t border-slate-200 py-8 text-center text-xs text-slate-500">
        <p>SoloLedger · Private. Precise. Yours.</p>
      </footer>
    </div>
  );
}
