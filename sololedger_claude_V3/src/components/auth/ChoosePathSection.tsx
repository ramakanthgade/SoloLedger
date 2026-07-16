import {
  Check,
  CloudUpload,
  Info,
  Key,
  Lock,
  Users,
  ArrowRight
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppMode } from '@/lib/saas/mode';

type ChoosePathSectionProps = {
  onSelectMode: (mode: AppMode) => void;
};

type Bullet = { text: string; tone: 'ck' | 'info' };

type PathCard = {
  mode: AppMode;
  num: string;
  icon: LucideIcon;
  iconGradient: string;
  tag: string;
  title: string;
  value: string;
  bullets: Bullet[];
  cta: string;
  featured?: boolean;
};

const CARDS: PathCard[] = [
  {
    mode: 'local',
    num: '01',
    icon: Lock,
    iconGradient: 'from-teal to-blue',
    tag: '100% local',
    title: 'Do it yourself',
    value:
      'Everything runs in your browser. No account, no keys — your data never leaves your device.',
    bullets: [
      { text: 'CSV import & all tax math run fully on-device', tone: 'ck' },
      { text: 'Best privacy — nothing is uploaded', tone: 'ck' },
      { text: 'Wallet lookup & live prices need a network call', tone: 'info' }
    ],
    cta: 'Start locally — free'
  },
  {
    mode: 'byok',
    num: '02',
    icon: Key,
    iconGradient: 'from-violet to-blue',
    tag: 'Bring your own keys',
    title: 'BYOK',
    value:
      'Paste your own API keys. Data flows straight from your browser to your providers — SoloLedger is never in the middle.',
    bullets: [
      { text: 'Alchemy · Helius · Moralis for wallet data', tone: 'ck' },
      { text: 'CoinGecko · Birdeye pricing, plus your AI key', tone: 'ck' },
      { text: 'You control usage & billing at the source', tone: 'ck' }
    ],
    cta: 'Use my keys'
  },
  {
    mode: 'hosted',
    num: '03',
    icon: CloudUpload,
    iconGradient: 'from-blue to-teal',
    tag: 'Hosted · Managed',
    title: 'Let SoloLedger do it',
    value:
      'No keys to manage. Upload CSVs or wallet addresses — we handle lookups & pricing on our secure proxy.',
    bullets: [
      { text: 'Zero setup — no API keys to find or paste', tone: 'ck' },
      { text: 'We never log your data or tax details', tone: 'ck' },
      { text: 'Plans scale with your taxable events', tone: 'ck' }
    ],
    cta: 'Create account',
    featured: true
  }
];

export function ChoosePathSection({ onSelectMode }: ChoosePathSectionProps) {
  return (
    <section
      id="choose"
      className="relative border-y border-white/[0.06] py-20"
      style={{
        backgroundImage:
          'radial-gradient(1200px 460px at 82% -10%, rgba(124,92,255,.12), transparent 60%), radial-gradient(900px 460px at 0% 10%, rgba(34,225,195,.08), transparent 55%)'
      }}
    >
      <div className="mx-auto max-w-6xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet/15 px-3 py-1 text-xs font-extrabold uppercase tracking-wide text-blue">
            Choose your path
          </span>
          <h2 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-hi sm:text-5xl">
            Choose how you want to use SoloLedger
          </h2>
          <p className="mt-4 text-lg text-mid">
            One app, three ways to run it. Start account-free and keep everything local, or let us
            handle the heavy lifting.
          </p>
        </div>

        {/* Group labels: Account-free (01+02) vs Hosted (03) */}
        <div className="mx-auto mt-11 hidden max-w-6xl grid-cols-[2fr_1fr] items-end gap-5 lg:grid">
          <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-widest text-gain">
            <Lock className="h-3.5 w-3.5" />
            Account-free
            <span className="h-px flex-1 bg-current opacity-30" />
          </div>
          <div className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-widest text-violet">
            <Users className="h-3.5 w-3.5" />
            Hosted
            <span className="h-px flex-1 bg-current opacity-30" />
          </div>
        </div>

        <div className="mt-4 grid items-stretch gap-5 md:grid-cols-3">
          {CARDS.map((card) => {
            const Icon = card.icon;
            return (
              <div
                key={card.mode}
                data-testid={`path-card-${card.mode}`}
                className={cn(
                  'relative flex flex-col rounded-[20px] border p-7 shadow-card transition duration-300 hover:-translate-y-1.5 hover:shadow-card-hover',
                  card.featured
                    ? 'stat-card-featured border-violet/40'
                    : 'border-white/10 bg-elev-2 hover:border-violet/40'
                )}
              >
                {card.featured && (
                  <span className="absolute -top-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-gradient-to-r from-violet to-blue px-3.5 py-1 text-[0.66rem] font-extrabold uppercase tracking-wide text-[#0A0B1A] shadow-glow">
                    <Users className="h-3 w-3" />
                    Sign-in required
                  </span>
                )}
                <span className="absolute right-6 top-6 text-sm font-extrabold text-faint">
                  {card.num}
                </span>

                <div className="flex items-start justify-between gap-3">
                  <div
                    className={cn(
                      'inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br text-[#0A0B1A] shadow-soft',
                      card.iconGradient
                    )}
                  >
                    <Icon className="h-7 w-7" />
                  </div>
                  {card.featured ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-warn/[0.18] px-2.5 py-1 text-[0.68rem] font-extrabold uppercase tracking-wide text-warn">
                      <Lock className="h-3 w-3" />
                      Requires an account
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-gain/[0.16] px-2.5 py-1 text-[0.68rem] font-extrabold uppercase tracking-wide text-gain">
                      <Check className="h-3 w-3" />
                      No account
                    </span>
                  )}
                </div>

                <div className="mt-5 text-xs font-extrabold uppercase tracking-wider text-blue">
                  {card.tag}
                </div>
                <h3 className="mt-1 font-display text-2xl font-extrabold tracking-tight text-hi">
                  {card.title}
                </h3>
                <p className="mt-2.5 text-[0.98rem] leading-relaxed text-mid">{card.value}</p>

                <ul className="mt-4 flex flex-1 flex-col gap-2.5">
                  {card.bullets.map((b) => (
                    <li key={b.text} className="flex items-start gap-2.5 text-sm leading-snug text-mid">
                      {b.tone === 'info' ? (
                        <Info className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                      ) : (
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-gain" />
                      )}
                      <span>{b.text}</span>
                    </li>
                  ))}
                </ul>

                <button
                  type="button"
                  onClick={() => onSelectMode(card.mode)}
                  className={cn(
                    'mt-6 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full text-sm font-bold transition',
                    card.featured
                      ? 'bg-gradient-to-r from-violet to-blue text-[#0A0B1A] shadow-glow hover:brightness-105'
                      : 'border border-white/10 bg-white/[0.03] text-hi hover:border-violet/50 hover:bg-violet/[0.08]'
                  )}
                >
                  {card.cta}
                  {card.featured && <ArrowRight className="h-4 w-4" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
