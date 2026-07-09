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

interface AuthContextValue {
  saas: boolean;
  user: PublicUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const saas = isSaasMode();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(saas);

  const refresh = useCallback(async () => {
    if (!saas || !getAuthToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await fetchMe();
      setUser(me);
    } catch {
      setAuthToken(null);
      setUser(null);
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
    setUser(u);
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    const { token, user: u } = await apiRegister(email, password);
    setAuthToken(token);
    setUser(u);
  }, []);

  const logout = useCallback(() => {
    setAuthToken(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ saas, user, loading, login, register, logout, refresh }),
    [saas, user, loading, login, register, logout, refresh]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
