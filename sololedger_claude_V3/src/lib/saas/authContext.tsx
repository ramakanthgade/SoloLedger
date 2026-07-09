import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isSaasMode } from './config';
import {
  fetchMe,
  login as apiLogin,
  register as apiRegister,
  setAuthToken,
  getAuthToken,
  type PublicUser
} from './api';
import { switchUserDatabase } from '@/lib/storage/db';

interface AuthContextValue {
  saas: boolean;
  user: PublicUser | null;
  loading: boolean;
  dbReady: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function bindUserSession(u: PublicUser | null): Promise<void> {
  if (!isSaasMode()) return;
  await switchUserDatabase(u?.id ?? null);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const saas = isSaasMode();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(saas);
  const [dbReady, setDbReady] = useState(!saas);

  const refresh = useCallback(async () => {
    if (!saas || !getAuthToken()) {
      await bindUserSession(null);
      setUser(null);
      setDbReady(true);
      setLoading(false);
      return;
    }
    try {
      const me = await fetchMe();
      await bindUserSession(me);
      setUser(me);
      setDbReady(true);
    } catch {
      setAuthToken(null);
      await bindUserSession(null);
      setUser(null);
      setDbReady(true);
    } finally {
      setLoading(false);
    }
  }, [saas]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: u } = await apiLogin(email, password);
    setAuthToken(token);
    await bindUserSession(u);
    setUser(u);
    setDbReady(true);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const { token, user: u } = await apiRegister(email, password);
    setAuthToken(token);
    await bindUserSession(u);
    setUser(u);
    setDbReady(true);
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setUser(null);
    setDbReady(false);
    void bindUserSession(null).then(() => {
      setDbReady(true);
      const base = import.meta.env.BASE_URL || '/';
      window.location.assign(base);
    });
  }, []);

  const value = useMemo(
    () => ({ saas, user, loading, dbReady, login, register, logout, refresh }),
    [saas, user, loading, dbReady, login, register, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
