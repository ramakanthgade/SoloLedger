import { useState } from 'react';
import { LocalOnlyBadge } from '@/components/LocalOnlyBadge';
import { ImportTab } from '@/components/import/ImportTab';
import { ReviewTab } from '@/components/review/ReviewTab';
import { PortfolioTab } from '@/components/portfolio/PortfolioTab';
import { CapitalGainsTab } from '@/components/capitalGains/CapitalGainsTab';
import { ReportsTab } from '@/components/reports/ReportsTab';
import { SettingsTab } from '@/components/settings/SettingsTab';
import { AiAdvisor } from '@/components/ai/AiAdvisor';
import { useImportJob } from '@/lib/importJob';
import { Upload, ListChecks, PieChart, TrendingUp, FileText, Settings, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const TABS = [
  { id: 'import', label: 'Import', icon: Upload, component: ImportTab, accent: 'violet' },
  { id: 'review', label: 'Review', icon: ListChecks, component: ReviewTab, accent: 'emerald' },
  { id: 'portfolio', label: 'Portfolio', icon: PieChart, component: PortfolioTab, accent: 'gold' },
  { id: 'capital-gains', label: 'Capital Gains', icon: TrendingUp, component: CapitalGainsTab, accent: 'emerald' },
  { id: 'reports', label: 'Reports', icon: FileText, component: ReportsTab, accent: 'pink' },
  { id: 'settings', label: 'Settings', icon: Settings, component: SettingsTab, accent: 'mist' }
] as const;

type TabId = (typeof TABS)[number]['id'];

const ACCENT_ACTIVE: Record<string, string> = {
  violet: 'bg-violet text-white shadow-pop',
  emerald: 'bg-emerald text-ink-950 shadow-pop',
  gold: 'bg-gold text-ink-950 shadow-pop',
  pink: 'bg-pink text-white shadow-pop',
  mist: 'bg-mist text-white shadow-pop'
};

const PHASE_LABEL: Record<string, string> = {
  importing: 'Importing transactions',
  classifying: 'Classifying swaps (Noves)',
  pricing: 'Fetching prices'
};

export default function App() {
  const [active, setActive] = useState<TabId>('import');
  const ActiveComponent = TABS.find((t) => t.id === active)!.component;
  const importState = useImportJob();

  return (
    <div className="min-h-screen bg-ink">
      <header className="border-b border-ink-700 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-baseline gap-2">
            <span className="font-display text-xl font-semibold text-violet">SoloLedger</span>
            <span className="hidden text-xs text-mist-400 sm:inline">crypto taxes, sorted</span>
          </div>
          <LocalOnlyBadge />
        </div>
        <nav className="mx-auto flex max-w-6xl flex-wrap gap-2 px-4 pb-3">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.id === active;
            return (
              <button
                key={tab.id}
                onClick={() => setActive(tab.id)}
                className={cn(
                  'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all hover:scale-[1.03] active:scale-95',
                  isActive ? ACCENT_ACTIVE[tab.accent] : 'text-mist-400 hover:bg-ink-700/60 hover:text-mist'
                )}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>

      {/* Persistent import progress bar — visible on all tabs */}
      {importState.active && (
        <div className="sticky top-0 z-40 border-b border-violet/20 bg-violet/10 px-6 py-2">
          <div className="mx-auto flex max-w-6xl items-center gap-3">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-violet" />
            <span className="text-sm text-mist">
              {PHASE_LABEL[importState.phase] ?? 'Working'}
              {importState.progress
                ? ` — ${importState.progress.done}/${importState.progress.total}`
                : '…'}
            </span>
            <span className="text-xs text-mist-400">
              {importState.chainLabel} {importState.addresses.slice(0, 2).map(a => `${a.slice(0,6)}…`).join(', ')}
            </span>
            <span className="ml-auto text-xs text-mist-400">You can keep browsing — this runs in the background</span>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-6xl px-6 py-8">
        <ActiveComponent />
      </main>

      <AiAdvisor />
    </div>
  );
}
