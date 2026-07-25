import { useState } from 'react';
import { AlertCircle, ArrowLeft, Eye, EyeOff, Lock, Mail, Shield } from 'lucide-react';
import { useAuth } from '@/lib/saas/authContext';
import { BrandLogo } from '@/components/BrandLogo';
import { Button } from '@/components/ui/button';

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
    <label className="block text-sm font-bold text-hi">
      {label}
      <div className="relative mt-1.5">
        <input
          type={show ? 'text' : 'password'}
          required
          minLength={8}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="sl-input pr-12"
          placeholder={placeholder}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={`${action} ${label.toLowerCase()}`}
          aria-pressed={show}
          className="absolute inset-y-0 right-1.5 my-auto flex h-9 w-9 items-center justify-center rounded-[10px] text-low transition hover:bg-elev-3 hover:text-hi"
        >
          {show ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
        </button>
      </div>
    </label>
  );
}

const STORY_BULLETS = [
  { icon: Shield, text: 'Local-first — CSV import is 100% on-device' },
  { icon: Lock, text: 'Encrypted in transit · no wallet logging on our servers' },
  { icon: Mail, text: 'Free Starter tier — up to 100 transactions' }
];

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
      {/* Subtle ember hearth glows over the warm paper canvas */}
      <div className="pointer-events-none absolute -left-32 top-20 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 bottom-10 h-80 w-80 rounded-full bg-accent/10 blur-3xl" />

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-8 lg:flex-row lg:items-center lg:gap-16 lg:px-8">
        {/* Privacy story panel */}
        <div className="mb-10 flex-1 lg:mb-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="mb-6 inline-flex h-9 items-center gap-2 rounded-[10px] px-3 text-sm font-semibold text-mid transition hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to home
            </button>
          )}
          <div className="mb-8 lg:hidden">
            <BrandLogo variant="on-glass" />
          </div>
          <div className="mb-10 hidden lg:block">
            <span className="inline-flex rounded-2xl border border-hi/10 bg-elev-1 px-4 py-3 shadow-sm">
              <BrandLogo variant="on-glass" showTagline={false} />
            </span>
          </div>
          <p className="bg-aurora bg-clip-text text-xs font-extrabold uppercase tracking-[0.2em] text-transparent">
            Private crypto tax software
          </p>
          <h1 className="mt-3 font-display text-4xl font-extrabold leading-tight tracking-tight text-hi lg:text-5xl">
            {isRegister ? 'Start for free' : 'Welcome back'}
          </h1>
          <p className="mt-4 max-w-md text-lg leading-relaxed text-mid">
            Your transactions stay in your browser. We authenticate you and proxy wallet lookups — we never store your
            ledger.
          </p>
          <ul className="mt-8 space-y-4">
            {STORY_BULLETS.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm font-medium text-mid">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-hi/10 bg-elev-1 text-primary shadow-xs">
                  <Icon className="h-5 w-5" />
                </span>
                {text}
              </li>
            ))}
          </ul>
          <p className="mt-10 hidden items-center gap-3 text-xs text-low lg:flex">
            <span className="inline-flex items-center gap-2 rounded-full border border-gain/30 bg-gain/10 px-3 py-1 font-mono text-[0.65rem] font-semibold uppercase tracking-wide text-gain">
              <span className="h-1.5 w-1.5 rounded-full bg-gain" />
              100% Local engine
            </span>
            Private. Precise. Yours.
          </p>
        </div>

        {/* Form card */}
        <div className="w-full max-w-md shrink-0">
          <div className="rounded-[20px] border border-hi/10 bg-elev-2 p-8 shadow-card">
            <h2 className="text-xl font-extrabold tracking-tight text-hi">
              {isRegister ? 'Create account' : 'Sign in'}
            </h2>
            <p className="mt-1 text-sm text-low">
              {isRegister ? 'No credit card required' : 'Access your private workspace'}
            </p>

            <form onSubmit={submit} className="mt-6 space-y-4">
              <label className="block text-sm font-bold text-hi">
                Email
                <input
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="sl-input mt-1.5"
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
                <p
                  role="alert"
                  className="flex items-start gap-2.5 rounded-xl border border-loss/30 bg-loss/10 px-3.5 py-2.5 text-sm font-medium text-loss"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </p>
              )}
              <Button type="submit" size="lg" disabled={busy} className="w-full text-base">
                {busy ? 'Please wait…' : isRegister ? 'Create free account' : 'Sign in'}
              </Button>
            </form>

            <p className="mt-6 text-center text-sm text-mid">
              {isRegister ? 'Already have an account?' : "Don't have an account?"}{' '}
              <button
                type="button"
                className="font-semibold text-primary underline-offset-2 transition hover:text-primary-deep hover:underline"
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
