import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { LocalOnlyBadge } from '@/components/LocalOnlyBadge';
import { BrandLogo } from '@/components/BrandLogo';
import { db, deduplicateTransactions } from '@/lib/storage/db';
import { OnboardingFlow } from '@/components/onboarding/OnboardingFlow';
import { shouldShowOnboarding } from '@/components/onboarding/onboardingPredicate';
import { TabNavProvider } from '@/lib/tabNav';
import { DashboardTab } from '@/components/dashboard/DashboardTab';
import { ImportTab } from '@/components/import/ImportTab';
import { ReviewTab } from '@/components/review/ReviewTab';
import { CapitalGainsTab } from '@/components/capitalGains/CapitalGainsTab';
import { ReportsTab } from '@/components/reports/ReportsTab';
import { SettingsTab } from '@/components/settings/SettingsTab';
import { AdminPanel } from '@/components/settings/AdminPanel';
import { AiAdvisor } from '@/components/ai/AiAdvisor';
import { MobileTabBar } from '@/components/shell/MobileTabBar';
import { AuthPage } from '@/components/auth/AuthPage';
import { LandingPage } from '@/components/auth/LandingPage';
import { UserProfileMenu } from '@/components/auth/UserProfileMenu';
import { useAuth } from '@/lib/saas/authContext';
import { useAppMode } from '@/lib/saas/modeContext';
import { useImportJob } from '@/lib/importJob';
import {
  Link, ListChecks, LayoutDashboard, TrendingUp, FileText, Settings, Loader2, Shield
} from 'lucide-react';
import { SwitchModeButton } from '@/components/SwitchModeButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { cn } from '@/lib/utils';

/**
 * Primary nav — Ember & Slate shell (confirmed Variation A top-nav frame).
 * Live-feedback round: the Dashboard is the new home screen and absorbs the
 * Portfolio tab (PortfolioTab stays in the codebase, unrouted); "Review" is
 * relabeled "Transactions" at the shell level. Order: Dashboard · Connections
 * · Transactions · Capital Gains · Reports · Settings. The 'import'/'review'
 * ids stay stable so tab wiring, deep links and the TabNavProvider contract
 * are unchanged.
 */
const BASE_TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, component: DashboardTab },
  { id: 'import', label: 'Connections', icon: Link, component: ImportTab },
  { id: 'review', label: 'Transactions', icon: ListChecks, component: ReviewTab },
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
  const [active, setActive] = useState<TabId>('dashboard');
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
  // Latch: once the empty-ledger gate opens onboarding, keep it mounted until
  // the user finishes or skips. The guided wizard's multi-file batch saves the
  // FIRST file before the last — flipping txCount 0→N — and a reactive gate
  // would unmount the wizard mid-batch, silently stranding the queued files
  // (only the first file landed in the ledger). The wizard defers its
  // onComplete to the end of the batch precisely so this latch can hold.
  const [onboardingActive, setOnboardingActive] = useState(false);
  useEffect(() => {
    if (shouldShowOnboarding(txCount)) setOnboardingActive(true);
  }, [txCount]);

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

  if (!onboardingDismissed && onboardingActive) {
    return (
      <OnboardingFlow
        onDone={() => {
          setOnboardingActive(false);
          setOnboardingDismissed(true);
        }}
        onSkip={() => {
          setActive('dashboard');
          setOnboardingActive(false);
          setOnboardingDismissed(true);
        }}
      />
    );
  }

  return (
    <TabNavProvider
      value={{
        goToImport: () => setActive('import'),
        goTo: (tabId) => {
          if (tabs.some((t) => t.id === tabId)) setActive(tabId as TabId);
        }
      }}
    >
    <div className="min-h-screen bg-canvas" key={user?.id ?? 'guest'}>
      {/* Skip link — first tab stop, revealed on focus (shell mockup `.skiplink`). */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-[80] focus:rounded-lg focus:bg-hi focus:px-4 focus:py-2.5 focus:text-sm focus:font-bold focus:text-canvas focus:shadow-pop"
      >
        Skip to main content
      </a>

      {/* App shell — confirmed Variation A: one sticky top bar carrying the
       * brand lockup, the primary tablist, and the privacy/theme/account
       * cluster. Layering: shell z-40 < advisor z-50 < dialogs z-[60] < toasts z-[70]. */}
      <header className="sticky top-0 z-40 border-b border-hi/10 bg-canvas/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[90rem] items-center gap-2 px-4 sm:px-6 lg:px-8">
          {/* Top-bar overlap fix: the wordmark drops below xl so the six tabs
           * always fit — the brand mark alone carries the header at mid widths.
           * The desktop tablist only appears at lg+ (where all six tabs always
           * fit, pill compact); below lg the mobile bottom bar takes over, so
           * tabs never clip at any width. */}
          <div className="shrink-0 [&>div>div]:hidden xl:[&>div>div]:flex">
            <BrandLogo variant="on-glass" showTagline={false} className="gap-2.5" />
          </div>
          <nav
            role="tablist"
            aria-label="Sections"
            className="hidden min-w-0 flex-1 items-center gap-1 overflow-x-auto lg:flex"
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
                    'flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 text-sm font-bold transition-colors xl:px-3',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-low hover:bg-elev-3 hover:text-hi'
                  )}
                >
                  {/* Icons yield to labels below 2xl — tabs never clip,
                   * even with the widest ("Local + relay") privacy pill. */}
                  <Icon className="hidden h-4 w-4 2xl:block" aria-hidden="true" />
                  {tab.label}
                </button>
              );
            })}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <LocalOnlyBadge />
            <ThemeToggle />
            <SwitchModeButton className="hidden lg:inline-flex" />
            <UserProfileMenu onOpenSettings={() => setActive('settings')} />
          </div>
        </div>
      </header>

      {importState.active && (
        <div className="sticky top-16 z-30 border-b border-primary/20 bg-primary/10 px-6 py-2.5 backdrop-blur-md">
          <div className="mx-auto flex max-w-7xl items-center gap-3">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
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

      {/* pb-28 clears the fixed mobile tab bar + AI FAB on small screens. */}
      <main id="main-content" className="mx-auto max-w-7xl px-6 pt-10 pb-28 lg:pb-10 lg:px-8">
        <div
          role="tabpanel"
          id={`tabpanel-${active}`}
          aria-labelledby={`tab-${active}`}
          tabIndex={0}
          className="focus:outline-none"
        >
          {deduping ? (
            <div aria-busy="true" className="flex items-center gap-3 text-sm text-low">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              Tidying up your transactions (removing duplicates)…
            </div>
          ) : (
            <ActiveComponent />
          )}
        </div>
      </main>

      <MobileTabBar tabs={tabs} active={active} onSelect={setActive} />
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
