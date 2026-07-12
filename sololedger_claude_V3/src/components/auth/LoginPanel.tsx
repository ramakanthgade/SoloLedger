import { useState } from 'react';
import { useAuth } from '@/lib/saas/authContext';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function LoginPanel() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
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
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{mode === 'login' ? 'Sign in to SoloLedger' : 'Create your account'}</CardTitle>
          <p className="text-sm text-mist-400">
            Your transaction data stays in your browser. We only authenticate you and proxy pricing/wallet APIs.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <label className="block text-sm text-mist-300">
              Email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 block w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-mist"
              />
            </label>
            <label className="block text-sm text-mist-300">
              Password
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 block w-full rounded-md border border-ink-600 bg-ink-800 px-3 py-2 text-mist"
              />
            </label>
            {error && <p className="text-sm text-loss">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create free account'}
            </Button>
          </form>
          <button
            type="button"
            className="mt-4 text-sm text-emerald-600 underline"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in'}
          </button>
        </CardContent>
      </Card>
    </div>
  );
}
