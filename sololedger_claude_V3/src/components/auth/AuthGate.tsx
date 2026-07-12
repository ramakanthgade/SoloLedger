import type { ReactNode } from 'react';
import { useAuth } from '@/lib/saas/authContext';

/** Pass-through guard for local mode; SaaS unauthenticated users are handled in App.tsx. */
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
  if (!user) return null;
  return <>{children}</>;
}
