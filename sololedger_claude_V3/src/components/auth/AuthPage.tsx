import { useState } from 'react';
import { ArrowLeft, Eye, EyeOff, Lock, Mail, Shield } from 'lucide-react';
import { useAuth } from '@/lib/saas/authContext';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type PasswordFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  placeholder: string;
};

/**
 * Password input with a built-in reveal toggle. Defaults to masked
 * (type="password") and only reveals on explicit click. Owns its own reveal
 * state so multiple fields (password + confirm) stay independent; the eye
 * button's accessible name is derived from `label` so the two toggles are
 * distinguishable to screen readers.
 */
function PasswordField({ label, value, onChange, autoComplete, placeholder }: PasswordFieldProps) {
  const [show, setShow] = useState(false);
  const action = show ? 'Hide' : 'Show';
  return (
    <label className="block text-sm font-medium text-mid">
      {label}
      <div className="relative mt-1.5">
        <input
          type={show ? 'text' : 'password'}
          required
          minLength={8}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="block w-full rounded-xl border border-white/10 bg-elev-3 px-4 py-3 pr-12 text-hi shadow-soft outline-none transition focus:border-violet/40 focus:ring-2 focus:ring-violet/30"
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={`${action} ${label.toLowerCase()}`}
          aria-pressed={show}
          className="absolute inset-y-0 right-0 flex items-center px-3 text-mid transition hover:text-hi"
        >
          {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
        </button>
      </div>
    </label>
  );
}

type AuthPageProps = {
  initialMode?: 'login' | 'register';
  onBack?: () => void;
};

export function AuthPage({ initialMode = 'login', onBack }: AuthPageProps) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isRegister = mode === 'register';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isRegister && password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isRegister) await register(email, password);
      else await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  const switchMode = () => {
    setMode(isRegister ? 'login' : 'register');
    setError(null);
    setEmail('');
    setPassword('');
    setConfirmPassword('');
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-canvas">
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
            {isRegister ? 'Start for free' : 'Welcome back'}
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
            <h2 className="text-xl font-bold text-hi">{isRegister ? 'Create account' : 'Sign in'}</h2>
            <p className="mt-1 text-sm text-low">
              {isRegister ? 'No credit card required' : 'Access your private workspace'}
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
              <PasswordField
                label="Password"
                value={password}
                onChange={setPassword}
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                placeholder="At least 8 characters"
              />
              {isRegister && (
                <PasswordField
                  label="Confirm password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  autoComplete="new-password"
                  placeholder="Re-enter your password"
                />
              )}
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
                {busy ? 'Please wait…' : isRegister ? 'Create free account' : 'Sign in'}
              </Button>
            </form>

            <p className="mt-6 text-center text-sm text-mid">
              {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
              <button
                type="button"
                className="font-semibold text-blue underline-offset-2 hover:underline"
                onClick={switchMode}
              >
                {isRegister ? 'Sign in' : 'Get started free'}
              </button>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
