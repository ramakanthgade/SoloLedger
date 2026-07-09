import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/saas/authContext';
import { apiFetch } from '@/lib/saas/api';
import { invalidateServerConfigCache } from '@/lib/saas/effectiveSettings';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ServerConfig {
  priceApiEnabled: boolean;
  rpcLookupEnabled: boolean;
  aiAdvisorEnabled: boolean;
}

interface KeyStatus {
  alchemy: boolean;
  coingecko: boolean;
  helius: boolean;
  moralis: boolean;
  birdeye: boolean;
  noves: boolean;
  openrouter: boolean;
  etherscan: boolean;
}

export function AdminPanel() {
  const { user, logout } = useAuth();
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [keys, setKeys] = useState<KeyStatus | null>(null);
  const [users, setUsers] = useState<unknown[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    void (async () => {
      const [cfgRes, keyRes, usersRes] = await Promise.all([
        apiFetch('/api/admin/config'),
        apiFetch('/api/admin/api-keys-status'),
        apiFetch('/api/admin/users')
      ]);
      if (cfgRes.ok) setConfig((await cfgRes.json()).config);
      if (keyRes.ok) setKeys(await keyRes.json());
      if (usersRes.ok) setUsers((await usersRes.json()).users);
    })();
  }, [user]);

  if (user?.role !== 'admin') return null;

  const saveConfig = async (patch: Partial<ServerConfig>) => {
    const res = await apiFetch('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({ ...config, ...patch })
    });
    if (res.ok) {
      const data = await res.json();
      setConfig(data.config);
      invalidateServerConfigCache();
      setMessage('Saved — subscribers will see updated defaults on next load.');
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="page-title">Admin</h2>
          <p className="mt-1 text-sm text-mist-400">API keys live in server .env — never in the browser.</p>
        </div>
        <Button variant="ghost" onClick={logout}>Sign out</Button>
      </div>

      <Card>
        <CardHeader><CardTitle>Subscriber defaults</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm text-mist-300">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config?.priceApiEnabled ?? true}
              onChange={(e) => void saveConfig({ priceApiEnabled: e.target.checked })}
            />
            Live price lookup (on for all subscribers by default)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config?.rpcLookupEnabled ?? true}
              onChange={(e) => void saveConfig({ rpcLookupEnabled: e.target.checked })}
            />
            Wallet address lookup (on for all subscribers by default)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config?.aiAdvisorEnabled ?? true}
              onChange={(e) => void saveConfig({ aiAdvisorEnabled: e.target.checked })}
            />
            AI Tax Advisor
          </label>
          {message && <p className="text-xs text-emerald-600">{message}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>API keys on server</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 gap-2 text-sm">
          {keys &&
            Object.entries(keys).map(([name, ok]) => (
              <div key={name} className={ok ? 'text-emerald-600' : 'text-loss'}>
                {name}: {ok ? 'configured' : 'missing'}
              </div>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Users ({users.length})</CardTitle></CardHeader>
        <CardContent className="max-h-48 overflow-auto text-xs text-mist-400">
          <pre>{JSON.stringify(users, null, 2)}</pre>
        </CardContent>
      </Card>
    </div>
  );
}
