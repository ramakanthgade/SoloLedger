import { useEffect, useState } from 'react';
import { LocalOnlyBadge } from '@/components/LocalOnlyBadge';
import { BrandLogo } from '@/components/BrandLogo';
import { deduplicateTransactions } from '@/lib/storage/db';
import { ImportTab } from '@/components/import/ImportTab';
import { ReviewTab } from '@/components/review/ReviewTab';
import { PortfolioTab } from '@/components/portfolio/PortfolioTab';
import { CapitalGainsTab } from '@/components/capitalGains/CapitalGainsTab';
import { ReportsTab } from '@/components/reports/ReportsTab';
import { SettingsTab } from '@/components/settings/SettingsTab';
import { AdminPanel } from '@/components/settings/AdminPanel';
import { AiAdvisor } from '@/components/ai/AiAdvisor';
import { AuthPage } from '@/components/auth/AuthPage';
import { LandingPage } from '@/components/auth/LandingPage';
import { UserProfileMenu } from '@/components/auth/UserProfileMenu';
import { useAuth } from '@/lib/saas/authContext';
import { isSaasMode } from '@/lib/saas/config';
import { useImportJob } from '@/lib/importJob';
import {
  Upload, ListChecks, PieChart, TrendingUp, FileText, Settings, Loader2, Shield
} from 'lucide-react';
import { cn } from '@/lib/utils';

const BASE_TABS = [
  { id: 'import', label: 'Import', icon: Upload, component: ImportTab },
  { id: 'review', label: 'Review', icon: ListChecks, component: ReviewTab },
  { id: 'portfolio', label: 'Portfolio', icon: PieChart, component: PortfolioTab },
  { id: 'capital-gains', label: 'Capital Gains', icon: TrendingUp, component: CapitalGainsTab },
  { id: 'reports', label: 'Reports', icon: FileText, component: ReportsTab },
  { id: 'settings', label: 'Settings', icon: Settings, component: SettingsTab }
] as const;

const ADMIN_TAB = { id: 'admin', label: 'Admin', icon: Shield, component: AdminPanel } as const;

type TabId = (typeof BASE_TABS)[number]['id'] | typeof ADMIN_TAB.id;
type PublicView = 'landing' | 'login' | 'register';

const PHASE_LABEL: Record<string, string> = {
  importing: 'Importing transactions',
  classifying: 'Classifying swaps (Noves)',
  pricing: 'Fetching prices'
};

function LoadingScreen({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink text-sm text-mist-400">
      {message}
    </div>
  );
}

function MainApp() {
  const { user, dbReady } = useAuth();
  const tabs = user?.role === 'admin' ? [...BASE_TABS, ADMIN_TAB] : BASE_TABS;
  const [active, setActive] = useState<TabId>('import');
  const ActiveComponent = tabs.find((t) => t.id === active)!.component;
  const importState = useImportJob();

  useEffect(() => {
    const key = `sololedger_dedup_session_${user?.id ?? 'local'}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    void deduplicateTransactions();
  }, [user?.id]);

  if (!dbReady) {
    return <LoadingScreen message="Loading your workspace…" />;
  }

  return (
    <div className="min-h-screen bg-ink" key={user?.id ?? 'guest'}>
      <header className="bg-gradient-to-br from-navy via-navy-800 to-navy-700">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4 lg:px-8">
          <BrandLogo variant="light" />
          <div className="flex items-center gap-3">
            <LocalOnlyBadge />
            <UserProfileMenu onOpenSettings={() => setActive('settings')} />
          </div>
        </div>
      </header>

      <div className="border-b border-ink-700 bg-ink-800/95 shadow-sm backdrop-blur-sm">
        <nav className="mx-auto flex max-w-5xl gap-0 overflow-x-auto px-4 lg:px-6">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = tab.id === active;
            return (
              <button
                key={tab.id}
                onClick={() => setActive(tab.id)}
                className={cn(
                  'flex shrink-0 items-center gap-2 border-b-2 px-4 py-3.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-emerald text-ink-950'
                    : 'border-transparent text-mist-400 hover:text-mist'
                )}
              >
                <Icon className={cn('h-4 w-4', isActive && 'text-emerald-600')} />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {importState.active && (
        <div className="sticky top-0 z-40 border-b border-emerald/20 bg-teal-50 px-6 py-2.5">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-600" />
            <span className="text-sm text-mist">
              {PHASE_LABEL[importState.phase] ?? 'Working'}
              {importState.progress
                ? ` — ${importState.progress.done}/${importState.progress.total}`
                : '…'}
            </span>
            <span className="text-xs text-mist-400">
              {importState.chainLabel}{' '}
              {importState.addresses.slice(0, 2).map((a) => `${a.slice(0, 6)}…`).join(', ')}
            </span>
            <span className="ml-auto hidden text-xs text-mist-400 sm:inline">
              You can keep browsing — this runs in the background
            </span>
          </div>
        </div>
      )}

      <main className="mx-auto max-w-5xl px-6 py-10 lg:px-8">
        <ActiveComponent />
      </main>

      <AiAdvisor />
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const saas = isSaasMode();
  const [publicView, setPublicView] = useState<PublicView>('landing');

  useEffect(() => {
    if (saas && !user && !loading) setPublicView('landing');
  }, [saas, user, loading]);

  if (saas) {
    if (loading) return <LoadingScreen message="Loading session…" />;
    if (!user) {
      if (publicView === 'landing') {
        return (
          <LandingPage
            onSignIn={() => setPublicView('login')}
            onGetStarted={() => setPublicView('register')}
          />
        );
      }
      return (
        <AuthPage
          initialMode={publicView === 'register' ? 'register' : 'login'}
          onBack={() => setPublicView('landing')}
        />
      );
    }
    return <MainApp />;
  }

  return <MainApp />;
}
