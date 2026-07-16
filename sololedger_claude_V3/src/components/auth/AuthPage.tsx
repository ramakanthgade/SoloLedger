import { useState } from 'react';
import { ArrowLeft, Lock, Mail, Shield } from 'lucide-react';
import { useAuth } from '@/lib/saas/authContext';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type AuthPageProps = {
  initialMode?: 'login' | 'register';
  onBack?: () => void;
};

export function AuthPage({ initialMode = 'login', onBack }: AuthPageProps) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-base">
      <div className="pointer-events-none absolute -left-32 top-20 h-72 w-72 rounded-full bg-violet/20 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 bottom-10 h-80 w-80 rounded-full bg-blue/[0.16] blur-3xl" />
      <div className="pointer-events-none absolute left-1/2 top-1/3 h-64 w-64 -translate-x-1/2 rounded-full bg-teal/[0.14] blur-3xl" />

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-8 lg:flex-row lg:items-center lg:gap-16 lg:px-8">
        <div className="mb-10 flex-1 lg:mb-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-mid hover:text-hi"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to home
            </button>
          )}
          <div className="mb-6 lg:hidden">
            <BrandLogo variant="on-glass" />
          </div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-blue">Private crypto tax software</p>
          <h1 className="mt-3 font-display text-4xl font-bold leading-tight text-hi lg:text-5xl">
            {mode === 'login' ? 'Welcome back' : 'Start for free'}
          </h1>
          <p className="mt-4 max-w-md text-lg text-mid">
            Your transactions stay in your browser. We authenticate you and proxy wallet lookups — we never store your
            ledger.
          </p>
          <ul className="mt-8 space-y-3 text-sm text-mid">
            <li className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-blue" />
              Local-first — CSV import is 100% on-device
            </li>
            <li className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-blue" />
              Encrypted in transit · no wallet logging on our servers
            </li>
            <li className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-blue" />
              Free Starter tier — up to 100 transactions
            </li>
          </ul>
        </div>

        <div className="w-full max-w-md shrink-0">
          <div className="rounded-2xl border border-white/10 bg-elev-2 p-8 shadow-card-hover shadow-glow backdrop-blur-sm">
            <div className="mb-6 hidden lg:block">
              <BrandLogo variant="on-glass" showTagline={false} />
            </div>
            <h2 className="text-xl font-bold text-hi">{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
            <p className="mt-1 text-sm text-low">
              {mode === 'login' ? 'Access your private workspace' : 'No credit card required'}
            </p>

            <form onSubmit={submit} className="mt-6 space-y-4">
              <label className="block text-sm font-medium text-mid">
                Email
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1.5 block w-full rounded-xl border border-white/10 bg-elev-3 px-4 py-3 text-hi shadow-soft outline-none transition focus:border-violet/40 focus:ring-2 focus:ring-violet/30"
                  placeholder="you@email.com"
                />
              </label>
              <label className="block text-sm font-medium text-mid">
                Password
                <input
                  type="password"
                  required
                  minLength={8}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1.5 block w-full rounded-xl border border-white/10 bg-elev-3 px-4 py-3 text-hi shadow-soft outline-none transition focus:border-violet/40 focus:ring-2 focus:ring-violet/30"
                  placeholder="At least 8 characters"
                />
              </label>
              {error && (
                <p className="rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-sm text-loss">{error}</p>
              )}
              <Button
                type="submit"
                disabled={busy}
                className={cn(
                  'h-12 w-full rounded-xl text-base font-semibold',
                  'bg-aurora text-[#0A0B1A] hover:brightness-105'
                )}
              >
                {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create free account'}
              </Button>
            </form>

            <p className="mt-6 text-center text-sm text-mid">
              {mode === 'login' ? "Don't have an account?" : 'Already have an account?'}{' '}
              <button
                type="button"
                className="font-semibold text-blue underline-offset-2 hover:underline"
                onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
              >
                {mode === 'login' ? 'Get started free' : 'Sign in'}
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
