import { useEffect, useState } from 'react';
import { getSettings, saveSettings, clearAllData } from '@/lib/storage/db';
import { exportFullBackup, importFullBackup } from '@/lib/storage/backup';
import { setNetworkFeaturesEnabled } from '@/components/LocalOnlyBadge';
import { JURISDICTIONS } from '@/lib/tax/jurisdictions';
import type { TaxSettings, Jurisdiction } from '@/types/transaction';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ApiKeyField } from './ApiKeyField';

export function SettingsTab() {
  const [settings, setSettings] = useState<TaxSettings | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  if (!settings) return null;

  const update = async (patch: Partial<TaxSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettings(next);
    setNetworkFeaturesEnabled(next.priceApiEnabled || next.rpcLookupEnabled);
  };

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-mist">Settings</h2>
        <p className="mt-1 text-sm text-mist-400">Stored locally in IndexedDB. Nothing here is synced anywhere.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tax defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="block text-sm text-mist-300">
            Jurisdiction
            <select
              value={settings.jurisdiction}
              onChange={(e) => update({ jurisdiction: e.target.value as Jurisdiction, reportingCurrency: JURISDICTIONS[e.target.value as Jurisdiction].currency })}
              className="mt-1 block w-full rounded border border-ink-600 bg-ink-800 px-3 py-2 text-mist focus:border-emerald focus:outline-none"
            >
              {Object.values(JURISDICTIONS).map((j) => (
                <option key={j.code} value={j.code}>
                  {j.label} ({j.currency})
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm text-mist-300">
            Default cost basis method
            <select
              value={settings.defaultCostBasisMethod}
              onChange={(e) => update({ defaultCostBasisMethod: e.target.value as TaxSettings['defaultCostBasisMethod'] })}
              className="mt-1 block w-full rounded border border-ink-600 bg-ink-800 px-3 py-2 text-mist focus:border-emerald focus:outline-none"
            >
              <option value="FIFO">FIFO — First In, First Out</option>
              <option value="SpecID">Specific Identification</option>
            </select>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Network features (off by default)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex items-start gap-3 text-sm text-mist-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.priceApiEnabled}
              onChange={(e) => update({ priceApiEnabled: e.target.checked })}
            />
            <span>
              <strong className="text-mist">Live price lookup.</strong> Sends asset/date pairs (never wallet
              addresses or amounts) to CoinGecko's public price API to fill in market values. For tokens CoinGecko
              doesn't track (small, DEX-only tokens), it falls back to your Alchemy key's Prices API and converts
              the result into your reporting currency. Nothing fetches automatically — use the button in Review.
              For obscure DEX tokens, add your Alchemy API key below (used only for price fallback, not wallet lookup).
            </span>
          </label>
          <label className="flex items-start gap-3 text-sm text-mist-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={settings.rpcLookupEnabled}
              onChange={(e) => update({ rpcLookupEnabled: e.target.checked })}
            />
            <span>
              <strong className="text-mist">Wallet address lookup via public RPC/explorer.</strong> Sends the
              address you enter to an explorer to read transaction history. Bitcoin uses Blockstream (no key
              needed); other chains use your own Alchemy key below, so the lookup runs under your account rather
              than a shared one. Whichever service answers will see the address you query — see Import → Wallet
              lookup for why that's unavoidable for any address lookup.
            </span>
          </label>

          {settings.rpcLookupEnabled && (
            <div className="ml-7 space-y-4 border-l border-ink-700 pl-4">
              <ApiKeyField
                label={
                  <>
                    Alchemy API key (covers Ethereum, Polygon, Arbitrum, Base, BNB Chain, Optimism, Avalanche, and
                    Solana — one free key from{' '}
                    <a href="https://www.alchemy.com" target="_blank" rel="noreferrer" className="text-emerald-600 underline">
                      alchemy.com
                    </a>
                    )
                  </>
                }
                value={settings.alchemyApiKey}
                onSave={(key) => update({ alchemyApiKey: key })}
                onDelete={() => update({ alchemyApiKey: undefined })}
                placeholder="Paste your Alchemy API key"
              />
              <ApiKeyField
                label={
                  <>
                    Etherscan API key (optional — fallback for Polygon, Arbitrum, Base, and other EVM chains when
                    Alchemy transfer lookup is rate-limited; Ethereum uses Blockscout first and does not need this.
                    One key covers many chains via{' '}
                    <a href="https://etherscan.io/apis" target="_blank" rel="noreferrer" className="text-emerald-600 underline">
                      etherscan.io/apis
                    </a>
                    )
                  </>
                }
                value={settings.customExplorerApiKey}
                onSave={(key) => update({ customExplorerApiKey: key })}
                onDelete={() => update({ customExplorerApiKey: undefined })}
                placeholder="Paste an Etherscan-family API key"
              />
            </div>
          )}

          {settings.priceApiEnabled && (
            <div className="ml-7 space-y-4 border-l border-ink-700 pl-4">
              <ApiKeyField
                label={
                  <>
                    CoinGecko Pro API key (recommended — historical USDC/USDT/INR prices by date; from{' '}
                    <a href="https://www.coingecko.com/en/api/pricing" target="_blank" rel="noreferrer" className="text-emerald-600 underline">
                      coingecko.com/api
                    </a>
                    , Basic plan ~$29/mo)
                  </>
                }
                value={settings.coingeckoApiKey}
                onSave={(key) => update({ coingeckoApiKey: key })}
                onDelete={() => update({ coingeckoApiKey: undefined })}
                placeholder="Paste your CoinGecko Pro API key"
              />
              <ApiKeyField
                label={
                  <>
                    Alchemy API key (optional — price fallback for tokens CoinGecko does not track; get one free at{' '}
                    <a href="https://www.alchemy.com" target="_blank" rel="noreferrer" className="text-emerald-600 underline">
                      alchemy.com
                    </a>
                    )
                  </>
                }
                value={settings.alchemyApiKey}
                onSave={(key) => update({ alchemyApiKey: key })}
                onDelete={() => update({ alchemyApiKey: undefined })}
                placeholder="Paste your Alchemy API key"
              />
            </div>
          )}

          {settings.priceApiEnabled && settings.rpcLookupEnabled && (
            <p className="ml-7 text-xs text-mist-400">
              Alchemy key above is shared for wallet lookup and price fallback.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your data</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => exportFullBackup()}>
              Export full backup (JSON)
            </Button>
            <label>
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) importFullBackup(file);
                }}
              />
              <span className="cursor-pointer rounded border border-ink-600 bg-ink-700 px-4 py-2 text-sm text-mist hover:bg-ink-600">
                Import backup
              </span>
            </label>
          </div>
          <div className="border-t border-ink-700 pt-3">
            {!confirmDelete ? (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                Delete all local data
              </Button>
            ) : (
              <div className="flex items-center gap-3">
                <span className="text-sm text-loss">This permanently deletes everything. Are you sure?</span>
                <Button
                  variant="danger"
                  onClick={async () => {
                    await clearAllData();
                    setConfirmDelete(false);
                  }}
                >
                  Yes, delete everything
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
