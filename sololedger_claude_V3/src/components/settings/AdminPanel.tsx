import { useEffect, useState } from 'react';
import { apiFetch, type PublicUser } from '@/lib/saas/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { formatPlanLabel } from '@/lib/saas/plans';

interface KeyStatus {
  alchemyApiKey: boolean;
  coingeckoApiKey: boolean;
  heliusApiKey: boolean;
  moralisApiKey: boolean;
  birdeyeApiKey: boolean;
  novesApiKey: boolean;
  openrouterApiKey: boolean;
  etherscanApiKey: boolean;
}

const PLANS = ['trial', 'starter', 'standard', 'pro', 'small_business', 'enterprise'] as const;

export function AdminPanel() {
  const [keys, setKeys] = useState<KeyStatus | null>(null);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    const [keyRes, usersRes] = await Promise.all([
      apiFetch('/api/admin/api-keys-status'),
      apiFetch('/api/admin/users')
    ]);
    if (keyRes.ok) setKeys(await keyRes.json());
    if (usersRes.ok) setUsers((await usersRes.json()).users);
  };

  useEffect(() => {
    void load();
  }, []);

  const saveUser = async (id: string, patch: Record<string, unknown>) => {
    const res = await apiFetch(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
    if (res.ok) {
      const data = await res.json();
      setUsers((prev) => prev.map((u) => (u.id === id ? data.user : u)));
      setMessage('User updated.');
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="page-title">Admin</h2>
        <p className="mt-1 text-sm text-mist-400">
          Manage subscribers here. API keys and network defaults are in <strong>Settings</strong>.
        </p>
      </div>

      <Card className="border-amber-300/40 bg-amber-50/50">
        <CardHeader><CardTitle>User persistence (Railway)</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm text-mist-300">
          <p>
            Subscriber accounts are stored in <code className="text-mist">store.json</code> on the API server. On
            Railway, attach a <strong>Volume</strong> and set <code className="text-mist">DATA_DIR=/data</code> so
            users survive redeploys.
          </p>
          <p className="text-mist-400">
            Without a volume, redeploys wipe registered users — they will need to register again.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>API keys on server</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {keys &&
            Object.entries(keys).map(([name, ok]) => (
              <div key={name} className={ok ? 'text-emerald-600' : 'text-loss'}>
                {name.replace('ApiKey', '')}: {ok ? '✓' : 'missing'}
              </div>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Users ({users.length})</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-ink-700 text-xs uppercase tracking-wide text-mist-400">
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Plan</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Tx limit</th>
                <th className="py-2">Save</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <UserRow key={u.id} user={u} onSave={(patch) => saveUser(u.id, patch)} />
              ))}
            </tbody>
          </table>
          {message && <p className="mt-3 text-xs text-emerald-600">{message}</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function UserRow({
  user,
  onSave
}: {
  user: PublicUser;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const isAdmin = user.role === 'admin';
  const [plan, setPlan] = useState(user.plan);
  const [status, setStatus] = useState(user.subscriptionStatus);
  const [txLimit, setTxLimit] = useState(
    user.txLimitUnlimited ? 'Unlimited' : String(user.txLimit)
  );

  if (isAdmin) {
    return (
      <tr className="border-b border-ink-700/60 bg-emerald/5">
        <td className="py-3 pr-3 font-medium text-mist">{user.email}</td>
        <td className="py-3 pr-3 capitalize text-mist-300">Admin</td>
        <td className="py-3 pr-3">
          <span className="rounded-full bg-navy/10 px-2 py-0.5 text-xs font-semibold capitalize text-navy">
            {formatPlanLabel('enterprise')}
          </span>
        </td>
        <td className="py-3 pr-3">
          <span className="text-xs font-medium text-emerald-700">active</span>
        </td>
        <td className="py-3 pr-3 text-xs font-semibold text-emerald-700">Unlimited</td>
        <td className="py-3 text-xs text-mist-400">—</td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-ink-700/60">
      <td className="py-3 pr-3 font-medium text-mist">{user.email}</td>
      <td className="py-3 pr-3 capitalize text-mist-300">{user.role}</td>
      <td className="py-3 pr-3">
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value as PublicUser['plan'])}
          className="sl-select text-xs"
        >
          {PLANS.filter((p) => p !== 'trial').map((p) => (
            <option key={p} value={p}>{formatPlanLabel(p)}</option>
          ))}
        </select>
      </td>
      <td className="py-3 pr-3">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="sl-select text-xs"
        >
          {['active', 'trialing', 'past_due', 'canceled', 'none'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </td>
      <td className="py-3 pr-3">
        <input
          type="text"
          value={txLimit}
          onChange={(e) => setTxLimit(e.target.value)}
          className="w-28 rounded border border-ink-600 bg-ink-800 px-2 py-1 text-xs"
        />
      </td>
      <td className="py-3">
        <Button
          variant="secondary"
          className="text-xs"
          onClick={() =>
            onSave({
              plan,
              subscriptionStatus: status,
              customTxLimit:
                txLimit.toLowerCase() === 'unlimited' ? 9999999 : Number(txLimit)
            })
          }
        >
          Save
        </Button>
      </td>
    </tr>
  );
}
