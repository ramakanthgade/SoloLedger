import {
  ArrowRight,
  CheckCircle2,
  FileSpreadsheet,
  Lock,
  Server,
  Shield,
  Wallet,
  Zap
} from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';

type LandingPageProps = {
  onSignIn: () => void;
  onGetStarted: () => void;
};

const PRIVACY_POINTS = [
  {
    icon: Lock,
    title: 'Local by default',
    body: 'CSV import and tax calculations run entirely in your browser. Nothing is uploaded to our servers.'
  },
  {
    icon: Server,
    title: 'Short-lived proxy requests',
    body: 'Automatic wallet import forwards your query to blockchain providers (Helius, Moralis, etc.) and returns the result. Nothing is kept.'
  },
  {
    icon: Shield,
    title: 'No logging of wallet addresses',
    body: 'Our proxy does not log or store the wallet addresses you query. Your activity stays between you and the chain.'
  },
  {
    icon: FileSpreadsheet,
    title: 'Optional 100% local mode',
    body: 'Prefer maximum privacy? Skip wallet lookup and use CSV import only — full control, zero network calls for your data.'
  }
];

const FEATURES = [
  'Solana wallet lookup with DBT income auto-classification',
  'FIFO / cost-basis engine with India & multi-currency support',
  'Capital gains reports — CSV, JSON, and branded PDF export',
  'Live price lookup via secure proxy (no API keys for subscribers)',
  'AI tax advisor (optional) — your data never leaves the browser'
];

export function LandingPage({ onSignIn, onGetStarted }: LandingPageProps) {
  return (
    <div className="min-h-screen bg-[#f8f6f1] text-navy">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-[#f8f6f1]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4 lg:px-8">
          <BrandLogo variant="dark" />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onSignIn}
              className="hidden text-sm font-medium text-navy/80 hover:text-navy sm:inline"
            >
              Sign in
            </button>
            <Button
              onClick={onGetStarted}
              className="rounded-full bg-navy px-5 hover:bg-navy-800"
            >
              Get started free
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-teal-100/50 via-transparent to-amber-100/40" />
        <div className="relative mx-auto grid max-w-6xl gap-12 px-6 py-16 lg:grid-cols-2 lg:items-center lg:px-8 lg:py-24">
          <div>
            <span className="inline-flex rounded-full bg-teal-100 px-3 py-1 text-xs font-bold uppercase tracking-wider text-teal-800">
              More private than most tax tools
            </span>
            <h1 className="mt-5 font-display text-4xl font-bold leading-[1.1] text-navy sm:text-5xl lg:text-[3.25rem]">
              Crypto taxes that stay{' '}
              <span className="bg-gradient-to-r from-teal-600 to-emerald-600 bg-clip-text text-transparent">
                on your device
              </span>
            </h1>
            <p className="mt-5 max-w-xl text-lg text-slate-600">
              SoloLedger combines precision cost-basis reporting with a privacy-first architecture. Import from CSV or
              pull Solana wallets through a secure proxy — we never store your transactions.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Button
                onClick={onGetStarted}
                className="h-12 rounded-full bg-gradient-to-r from-teal-600 to-emerald-600 px-8 text-base font-semibold hover:from-teal-700 hover:to-emerald-700"
              >
                Start 14-day free trial
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
              <Button onClick={onSignIn} className="h-12 rounded-full px-8">
                Sign in
              </Button>
            </div>
            <p className="mt-4 text-sm text-slate-500">No credit card · Wallet lookup on trial · Data encrypted in transit</p>
          </div>

          <div className="relative">
            <div className="rounded-2xl border border-white/80 bg-white p-6 shadow-2xl shadow-teal-900/10">
              <div className="flex items-center gap-2 text-sm font-semibold text-teal-700">
                <Zap className="h-4 w-4" />
                How SoloLedger is different
              </div>
              <ul className="mt-4 space-y-3">
                {FEATURES.map((f) => (
                  <li key={f} className="flex gap-2 text-sm text-slate-700">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    {f}
                  </li>
                ))}
              </ul>
              <div className="mt-6 rounded-xl bg-gradient-to-br from-navy to-teal-900 p-4 text-white">
                <p className="text-xs uppercase tracking-wider text-teal-200">Automatic wallet import</p>
                <p className="mt-2 text-sm leading-relaxed text-teal-50">
                  When you use wallet lookup, our servers temporarily forward your request to blockchain data providers.
                  <strong className="text-white"> We do not store or log your wallet addresses or transaction data.</strong>
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Privacy */}
      <section className="border-y border-slate-200/80 bg-white py-16">
        <div className="mx-auto max-w-6xl px-6 lg:px-8">
          <div className="text-center">
            <h2 className="font-display text-3xl font-bold text-navy">Privacy you can verify</h2>
            <p className="mx-auto mt-3 max-w-2xl text-slate-600">
              Most crypto tax tools upload your entire history. SoloLedger keeps your ledger local and only uses the
              network when you choose.
            </p>
          </div>
          <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {PRIVACY_POINTS.map(({ icon: Icon, title, body }) => (
              <div
                key={title}
                className="rounded-2xl border border-slate-100 bg-gradient-to-b from-slate-50 to-white p-5 shadow-sm"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-100 text-teal-700">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="mt-4 font-semibold text-navy">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Solana */}
      <section className="py-16">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 lg:grid-cols-2 lg:px-8">
          <div className="order-2 lg:order-1">
            <div className="rounded-2xl bg-gradient-to-br from-purple-600/10 via-teal-500/10 to-emerald-500/10 p-8">
              <Wallet className="h-10 w-10 text-teal-700" />
              <h3 className="mt-4 text-2xl font-bold text-navy">Built for Solana power users</h3>
              <p className="mt-3 text-slate-600">
                Import Phantom and other Solana wallets with one address. DBT rewards, Jupiter swaps, and staking flows
                are classified automatically — including Dabba Network claim transactions.
              </p>
            </div>
          </div>
          <div className="order-1 lg:order-2">
            <h2 className="font-display text-3xl font-bold text-navy">Accurate. Automatic. Yours.</h2>
            <p className="mt-4 text-slate-600">
              From CSV exchange exports to on-chain wallet sync, SoloLedger stitches a complete picture for capital gains,
              portfolio cost basis, and jurisdiction-aware reports.
            </p>
            <Button onClick={onGetStarted} className="mt-6 rounded-full bg-navy px-6 hover:bg-navy-800">
              Try it free
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="bg-gradient-to-r from-navy via-navy-800 to-teal-900 py-16 text-white">
        <div className="mx-auto max-w-3xl px-6 text-center lg:px-8">
          <h2 className="font-display text-3xl font-bold">Ready for precise, private crypto taxes?</h2>
          <p className="mt-4 text-teal-100">
            Join SoloLedger — local by default, with optional secure wallet import when you need it.
          </p>
          <Button
            onClick={onGetStarted}
            className="mt-8 h-12 rounded-full bg-white px-8 text-base font-semibold text-navy hover:bg-teal-50"
          >
            Get started — free trial
          </Button>
        </div>
      </section>

      <footer className="border-t border-slate-200 py-8 text-center text-xs text-slate-500">
        <p>SoloLedger · Private. Precise. Yours.</p>
        <p className="mt-2 max-w-2xl mx-auto px-4">
          Transparent privacy: wallet import requests are forwarded to third-party blockchain APIs. We do not store or
          log wallet addresses or transaction data on our servers.
        </p>
      </footer>
    </div>
  );
}
