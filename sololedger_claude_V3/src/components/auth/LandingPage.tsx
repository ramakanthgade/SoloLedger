import { useEffect, useState, type FormEvent } from 'react';
import {
  ArrowRight,
  Check,
  Cpu,
  Database,
  Download,
  Eye,
  IndianRupee,
  Lock,
  Monitor,
  Play,
  RefreshCw,
  Shield,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  X
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Toast, ToastViewport } from '@/components/ui/toast';
import { LandingPlansSection } from '@/components/auth/LandingPlansSection';
import { ChoosePathSection } from '@/components/auth/ChoosePathSection';
import { cn } from '@/lib/utils';
import type { AppMode } from '@/lib/saas/mode';
import type { PlanId } from '@/lib/saas/planCatalog';

/**
 * Landing page — the approved foundation-landing mockup's full content in the
 * Ember & Slate system: hero + product preview, stats band, What's new,
 * Privacy, Private AI, the 7-row Compare table, grouped Pricing (plans + the
 * three-mode chooser), the aurora CTA band and the full footer. Mode-selection
 * LOGIC is untouched — every "start free" CTA scrolls to the same chooser as
 * before and Sign in still goes to hosted auth.
 */

type LandingPageProps = {
  /** Pick a usage mode (from the Choose-your-path cards or plan cards). */
  onSelectMode: (mode: AppMode) => void;
  /** Go to hosted sign-in (header "Sign in" link). */
  onSignIn: () => void;
};

const NAV_LINKS = [
  { id: 'new', label: "What's new" },
  { id: 'privacy', label: 'Privacy' },
  { id: 'private-ai', label: 'Private AI' },
  { id: 'compare', label: 'Compare' },
  { id: 'pricing', label: 'Pricing' }
];

const HERO_STEPS = ['Import', 'Review', 'Export'];

const HERO_CHECKMARKS = ['Free forever tier', 'No credit card', 'Nothing to install'];

type FeatureCard = {
  icon: LucideIcon;
  /** Tonal icon-tile classes (surface tint + tone glyph). */
  tile: string;
  title: string;
  body: string;
  isNew?: boolean;
};

const WHATS_NEW: FeatureCard[] = [
  {
    icon: RefreshCw,
    tile: 'bg-gain/10 text-gain',
    title: 'Exchange auto-sync',
    isNew: true,
    body: 'Read-only API keys keep Binance, CoinDCX and WazirX in sync on a schedule. Overlapping CSV imports are deduplicated automatically — never a double-counted trade.'
  },
  {
    icon: Sparkles,
    // AI moment: the ember→amber aurora gradient is reserved for exactly this.
    tile: 'bg-aurora text-on-aurora',
    title: 'AI tax advisor',
    isNew: true,
    body: 'Ask “why is my TDS this high?” in plain words. Everyday answers run on-device; heavy reasoning runs in a hardware-isolated enclave. Your raw data is never the payload.'
  },
  {
    icon: TrendingUp,
    tile: 'bg-primary/10 text-primary',
    title: 'Derivatives & perpetuals',
    body: 'Futures, perps and funding fees classified correctly — realized P&L, funding and fees separated the way Indian tax treatment expects.'
  },
  {
    icon: Download,
    tile: 'bg-accent/10 text-accent',
    title: 'Hyperliquid & Binance P2P',
    isNew: true,
    body: 'Native importers for Hyperliquid on-chain history and Binance P2P fills — the two sources every other tool makes you stitch by hand.'
  },
  {
    icon: IndianRupee,
    tile: 'bg-gain/10 text-gain',
    title: 'India Schedule VDA + TDS',
    body: 'Schedule VDA for ITR-2/ITR-3, Section 115BBH at 30% + cess, and a quarterly TDS reconciliation under 194S — mapped lot-by-lot, CA-ready.'
  },
  {
    icon: Database,
    tile: 'bg-primary/10 text-primary',
    title: '200+ import sources',
    body: 'Exchanges, self-custody wallets, blockchains and services. Paste an address, drop a CSV, or connect read-only sync — your history lands in minutes.'
  }
];

const STATS = [
  { n: '26', label: 'filing-ready report forms, incl. Schedule VDA & TDS' },
  { n: '200+', label: 'import sources — exchanges, wallets, chains' },
  { n: '100%', label: 'private by default — no account, no upload' }
];

const NET_STATES = [
  { label: '100% Local', tone: 'border-gain/30 bg-gain/10 text-gain' },
  { label: 'Local + network on', tone: 'border-accent/30 bg-accent/10 text-accent' },
  { label: 'Local + relay', tone: 'border-primary/30 bg-primary/10 text-primary' }
];

const PRIVACY_CARDS: FeatureCard[] = [
  {
    icon: Lock,
    tile: 'bg-primary/10 text-primary',
    title: 'Local by default',
    body: 'Imports, calculations and reports run on your device — in IndexedDB, not on our servers.'
  },
  {
    icon: Monitor,
    tile: 'bg-accent/10 text-accent',
    title: 'Opt-in network',
    body: 'Wallet lookup, live prices and the AI advisor stay off until you turn them on, per feature.'
  },
  {
    icon: Eye,
    tile: 'bg-gain/10 text-gain',
    title: 'You see every exit',
    body: 'The live badge flips the moment a request leaves — and says exactly what it carried.'
  },
  {
    icon: ShieldCheck,
    tile: 'bg-warn/10 text-warn',
    title: 'You hold the keys',
    body: 'Cross-device backups are encrypted on your device first. Read-only API keys only — trading stays off.'
  }
];

type AiLane = FeatureCard & { checkTone: string; bullets: string[] };

const AI_LANES: AiLane[] = [
  {
    icon: Cpu,
    tile: 'bg-gain/10 text-gain',
    checkTone: 'text-gain',
    title: 'On-device insights',
    body: 'Everyday answers — lot lookups, gain explainers, TDS reconciliation — computed by models running inside your browser. Zero upload, works offline, instant.',
    bullets: [
      '“Which lots make up this gain?”',
      'TDS & Section 115BBH nudges as you trade',
      'Runs in the same tab as your data'
    ]
  },
  {
    icon: Shield,
    tile: 'bg-aurora text-on-aurora',
    checkTone: 'text-primary',
    title: 'Confidential enclave for heavy reasoning',
    body: 'Multi-year what-ifs run inside a hardware-isolated confidential-computing enclave: encrypted in, computed where no one — not even SoloLedger — can read it, deleted after the answer.',
    bullets: [
      'Hardware-attested isolation, memory wiped after use',
      'Aggregated numbers in — never raw transaction lines',
      'Every answer shows exactly what was used'
    ]
  }
];

const AI_GUARANTEES = [
  { icon: Shield, text: 'Raw transactions are never stored on our servers' },
  { icon: X, text: 'Never sent in full to third-party AI providers' },
  { icon: Eye, text: 'Each answer cites the exact data it used' }
];

type CompareRow = { feature: string; us: string; them: string; themTone: 'no' | 'mid' };

const COMPARE_ROWS: CompareRow[] = [
  { feature: 'Data never leaves your device', us: 'Always', them: 'Uploaded by default', themTone: 'no' },
  { feature: 'AI that never sees your raw data', us: 'On-device + enclave', them: 'History sent to AI cloud', themTone: 'no' },
  { feature: 'Free tier, no account required', us: 'Free forever', them: 'Limited trials', themTone: 'mid' },
  { feature: 'Exchange auto-sync (read-only, deduped)', us: 'Included', them: 'Often a paid add-on', themTone: 'mid' },
  { feature: 'AI tax advisor', us: 'Built-in, private', them: 'Rare, cloud-only', themTone: 'no' },
  { feature: 'Derivatives & perpetuals support', us: 'Funding & fees split', them: 'Partial', themTone: 'mid' },
  { feature: 'India tax forms — Schedule VDA + TDS', us: 'Native, CA-ready', them: 'Generic exports', themTone: 'no' }
];

const FOOTER_RESOURCES = ['India VDA guide', 'TDS under 194S', 'Import your exchange', 'Help center'];

const FOOTER_LEGAL = ['Privacy promise', 'Terms', 'Security'];

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Every "start free" CTA lands on the mode chooser — unchanged behavior. */
function scrollToChoose() {
  scrollToId('choose');
}

/**
 * Static product illustration for the hero (presentational — not a live app).
 * Browser-chrome frame, privacy badges, net-worth chart, allocation bar and
 * the floating on-device AI note. The AI note copy is India-appropriate: a
 * TDS/Form 26AS credit reminder, never tax-loss harvesting (losses on VDAs
 * cannot offset gains under Section 115BBH).
 */
function HeroPreview() {
  return (
    <div className="relative min-w-0" aria-hidden="true">
      <div className="overflow-hidden rounded-[22px] border border-hi/10 bg-elev-1 shadow-pop lg:rotate-[0.4deg]">
        {/* Browser chrome — the whole app is this tab */}
        <div className="flex items-center gap-2 border-b border-hi/10 px-4 py-3">
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: 'var(--loss)' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: 'var(--warn)' }} />
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: 'var(--gain)' }} />
          <span className="ml-1.5 truncate font-mono text-[0.65625rem] text-faint">
            sololedger.app — this tab is the whole app
          </span>
          <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full border border-gain/30 bg-gain/10 px-2.5 py-1 font-mono text-[0.625rem] font-semibold text-gain">
            <span className="h-1.5 w-1.5 rounded-full bg-gain" />
            100% Local
          </span>
        </div>

        <div className="p-5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div>
              <div className="text-[0.6875rem] font-extrabold uppercase tracking-widest text-low">
                Total value · FY 2025–26
              </div>
              <div className="mt-1 font-display text-3xl font-extrabold tracking-tight text-hi tabular-figures">
                ₹42,18,940
              </div>
            </div>
            <span className="rounded-full bg-gain/10 px-2.5 py-1 text-xs font-extrabold text-gain tabular-figures">
              ▲ 15.45%
            </span>
          </div>

          <svg
            viewBox="0 0 520 110"
            preserveAspectRatio="none"
            className="mt-3 block h-[104px] w-full"
          >
            <defs>
              <linearGradient
                id="hero-chart-fill"
                x1="0"
                y1="0"
                x2="0"
                y2="110"
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="var(--primary)" stopOpacity="0.16" />
                <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d="M0 78 C40 74 60 58 100 62 C140 66 160 44 220 42 C280 40 300 58 360 52 C420 46 450 26 520 22 L520 110 0 110 Z"
              fill="url(#hero-chart-fill)"
            />
            <path
              d="M0 78 C40 74 60 58 100 62 C140 66 160 44 220 42 C280 40 300 58 360 52 C420 46 450 26 520 22"
              fill="none"
              stroke="var(--primary)"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <line
              x1="0"
              y1="70"
              x2="520"
              y2="70"
              stroke="var(--text-faint)"
              strokeWidth="1.3"
              strokeDasharray="6 6"
            />
            <circle
              cx="470"
              cy="30"
              r="4"
              fill="var(--primary)"
              stroke="var(--bg-elev-1)"
              strokeWidth="2"
            />
          </svg>

          <div className="mt-4 flex h-3 gap-0.5 overflow-hidden rounded-full">
            <span className="bg-primary" style={{ width: '46%' }} />
            <span className="bg-accent" style={{ width: '29%' }} />
            <span className="bg-gain" style={{ width: '10%' }} />
            <span className="bg-warn" style={{ width: '8%' }} />
            <span className="bg-loss" style={{ width: '5%' }} />
            <span className="bg-faint" style={{ width: '2%' }} />
          </div>

          <div className="mt-4 divide-y divide-hi/10">
            <div className="flex items-center gap-3 py-2.5">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-extrabold text-white"
                style={{ backgroundColor: '#F7931A' }}
              >
                ₿
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[0.8125rem] font-bold text-hi">Bitcoin</div>
                <div className="text-[0.6875rem] text-low tabular-figures">0.4821 BTC</div>
              </div>
              <div className="text-right">
                <div className="text-[0.8125rem] font-bold text-hi tabular-figures">₹28,15,166</div>
                <div className="text-[0.6875rem] font-bold text-gain tabular-figures">+48.8%</div>
              </div>
            </div>
            <div className="flex items-center gap-3 py-2.5">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-extrabold text-white"
                style={{ backgroundColor: '#627EEA' }}
              >
                Ξ
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[0.8125rem] font-bold text-hi">Ethereum</div>
                <div className="text-[0.6875rem] text-low tabular-figures">6.2408 ETH</div>
              </div>
              <div className="text-right">
                <div className="text-[0.8125rem] font-bold text-hi tabular-figures">₹19,02,214</div>
                <div className="text-[0.6875rem] font-bold text-gain tabular-figures">+65.7%</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Floating "0 bytes uploaded" chip */}
      <span className="absolute -right-1 top-16 inline-flex rotate-[1.5deg] items-center gap-1.5 rounded-full border border-gain/30 bg-elev-1 px-3 py-1.5 font-mono text-[0.625rem] font-semibold text-gain shadow-pop sm:-right-3 lg:-right-5">
        <span className="h-1.5 w-1.5 rounded-full bg-gain" />
        0 bytes uploaded
      </span>

      {/* Floating on-device AI note (aurora-bordered — the AI brand moment) */}
      <div
        className="mt-4 rounded-[18px] border border-transparent p-4 shadow-pop lg:absolute lg:-left-8 lg:bottom-10 lg:mt-0 lg:w-[280px] lg:-rotate-1"
        style={{
          background:
            'linear-gradient(var(--bg-elev-1), var(--bg-elev-1)) padding-box, var(--aurora) border-box'
        }}
      >
        <div className="flex items-center gap-1.5 text-[0.625rem] font-extrabold uppercase tracking-widest">
          <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span className="bg-aurora bg-clip-text text-transparent">AI advisor · on-device</span>
        </div>
        <p className="mt-2 text-[0.8125rem] font-bold leading-snug text-hi">
          ₹18,240 TDS deducted this FY — reconcile with Form 26AS so you don't lose the credit.
        </p>
        <p className="mt-1 text-[0.6875rem] text-low">Computed in this tab · nothing sent anywhere</p>
      </div>
    </div>
  );
}

export function LandingPage({ onSelectMode, onSignIn }: LandingPageProps) {
  // Local plan is account-free; every paid tier is a hosted plan → register.
  const handlePlan = (planId: PlanId) => onSelectMode(planId === 'local' ? 'local' : 'hosted');

  const [waitlistEmail, setWaitlistEmail] = useState('');
  const [waitlistJoined, setWaitlistJoined] = useState(false);

  // Auto-dismiss the waitlist confirmation toast.
  useEffect(() => {
    if (!waitlistJoined) return;
    const timer = setTimeout(() => setWaitlistJoined(false), 6000);
    return () => clearTimeout(timer);
  }, [waitlistJoined]);

  const handleWaitlistSubmit = (event: FormEvent<HTMLFormElement>) => {
    // Placeholder list — no backend call; acknowledge in place with a toast.
    event.preventDefault();
    setWaitlistEmail('');
    setWaitlistJoined(true);
  };

  return (
    <div className="min-h-screen bg-canvas text-hi">
      <header className="sticky top-0 z-30 border-b border-hi/10 bg-canvas/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3 lg:px-8">
          <a
            href="#top"
            aria-label="SoloLedger home"
            className="shrink-0"
            onClick={(e) => {
              e.preventDefault();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          >
            {/* Compact mark on narrow screens — the full lockup + tagline is
                too wide beside the header CTAs at 390px. */}
            <span className="sm:hidden" aria-hidden="true">
              <BrandLogo mode="mark" />
            </span>
            <span className="hidden sm:block">
              <BrandLogo variant="on-glass" />
            </span>
          </a>
          <nav aria-label="Primary" className="ml-2 hidden items-center gap-1 lg:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.id}
                href={`#${link.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  scrollToId(link.id);
                }}
                className="rounded-[10px] px-3 py-2 text-sm font-semibold text-mid transition-colors hover:bg-elev-3 hover:text-hi"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" onClick={onSignIn} className="hidden sm:inline-flex">
              Sign in
            </Button>
            <Button onClick={scrollToChoose} className="px-3.5 sm:px-5">
              Get started free
            </Button>
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
        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-6 pb-20 pt-14 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:pb-28 lg:pt-20">
          <div className="min-w-0">
            <span className="inline-flex max-w-full items-center gap-2 rounded-full border border-primary/25 bg-elev-1 py-1 pl-1 pr-3.5 text-[0.8125rem] font-bold text-primary shadow-xs">
              <span className="rounded-full bg-aurora px-2 py-0.5 text-[0.625rem] font-extrabold uppercase tracking-widest text-on-aurora">
                New
              </span>
              Exchange auto-sync · AI tax advisor · India Schedule VDA reports
            </span>
            <h1 className="mt-7 font-display text-5xl font-extrabold leading-[1.06] tracking-tight text-hi sm:text-6xl">
              Crypto taxes in minutes.{' '}
              <span className="bg-aurora bg-clip-text text-transparent">
                Nothing ever leaves your device.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-mid">
              SoloLedger imports from 200+ exchanges, wallets and chains, reviews every transaction
              with a private AI advisor, and exports filing-ready India tax reports — all inside
              your browser tab.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-y-3" aria-label="How it works">
              {HERO_STEPS.map((step, i) => (
                <span key={step} className="flex items-center">
                  {i > 0 && (
                    <ArrowRight className="mx-2.5 h-4 w-4 text-primary/40" aria-hidden="true" />
                  )}
                  <span className="inline-flex items-center gap-2.5 rounded-full border border-hi/10 bg-elev-1 py-1.5 pl-1.5 pr-4 text-sm font-bold text-hi shadow-xs">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-extrabold text-primary">
                      {i + 1}
                    </span>
                    {step}
                  </span>
                </span>
              ))}
            </div>
            <div className="mt-9 flex flex-wrap gap-3.5">
              <Button size="lg" onClick={scrollToChoose} className="px-7 text-base">
                Start free — no account needed
                <ArrowRight className="h-5 w-5" aria-hidden="true" />
              </Button>
              <Button
                size="lg"
                variant="secondary"
                onClick={() => scrollToId('new')}
                className="px-7 text-base"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                See how it works
              </Button>
            </div>
            <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-low">
              {HERO_CHECKMARKS.map((item) => (
                <span key={item} className="inline-flex items-center gap-1.5">
                  <Check className="h-4 w-4 text-gain" aria-hidden="true" />
                  {item}
                </span>
              ))}
            </div>
          </div>
          <HeroPreview />
        </div>
      </section>

      {/* Stats band (the 4.9★ rating stat is deliberately omitted) */}
      <section aria-label="Key numbers" className="border-y border-hi/10 bg-elev-1">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-6 py-10 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-hi/10 lg:px-8">
          {STATS.map((s) => (
            <div key={s.n} className="sm:px-8 sm:first:pl-0 sm:last:pr-0">
              <div className="font-display text-[2rem] font-extrabold leading-none tracking-tight text-hi tabular-figures">
                {s.n}
              </div>
              <div className="mt-2 max-w-[240px] text-sm leading-snug text-low">{s.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* What's new */}
      <section id="new" className="scroll-mt-24 py-24">
        <div className="mx-auto max-w-6xl px-6 lg:px-8">
          <div className="max-w-2xl">
            <div className="text-xs font-extrabold uppercase tracking-[0.14em] text-primary">
              New this season
            </div>
            <h2 className="mt-3 font-display text-4xl font-extrabold leading-[1.14] tracking-tight text-hi sm:text-[2.375rem]">
              Everything a filing season needs, finally in one private tab.
            </h2>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {WHATS_NEW.map((f) => (
              <div
                key={f.title}
                className="relative rounded-[20px] border border-hi/10 bg-elev-2 p-6 shadow-card transition duration-200 hover:-translate-y-1 hover:border-primary/30 hover:shadow-card-hover"
              >
                {f.isNew && (
                  <span className="absolute right-5 top-5 rounded-full bg-aurora px-2 py-0.5 text-[0.625rem] font-extrabold uppercase tracking-widest text-on-aurora">
                    New
                  </span>
                )}
                <span
                  className={cn(
                    'inline-flex h-11 w-11 items-center justify-center rounded-[13px] shadow-xs',
                    f.tile
                  )}
                >
                  <f.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-base font-extrabold tracking-tight text-hi">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-mid">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Privacy */}
      <section id="privacy" className="scroll-mt-24 border-y border-hi/10 bg-elev-1 py-24">
        <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 lg:grid-cols-2 lg:px-8">
          <div>
            <div className="text-xs font-extrabold uppercase tracking-[0.14em] text-primary">
              Privacy, verifiably
            </div>
            <h2 className="mt-3 font-display text-4xl font-extrabold leading-[1.14] tracking-tight text-hi sm:text-[2.375rem]">
              Your data never leaves your device.
            </h2>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-mid">
              SoloLedger is a full tax engine living in a browser tab. Imports, cost-basis math and
              PDF reports run 100% locally. The badge in the header is live — it tells you the
              exact moment anything changes, in words a human can check.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              {NET_STATES.map((s) => (
                <span
                  key={s.label}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 font-mono text-[0.6875rem] font-semibold',
                    s.tone
                  )}
                >
                  <span className="h-2 w-2 rounded-full bg-current" aria-hidden="true" />
                  {s.label}
                </span>
              ))}
            </div>
            <p className="mt-3.5 text-xs leading-relaxed text-low">
              One badge, three honest states. Network features are opt-in and every exit is
              disclosed in place.
            </p>
          </div>
          <div className="flex flex-col gap-3.5">
            {PRIVACY_CARDS.map((c) => (
              <div
                key={c.title}
                className="flex gap-4 rounded-2xl border border-hi/10 bg-elev-2 p-5 shadow-xs transition duration-200 hover:border-primary/30"
              >
                <span
                  className={cn(
                    'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-xs',
                    c.tile
                  )}
                >
                  <c.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <h3 className="text-sm font-extrabold text-hi">{c.title}</h3>
                  <p className="mt-1 text-[0.8125rem] leading-relaxed text-mid">{c.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Private AI */}
      <section id="private-ai" className="scroll-mt-24 py-24">
        <div className="mx-auto max-w-6xl px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="bg-aurora bg-clip-text text-xs font-extrabold uppercase tracking-[0.14em] text-transparent">
              Private AI
            </div>
            <h2 className="mt-3 font-display text-4xl font-extrabold leading-[1.14] tracking-tight text-hi sm:text-[2.375rem]">
              Your AI never sees your data.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-mid">
              Most tax AI works by uploading your entire trade history to someone else's cloud.
              SoloLedger's advisor is built the other way around — the intelligence comes to your
              data, never the reverse.
            </p>
          </div>
          <div className="mt-12 grid gap-4 lg:grid-cols-2">
            {AI_LANES.map((lane) => (
              <div
                key={lane.title}
                className="rounded-[20px] border border-hi/10 bg-elev-2 p-7 shadow-card"
              >
                <span
                  className={cn(
                    'inline-flex h-11 w-11 items-center justify-center rounded-[13px] shadow-xs',
                    lane.tile
                  )}
                >
                  <lane.icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-lg font-extrabold tracking-tight text-hi">{lane.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-mid">{lane.body}</p>
                <ul className="mt-4 flex flex-col gap-2.5">
                  {lane.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-2.5 text-sm text-mid">
                      <Check
                        className={cn('mt-0.5 h-4 w-4 shrink-0', lane.checkTone)}
                        aria-hidden="true"
                      />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            {AI_GUARANTEES.map((g) => (
              <div
                key={g.text}
                className="flex items-center gap-3 rounded-[14px] border border-primary/20 bg-primary/[0.06] px-4 py-3.5 text-[0.8125rem] font-semibold text-hi"
              >
                <g.icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                {g.text}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Compare */}
      <section id="compare" className="scroll-mt-24 pb-24">
        <div className="mx-auto max-w-6xl px-6 lg:px-8">
          <div className="mx-auto max-w-2xl text-center">
            <div className="text-xs font-extrabold uppercase tracking-[0.14em] text-primary">
              Why switch
            </div>
            <h2 className="mt-3 font-display text-4xl font-extrabold leading-[1.14] tracking-tight text-hi sm:text-[2.375rem]">
              SoloLedger vs typical cloud tax tools
            </h2>
            <p className="mt-4 text-base leading-relaxed text-mid">
              The category uploads your history by default and bills you per raw transaction. We
              built the opposite default.
            </p>
          </div>
          <div className="mx-auto mt-12 max-w-4xl overflow-x-auto">
            <div className="min-w-[640px] overflow-hidden rounded-[22px] border border-hi/10 bg-elev-2 shadow-card">
              <table
                className="w-full border-collapse text-sm"
                aria-label="SoloLedger compared to typical cloud tax tools"
              >
                <thead>
                  <tr className="bg-elev-3">
                    <th scope="col" className="px-6 py-4 text-left">
                      <span className="sr-only">Feature</span>
                    </th>
                    <th scope="col" className="bg-primary/[0.05] px-6 py-4">
                      <span className="flex items-center justify-center gap-2 text-[0.8125rem] font-extrabold text-hi">
                        <BrandLogo mode="mark" iconClassName="h-5 w-5" />
                        SoloLedger
                      </span>
                    </th>
                    <th
                      scope="col"
                      className="px-6 py-4 text-center text-[0.8125rem] font-bold text-low"
                    >
                      Typical cloud tools
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPARE_ROWS.map((row) => (
                    <tr key={row.feature} className="border-t border-hi/10">
                      <th scope="row" className="px-6 py-4 text-left font-semibold text-hi">
                        {row.feature}
                      </th>
                      <td className="bg-primary/[0.05] px-6 py-4">
                        <span className="flex items-center justify-center gap-2 font-bold text-gain">
                          <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
                          {row.us}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {row.themTone === 'mid' ? (
                          <span className="flex items-center justify-center gap-2 text-[0.8125rem] font-semibold text-warn">
                            {row.them}
                          </span>
                        ) : (
                          <span className="flex items-center justify-center gap-2 text-low">
                            <X className="h-4 w-4 shrink-0" aria-hidden="true" />
                            {row.them}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing — plans + the three-mode chooser, grouped under one nav anchor
          (content of both sections unchanged). */}
      <div id="pricing" className="scroll-mt-16">
        <ChoosePathSection onSelectMode={onSelectMode} />
        <LandingPlansSection onSelectPlan={handlePlan} />
      </div>

      {/* CTA — brand aurora band (ember → amber; label flips per theme) */}
      <section className="relative overflow-hidden bg-aurora">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
          style={{
            background:
              'radial-gradient(600px 300px at 20% 120%, rgba(255, 255, 255, 0.14), transparent 60%)'
          }}
        />
        <div className="relative mx-auto max-w-3xl px-6 py-24 text-center text-on-aurora lg:px-8">
          <h2 className="font-display text-4xl font-extrabold tracking-tight sm:text-[2.625rem]">
            Private. Precise. Yours.
          </h2>
          <p className="mt-3 text-lg text-on-aurora/85">
            Your taxes are your business. File them like it.
          </p>
          {/* Charcoal button holds AA on the ember (light) and peach (dark) bands. */}
          <button
            type="button"
            onClick={scrollToChoose}
            className="mt-9 inline-flex h-[52px] items-center justify-center gap-2 rounded-lg bg-[#171310] px-8 text-[0.9375rem] font-bold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-[#2C241D] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
          >
            Get started free — no account
            <ArrowRight className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-hi/10 bg-elev-1">
        <div className="mx-auto max-w-6xl px-6 lg:px-8">
          <div className="grid gap-10 py-16 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1.4fr]">
            <div>
              <BrandLogo variant="on-glass" showTagline={false} />
              <p className="mt-4 max-w-[280px] text-[0.8125rem] leading-relaxed text-mid">
                The private tax engine for crypto today — and for your whole balance sheet
                tomorrow.
              </p>
            </div>
            <nav aria-label="Product">
              <h3 className="text-[0.8125rem] font-extrabold tracking-wide text-hi">Product</h3>
              <ul className="mt-3.5 space-y-1">
                {NAV_LINKS.filter((link) => link.id !== 'compare').map((link) => (
                  <li key={link.id}>
                    <a
                      href={`#${link.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        scrollToId(link.id);
                      }}
                      className="inline-block py-1 text-[0.8125rem] text-mid transition-colors hover:text-primary"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <nav aria-label="Resources">
              <h3 className="text-[0.8125rem] font-extrabold tracking-wide text-hi">Resources</h3>
              <ul className="mt-3.5 space-y-1">
                {FOOTER_RESOURCES.map((label) => (
                  <li key={label}>
                    <a
                      href="#"
                      className="inline-block py-1 text-[0.8125rem] text-mid transition-colors hover:text-primary"
                    >
                      {label}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
            <div>
              <h3 className="text-[0.8125rem] font-extrabold tracking-wide text-hi">
                Full-wealth waitlist
              </h3>
              <p className="mt-3.5 text-[0.8125rem] leading-relaxed text-mid">
                Stocks, funds, deposits and more are coming. Be first when SoloLedger becomes your
                whole balance sheet.
              </p>
              <form className="mt-4 flex gap-2" onSubmit={handleWaitlistSubmit}>
                <Input
                  type="email"
                  required
                  value={waitlistEmail}
                  onChange={(e) => setWaitlistEmail(e.target.value)}
                  placeholder="you@example.in"
                  aria-label="Email for waitlist"
                  className="h-11 min-w-0 flex-1"
                />
                <Button type="submit" className="shrink-0">
                  Join
                </Button>
              </form>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-hi/10 py-6 text-xs text-low">
            <span>© 2026 SoloLedger. Private. Precise. Yours.</span>
            <span className="flex gap-5 sm:ml-auto">
              {FOOTER_LEGAL.map((label) => (
                <a key={label} href="#" className="transition-colors hover:text-primary">
                  {label}
                </a>
              ))}
            </span>
          </div>
        </div>
      </footer>

      <ToastViewport>
        {waitlistJoined && (
          <Toast
            tone="gain"
            title="You're on the list — we'll write when full-wealth launches"
            onDismiss={() => setWaitlistJoined(false)}
          />
        )}
      </ToastViewport>
    </div>
  );
}

