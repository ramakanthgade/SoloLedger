import { createContext, useContext } from 'react';

/**
 * Lets any tab's empty-state CTA route the user back to the Import tab — the
 * single source of all data (Task T3). Provided by `App.tsx`; defaults to a
 * no-op so components render safely outside the app shell (e.g. in tests).
 */
export interface TabNav {
  goToImport: () => void;
}

const TabNavContext = createContext<TabNav>({ goToImport: () => {} });

export function TabNavProvider({
  value,
  children
}: {
  value: TabNav;
  children: React.ReactNode;
}) {
  return <TabNavContext.Provider value={value}>{children}</TabNavContext.Provider>;
}

export function useTabNav(): TabNav {
  return useContext(TabNavContext);
}
