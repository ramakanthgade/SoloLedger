import { useEffect, useState } from 'react';
import { saveSettings, clearAllData } from '@/lib/storage/db';
import { exportFullBackup, importFullBackup } from '@/lib/storage/backup';
import { JURISDICTIONS } from '@/lib/tax/jurisdictions';
import type { TaxSettings, Jurisdiction } from '@/types/transaction';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ApiKeyField } from './ApiKeyField';
import { AdminServerSettings } from './AdminServerSettings';
import { SubscriptionCard } from './SubscriptionCard';
import { isSaasMode } from '@/lib/saas/config';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { useAuth } from '@/lib/saas/authContext';

export function SettingsTab() {
  const saas = isSaasMode();
  const { user } = useAuth();
  const [settings, setSettings] = useState<TaxSettings | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<File | null>(null);
  const [restoreStatus, setRestoreStatus] = useState<
    { kind: 'success' | 'error'; message: string } | null
  >(null);

  const runRestore = async (file: File) => {
    try {
      const { imported } = await importFullBackup(file);
      // Restore replaced the settings row in IndexedDB — refresh the mounted UI
      // state so a later toggle doesn't overwrite the just-restored settings.
      setSettings(await getEffectiveSettings());
      setRestoreStatus({ kind: 'success', message: `Restored ${imported} transactions.` });
    } catch (err) {
      setRestoreStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to restore backup.'
      });
    } finally {
      setPendingRestore(null);
    }
  };

  useEffect(() => {
    getEffectiveSettings().then((s) => setSettings(s));
  }, []);

  if (!settings) return null;

  const update = async (patch: Partial<TaxSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await saveSettings(next);
  };

  const isAdmin = saas && user?.role === 'admin';

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="page-title">Settings</h2>
          <p className="mt-1 text-sm text-mist-400">
            {isAdmin
              ? 'Admin: manage server API keys below. Tax preferences are still local to this browser.'
              : saas
                ? 'Tax preferences stored locally. Network features run through SoloLedger — no API keys needed.'
                : 'Stored locally in IndexedDB. Nothing here is synced anywhere.'}
          </p>
        </div>
      </div>

      {saas && user?.role !== 'admin' && <SubscriptionCard />}

      {isAdmin && <AdminServerSettings />}

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
              className="sl-select mt-1 block w-full"
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
              className="sl-select mt-1 block w-full"
            >
              <option value="FIFO">FIFO — First In, First Out</option>
              <option value="SpecID">Specific Identification</option>
            </select>
          </label>
          <label className="block text-sm text-mist-300">
            Derivatives tax treatment
            <select
              value={settings.derivativesTreatment ?? (settings.jurisdiction === 'IN' || settings.jurisdiction === 'CA' ? 'business_income' : 'capital_gains')}
              onChange={(e) =>
                update({
                  derivativesTreatment: e.target.value as TaxSettings['derivativesTreatment']
                })
              }
              className="sl-select mt-1 block w-full"
            >
              <option value="business_income">Business income &amp; expenses (profits − fees/losses)</option>
              <option value="capital_gains">Capital gains / losses</option>
            </select>
            <span className="mt-1 block text-xs text-mist-400">
              Applies to Hyperliquid perps and other derivative imports. Defaults by jurisdiction (India/Canada →
              business income). Change anytime — reports update without re-importing.
            </span>
          </label>
        </CardContent>
      </Card>

      {!saas && (
        <>
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
                  addresses or amounts) to price APIs to fill in market values.
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
                  <strong className="text-mist">Wallet address lookup via public RPC/explorer.</strong>
                </span>
              </label>

              {settings.rpcLookupEnabled && (
                <div className="ml-7 space-y-4 border-l border-ink-700 pl-4">
                  <ApiKeyField
                    label="Helius API key — PRIMARY for Solana"
                    value={settings.heliusApiKey}
                    onSave={(key) => update({ heliusApiKey: key })}
                    onDelete={() => update({ heliusApiKey: undefined })}
                    placeholder="Paste your Helius API key"
                  />
                  <ApiKeyField
                    label="Moralis API key — PRIMARY for EVM chains"
                    value={settings.moralisApiKey}
                    onSave={(key) => update({ moralisApiKey: key })}
                    onDelete={() => update({ moralisApiKey: undefined })}
                    placeholder="Paste your Moralis API key"
                  />
                  <ApiKeyField
                    label="Alchemy API key (fallback)"
                    value={settings.alchemyApiKey}
                    onSave={(key) => update({ alchemyApiKey: key })}
                    onDelete={() => update({ alchemyApiKey: undefined })}
                    placeholder="Paste your Alchemy API key"
                  />
                  <ApiKeyField
                    label="Etherscan API key (optional fallback)"
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
                    label="CoinGecko Pro API key"
                    value={settings.coingeckoApiKey}
                    onSave={(key) => update({ coingeckoApiKey: key })}
                    onDelete={() => update({ coingeckoApiKey: undefined })}
                    placeholder="Paste your CoinGecko Pro API key"
                  />
                  <ApiKeyField
                    label="Birdeye API key (Solana pricing)"
                    value={settings.birdeyeApiKey}
                    onSave={(key) => update({ birdeyeApiKey: key })}
                    onDelete={() => update({ birdeyeApiKey: undefined })}
                    placeholder="Paste your Birdeye API key"
                  />
                  <ApiKeyField
                    label="Noves API key (DeFi classification)"
                    value={settings.novesApiKey}
                    onSave={(key) => update({ novesApiKey: key })}
                    onDelete={() => update({ novesApiKey: undefined })}
                    placeholder="Paste your Noves API key"
                  />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>AI Tax Advisor</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ApiKeyField
                label="OpenRouter API key"
                value={settings.aiApiKey}
                onSave={(key) => update({ aiApiKey: key })}
                onDelete={() => update({ aiApiKey: undefined })}
                placeholder="sk-or-v1-…"
              />
            </CardContent>
          </Card>
        </>
      )}

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
                  const file = e.target.files?.[0] ?? null;
                  // Reset so re-selecting the same file fires onChange again.
                  e.target.value = '';
                  setRestoreStatus(null);
                  if (file) setPendingRestore(file);
                }}
              />
              <span className="cursor-pointer rounded border border-ink-600 bg-ink-700 px-4 py-2 text-sm text-mist hover:bg-ink-600">
                Import backup
              </span>
            </label>
          </div>
          {pendingRestore && (
            <div className="flex items-center gap-3">
              <span className="text-sm text-loss">
                Restoring replaces all local data with the backup. Continue?
              </span>
              <Button variant="danger" onClick={() => runRestore(pendingRestore)}>
                Yes, restore backup
              </Button>
              <Button variant="ghost" onClick={() => setPendingRestore(null)}>
                Cancel
              </Button>
            </div>
          )}
          {restoreStatus && (
            <p
              className={`text-sm ${
                restoreStatus.kind === 'success' ? 'text-emerald-600' : 'text-loss'
              }`}
            >
              {restoreStatus.message}
            </p>
          )}
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
                    // clearAllData resets settings to defaults in IndexedDB —
                    // refresh the mounted UI state to match.
                    setSettings(await getEffectiveSettings());
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
