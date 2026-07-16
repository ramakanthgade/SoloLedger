import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LocalOnlyBadge } from '@/components/LocalOnlyBadge';
import { BrandLogo } from '@/components/BrandLogo';
import { db, deduplicateTransactions } from '@/lib/storage/db';
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow';
import { shouldShowOnboarding } from '@/components/onboarding/onboardingPredicate';
import { TabNavProvider } from '@/lib/tabNav';
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
import { useAppMode } from '@/lib/saas/modeContext';
import { useImportJob } from '@/lib/importJob';
import {
  Upload, ListChecks, PieChart, TrendingUp, FileText, Settings, Loader2, Shield
} from 'lucide-react';
import { SwitchModeButton } from '@/components/SwitchModeButton';
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

const PHASE_LABEL: Record<string, string> = {
  importing: 'Importing transactions',
  classifying: 'Classifying swaps (Noves)',
  pricing: 'Fetching prices'
};

function LoadingScreen({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-low">
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
  const [deduping, setDeduping] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // First-run onboarding gate (Task T3): show onboarding whenever the local
  // ledger is empty (0 transactions), not behind a one-time flag — so a
  // returning-but-empty user still gets help. `onboardingDismissed` lets a user
  // who exits the flow without importing reach the main app for this session.
  const txCount = useLiveQuery(() => db.transactions.count(), []);
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);

  useEffect(() => {
    const key = `sololedger_dedup_session_${user?.id ?? 'local'}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    setDeduping(true);
    void deduplicateTransactions().finally(() => setDeduping(false));
  }, [user?.id]);

  // Roving-tabindex arrow-key navigation across the tablist.
  const handleTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    const count = tabs.length;
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % count;
    else if (e.key === 'ArrowLeft') next = (index - 1 + count) % count;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    else return;
    e.preventDefault();
    const nextTab = tabs[next];
    setActive(nextTab.id);
    tabRefs.current[next]?.focus();
  };

  if (!dbReady) {
    return <LoadingScreen message="Loading your workspace…" />;
  }

  if (!onboardingDismissed && shouldShowOnboarding(txCount)) {
    return (
      <OnboardingFlow
        onDone={() => setOnboardingDismissed(true)}
        onSkip={() => setOnboardingDismissed(true)}
      />
    );
  }

  return (
    <TabNavProvider value={{ goToImport: () => setActive('import') }}>
    <div className="min-h-screen bg-canvas" key={user?.id ?? 'guest'}>
      <header className="relative z-50 border-b border-white/10 bg-elev-1/60 backdrop-blur-xl shadow-soft">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4 lg:px-8">
          <BrandLogo variant="on-glass" />
          <div className="flex items-center gap-3">
            <LocalOnlyBadge />
            <SwitchModeButton />
            <UserProfileMenu onOpenSettings={() => setActive('settings')} />
          </div>
        </div>
      </header>

      <div className="border-b border-white/10 bg-elev-1/40 backdrop-blur-md">
        <nav
          role="tablist"
          aria-label="Sections"
          className="mx-auto flex max-w-5xl gap-0 overflow-x-auto px-4 lg:px-6"
        >
          {tabs.map((tab, i) => {
            const Icon = tab.icon;
            const isActive = tab.id === active;
            return (
              <button
                key={tab.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={isActive}
                aria-controls={`tabpanel-${tab.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => setActive(tab.id)}
                onKeyDown={(e) => handleTabKeyDown(e, i)}
                className={cn(
                  'relative flex min-h-[44px] shrink-0 items-center gap-2 px-4 py-3.5 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet/40',
                  isActive
                    ? 'text-hi'
                    : 'text-low hover:text-mid'
                )}
              >
                <Icon className={cn('h-4 w-4 transition-colors', isActive ? 'text-teal' : 'text-low')} />
                {tab.label}
                {isActive && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-aurora shadow-glow" />
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {importState.active && (
        <div className="sticky top-0 z-40 border-b border-violet/20 bg-violet/10 backdrop-blur-md px-6 py-2.5">
          <div className="mx-auto flex max-w-5xl items-center gap-3">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-teal" />
            <span className="text-sm text-mid">
              {PHASE_LABEL[importState.phase] ?? 'Working'}
              {importState.progress
                ? ` — ${importState.progress.done}/${importState.progress.total}`
                : '…'}
            </span>
            <span className="text-xs text-low">
              {importState.chainLabel}{' '}
              {importState.addresses.slice(0, 2).map((a) => `${a.slice(0, 6)}…`).join(', ')}
            </span>
            <span className="ml-auto hidden text-xs text-low sm:inline">
              You can keep browsing — this runs in the background
            </span>
          </div>
        </div>
      )}

      <main
        role="tabpanel"
        id={`tabpanel-${active}`}
        aria-labelledby={`tab-${active}`}
        tabIndex={0}
        className="mx-auto max-w-5xl px-6 py-10 focus:outline-none lg:px-8"
      >
        {deduping ? (
          <div aria-busy="true" className="flex items-center gap-3 text-sm text-low">
            <Loader2 className="h-4 w-4 animate-spin text-teal" />
            Tidying up your transactions (removing duplicates)…
          </div>
        ) : (
          <ActiveComponent />
        )}
      </main>

      <AiAdvisor />
    </div>
    </TabNavProvider>
  );
}

export default function App() {
  const { user, loading } = useAuth();
  const { phase, mode, selectMode, backToLanding } = useAppMode();
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');

  // Everyone first sees the landing page until they pick a path.
  if (phase === 'landing') {
    return (
      <LandingPage
        onSelectMode={selectMode}
        onSignIn={() => {
          setAuthMode('login');
          selectMode('hosted');
        }}
      />
    );
  }

  // Hosted requires an account before entering the app. The second clause is a
  // defensive guard for a resumed hosted session whose token is still loading.
  if (phase === 'auth' || (mode === 'hosted' && !user)) {
    if (loading) return <LoadingScreen message="Loading session…" />;
    if (!user) return <AuthPage initialMode={authMode} onBack={backToLanding} />;
  }

  // Local / BYOK (and authenticated hosted): drop into the app.
  return <MainApp />;
}
