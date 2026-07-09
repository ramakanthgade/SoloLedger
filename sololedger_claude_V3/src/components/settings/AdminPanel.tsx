import { useEffect, useState } from 'react';
import { apiFetch, type PublicUser } from '@/lib/saas/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

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

const PLANS = ['trial', 'starter', 'standard', 'pro'] as const;

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
  const [plan, setPlan] = useState(user.plan);
  const [status, setStatus] = useState(user.subscriptionStatus);
  const [txLimit, setTxLimit] = useState(String(user.txLimit));

  return (
    <tr className="border-b border-ink-700/60">
      <td className="py-3 pr-3 font-medium text-mist">{user.email}</td>
      <td className="py-3 pr-3 capitalize text-mist-300">{user.role}</td>
      <td className="py-3 pr-3">
        <select
          value={plan}
          onChange={(e) => setPlan(e.target.value as PublicUser['plan'])}
          className="sl-select text-xs"
          disabled={user.role === 'admin'}
        >
          {PLANS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </td>
      <td className="py-3 pr-3">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="sl-select text-xs"
          disabled={user.role === 'admin'}
        >
          {['active', 'trialing', 'past_due', 'canceled', 'none'].map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </td>
      <td className="py-3 pr-3">
        <input
          type="number"
          min={1}
          value={txLimit}
          onChange={(e) => setTxLimit(e.target.value)}
          className="w-24 rounded border border-ink-600 bg-ink-800 px-2 py-1 text-xs"
          disabled={user.role === 'admin'}
        />
      </td>
      <td className="py-3">
        {user.role !== 'admin' && (
          <Button
            variant="secondary"
            className="text-xs"
            onClick={() =>
              onSave({
                plan,
                subscriptionStatus: status,
                customTxLimit: Number(txLimit)
              })
            }
          >
            Save
          </Button>
        )}
      </td>
    </tr>
  );
}
