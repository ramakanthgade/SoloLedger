import type { ReactNode } from 'react';
import { useAuth } from '@/lib/saas/authContext';
import { LoginPanel } from './LoginPanel';

export function AuthGate({ children }: { children: ReactNode }) {
  const { saas, user, loading } = useAuth();

  if (!saas) return <>{children}</>;
  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-mist-400">
        Loading session…
      </div>
    );
  }
  if (!user) return <LoginPanel />;
  return <>{children}</>;
}
