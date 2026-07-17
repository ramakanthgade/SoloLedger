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

const PLANS = ['local', 'starter', 'standard', 'pro', 'investor', 'enterprise'] as const;

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
        <p className="mt-1 text-sm text-low">
          Manage subscribers here. API keys and network defaults are in <strong>Settings</strong>.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>User persistence (Railway)</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm text-mid">
          <p>
            Subscriber accounts are stored in <code className="rounded bg-elev-3 px-1 py-0.5 font-mono text-hi">store.json</code> on
            the API server. On Railway, attach a <strong className="text-hi">Volume</strong> and set{' '}
            <code className="rounded bg-elev-3 px-1 py-0.5 font-mono text-hi">DATA_DIR=/data</code> so users survive
            redeploys.
          </p>
          <p className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-warn">
            Without a volume, redeploys wipe registered users — they will need to register again.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>API keys on server</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
          {keys &&
            Object.entries(keys).map(([name, ok]) => (
              <div key={name} className={ok ? 'text-gain' : 'text-loss'}>
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
              <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-low">
                <th className="py-2 pr-3">Email</th>
                <th className="py-2 pr-3">Role</th>
                <th className="py-2 pr-3">Plan</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Included events</th>
                <th className="py-2">Save</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <UserRow key={u.id} user={u} onSave={(patch) => saveUser(u.id, patch)} />
              ))}
            </tbody>
          </table>
          {message && <p className="mt-3 text-xs text-gain">{message}</p>}
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
  const [includedUnits, setIncludedUnits] = useState(String(user.includedUnits));

  if (isAdmin) {
    return (
      <tr className="border-b border-white/10 bg-violet/5">
        <td className="py-3 pr-3 font-medium text-mid">{user.email}</td>
        <td className="py-3 pr-3 capitalize text-low">Admin</td>
        <td className="py-3 pr-3">
          <span className="rounded-full bg-elev-1/10 px-2 py-0.5 text-xs font-semibold capitalize text-hi">
            {formatPlanLabel('enterprise')}
          </span>
        </td>
        <td className="py-3 pr-3">
          <span className="text-xs font-medium text-gain">active</span>
        </td>
        <td className="py-3 pr-3 text-xs font-semibold text-gain">Full access</td>
        <td className="py-3 text-xs text-low">—</td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-white/10">
      <td className="py-3 pr-3 font-medium text-mid">{user.email}</td>
      <td className="py-3 pr-3 capitalize text-low">{user.role}</td>
      <td className="py-3 pr-3">
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value as PublicUser['plan'])}
          className="sl-select text-xs"
        >
          {PLANS.map((p) => (
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
          value={includedUnits}
          onChange={(e) => setIncludedUnits(e.target.value)}
          className="w-28 rounded border border-white/10 bg-elev-2 px-2 py-1 text-xs"
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
              customIncludedUnits: includedUnits.trim() === '' ? null : Number(includedUnits)
            })
          }
        >
          Save
        </Button>
      </td>
    </tr>
  );
}
