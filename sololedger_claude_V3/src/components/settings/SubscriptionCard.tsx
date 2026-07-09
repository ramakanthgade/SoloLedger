import { useState } from 'react';
import { useAuth } from '@/lib/saas/authContext';
import { startCheckout } from '@/lib/saas/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const PLANS = [
  { id: 'starter', name: 'Starter', price: '$50/yr', limit: '100 transactions' },
  { id: 'standard', name: 'Standard', price: '$100/yr', limit: '500 transactions' },
  { id: 'pro', name: 'Pro', price: '$500/yr', limit: '1,000 transactions' }
] as const;

export function SubscriptionCard() {
  const { user } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  if (!user || user.role === 'admin') return null;

  const upgrade = async (plan: string) => {
    setBusy(plan);
    setError(null);
    try {
      const url = await startCheckout(plan);
      if (url) window.location.href = url;
      else setError('Checkout is not configured yet — contact support.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Checkout failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Subscription</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-mist-300">
          Plan: <strong className="text-mist capitalize">{user.plan}</strong>
          {' · '}
          Limit: <strong className="text-mist">{user.txLimit.toLocaleString()} transactions</strong>
          {!user.subscriptionActive && (
            <span className="ml-2 text-loss">(inactive — renew to use wallet lookup & pricing)</span>
          )}
        </p>
        {user.plan === 'trial' && (
          <p className="text-xs text-mist-400">
            14-day trial includes wallet lookup and live pricing via SoloLedger&apos;s API keys — no setup required.
          </p>
        )}
        <div className="grid gap-2 sm:grid-cols-3">
          {PLANS.map((p) => (
            <Button
              key={p.id}
              variant="secondary"
              disabled={busy === p.id}
              onClick={() => upgrade(p.id)}
              className="flex h-auto flex-col items-start gap-1 py-3 text-left"
            >
              <span className="font-semibold">{p.name}</span>
              <span className="text-xs opacity-80">{p.price} · {p.limit}</span>
            </Button>
          ))}
        </div>
        {error && <p className="text-sm text-loss">{error}</p>}
      </CardContent>
    </Card>
  );
}
