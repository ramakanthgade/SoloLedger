import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/saas/api';
import { invalidateServerConfigCache } from '@/lib/saas/effectiveSettings';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiKeyField } from './ApiKeyField';
import { Toggle } from './Toggle';

/** Admin default row — same `.setrow` layout as the subscriber settings. */
function AdminToggleRow({
  title,
  caption,
  checked,
  onChange
}: {
  title: string;
  caption: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-6 py-1">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-hi">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-low">{caption}</span>
      </span>
      <Toggle checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

interface ServerApiKeys {
  alchemyApiKey?: string;
  coingeckoApiKey?: string;
  heliusApiKey?: string;
  moralisApiKey?: string;
  birdeyeApiKey?: string;
  novesApiKey?: string;
  openrouterApiKey?: string;
  etherscanApiKey?: string;
}

interface ServerConfig {
  priceApiEnabled: boolean;
  rpcLookupEnabled: boolean;
  aiAdvisorEnabled: boolean;
}

export function AdminServerSettings() {
  const [keys, setKeys] = useState<ServerApiKeys>({});
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [keysRes, cfgRes] = await Promise.all([
        apiFetch('/api/admin/api-keys'),
        apiFetch('/api/admin/config')
      ]);
      if (keysRes.ok) setKeys((await keysRes.json()).keys ?? {});
      if (cfgRes.ok) setConfig((await cfgRes.json()).config);
    })();
  }, []);

  const saveKey = async (field: keyof ServerApiKeys, value: string) => {
    const res = await apiFetch('/api/admin/api-keys', {
      method: 'PUT',
      body: JSON.stringify({ [field]: value })
    });
    if (res.ok) {
      const data = await res.json();
      setKeys(data.keys);
      setMessage('API key saved on server (used for all subscribers).');
    }
  };

  const deleteKey = async (field: keyof ServerApiKeys) => {
    const res = await apiFetch(`/api/admin/api-keys/${field}`, { method: 'DELETE' });
    if (res.ok) {
      const data = await res.json();
      setKeys(data.keys);
      setMessage('Removed from server store — .env fallback applies if set.');
    }
  };

  const saveConfig = async (patch: Partial<ServerConfig>) => {
    const res = await apiFetch('/api/admin/config', {
      method: 'PUT',
      body: JSON.stringify({ ...config, ...patch })
    });
    if (res.ok) {
      const data = await res.json();
      setConfig(data.config);
      invalidateServerConfigCache();
      setMessage('Subscriber defaults updated.');
    }
  };

  if (!config) return null;

  return (
    <>
      <p className="text-sm text-low">
        Admin only — keys are saved on the proxy server and used for all subscribers. Not stored in GitHub.
      </p>

      <Card id="settings-admin-network" className="scroll-mt-24">
        <CardHeader>
          <CardTitle>Network features (subscriber defaults)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <AdminToggleRow
            title="Live price lookup"
            caption="On by default for subscribers"
            checked={config.priceApiEnabled}
            onChange={(v) => void saveConfig({ priceApiEnabled: v })}
          />
          <AdminToggleRow
            title="Wallet address lookup"
            caption="On by default for subscribers"
            checked={config.rpcLookupEnabled}
            onChange={(v) => void saveConfig({ rpcLookupEnabled: v })}
          />
          <AdminToggleRow
            title="AI Tax Advisor"
            caption="Subscribers can opt out from their own Settings"
            checked={config.aiAdvisorEnabled}
            onChange={(v) => void saveConfig({ aiAdvisorEnabled: v })}
          />
        </CardContent>
      </Card>

      <Card id="settings-admin-keys" className="scroll-mt-24">
        <CardHeader>
          <CardTitle>API keys (server)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <ApiKeyField
            label="Helius API key — PRIMARY for Solana"
            value={keys.heliusApiKey}
            onSave={(v) => void saveKey('heliusApiKey', v)}
            onDelete={() => void deleteKey('heliusApiKey')}
            placeholder="Paste your Helius API key"
          />
          <ApiKeyField
            label="Moralis API key — PRIMARY for EVM chains"
            value={keys.moralisApiKey}
            onSave={(v) => void saveKey('moralisApiKey', v)}
            onDelete={() => void deleteKey('moralisApiKey')}
            placeholder="Paste your Moralis API key"
          />
          <ApiKeyField
            label="Alchemy API key (fallback for Solana + EVM)"
            value={keys.alchemyApiKey}
            onSave={(v) => void saveKey('alchemyApiKey', v)}
            onDelete={() => void deleteKey('alchemyApiKey')}
            placeholder="Paste your Alchemy API key"
          />
          <ApiKeyField
            label="Etherscan API key (optional fallback)"
            value={keys.etherscanApiKey}
            onSave={(v) => void saveKey('etherscanApiKey', v)}
            onDelete={() => void deleteKey('etherscanApiKey')}
            placeholder="Paste an Etherscan-family API key"
          />
          <ApiKeyField
            label="CoinGecko Pro API key"
            value={keys.coingeckoApiKey}
            onSave={(v) => void saveKey('coingeckoApiKey', v)}
            onDelete={() => void deleteKey('coingeckoApiKey')}
            placeholder="Paste your CoinGecko Pro API key"
          />
          <ApiKeyField
            label="Birdeye API key (Solana pricing)"
            value={keys.birdeyeApiKey}
            onSave={(v) => void saveKey('birdeyeApiKey', v)}
            onDelete={() => void deleteKey('birdeyeApiKey')}
            placeholder="Paste your Birdeye API key"
          />
          <ApiKeyField
            label="Noves API key (DeFi classification)"
            value={keys.novesApiKey}
            onSave={(v) => void saveKey('novesApiKey', v)}
            onDelete={() => void deleteKey('novesApiKey')}
            placeholder="Paste your Noves API key"
          />
          <ApiKeyField
            label="OpenRouter API key (AI Tax Advisor)"
            value={keys.openrouterApiKey}
            onSave={(v) => void saveKey('openrouterApiKey', v)}
            onDelete={() => void deleteKey('openrouterApiKey')}
            placeholder="sk-or-v1-…"
          />
          {message && <p className="text-xs text-gain">{message}</p>}
        </CardContent>
      </Card>
    </>
  );
}
