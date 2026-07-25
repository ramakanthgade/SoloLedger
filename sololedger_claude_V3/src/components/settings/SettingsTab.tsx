import { useEffect, useMemo, useRef, useState } from 'react';
import { getSettings, saveSettings, clearAllData } from '@/lib/storage/db';
import { exportFullBackup, importFullBackup } from '@/lib/storage/backup';
import { JURISDICTIONS } from '@/lib/tax/jurisdictions';
import type { TaxSettings, Jurisdiction } from '@/types/transaction';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Toast, ToastViewport } from '@/components/ui/toast';
import { ApiKeyField } from './ApiKeyField';
import { AdminServerSettings } from './AdminServerSettings';
import { SubscriptionCard } from './SubscriptionCard';
import { isSaasMode } from '@/lib/saas/config';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { useAuth } from '@/lib/saas/authContext';
import { AddressRegistrySettingsSection } from './AddressRegistrySettings';
import { AppearanceSettings } from './AppearanceSettings';
import { SettingsSubNav, type SettingsSectionLink } from './SettingsSubNav';
import { Toggle } from './Toggle';
import {
  Database,
  Download,
  Globe,
  KeyRound,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Star,
  Sun,
  Upload,
  Wallet
} from 'lucide-react';

/**
 * Load the settings driving this page. In hosted mode getEffectiveSettings
 * intentionally omits local-only fields, but `aiConsentGranted` IS a local
 * per-device setting (the AI Advisor reads the raw settings row) — graft it
 * on so the AI checkbox below reflects and round-trips the persisted value.
 */
async function loadSettings(): Promise<TaxSettings> {
  const [effective, local] = await Promise.all([getEffectiveSettings(), getSettings()]);
  return { ...effective, aiConsentGranted: local.aiConsentGranted };
}

interface ToastItem {
  id: number;
  tone: 'gain' | 'loss' | 'warn' | 'primary';
  title: string;
  description?: string;
}

/**
 * Honest "what leaves your device" caption (flows-reports mockup `.pcap`) —
 * the boxed privacy note under each network toggle.
 */
function PrivacyCaption({ children }: { children: React.ReactNode }) {
  return (
    <span className="mt-2 flex items-start gap-2 rounded-[11px] border border-hi/10 bg-elev-3/50 px-3 py-2 text-xs leading-relaxed text-low">
      <Globe className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gain" aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

/**
 * Settings row (mockup `.setrow`): label + helper on the left, switch-styled
 * control on the right. The whole row is the <label>, so clicking anywhere
 * toggles and the control's accessible name comes from the row text.
 */
function ToggleRow({
  title,
  caption,
  checked,
  onChange
}: {
  title: React.ReactNode;
  caption?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-6">
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-hi">{title}</span>
        {caption}
      </span>
      <Toggle
        className="mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function SettingsTab() {
  const saas = isSaasMode();
  const { user } = useAuth();
  const [settings, setSettings] = useState<TaxSettings | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<File | null>(null);

  const toastId = useRef(0);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const pushToast = (tone: ToastItem['tone'], title: string, description?: string) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts.slice(-2), { id, tone, title, description }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4500);
  };
  const dismissToast = (id: number) => setToasts((ts) => ts.filter((t) => t.id !== id));

  const isAdmin = saas && user?.role === 'admin';

  // Left sub-nav sections (flows-reports mockup `.snav`) — visibility mirrors
  // which cards this mode actually renders.
  const sections = useMemo<SettingsSectionLink[]>(() => {
    const list: SettingsSectionLink[] = [
      { id: 'settings-tax', label: 'Tax defaults', icon: SlidersHorizontal }
    ];
    if (isAdmin) {
      list.push({ id: 'settings-admin-network', label: 'Network defaults', icon: Globe });
      list.push({ id: 'settings-admin-keys', label: 'Server API keys', icon: KeyRound });
    } else if (!saas) {
      list.push({ id: 'settings-network', label: 'Network features', icon: Globe });
    }
    if (!isAdmin) list.push({ id: 'settings-ai', label: 'AI advisor', icon: Sparkles });
    list.push({ id: 'settings-data', label: 'Your data', icon: Database });
    if (saas && !isAdmin) list.push({ id: 'settings-subscription', label: 'Subscription', icon: Star });
    if (!saas) list.push({ id: 'settings-registries', label: 'Address registries', icon: Wallet });
    list.push({ id: 'settings-appearance', label: 'Appearance', icon: Sun });
    return list;
  }, [saas, isAdmin]);

  const sectionIds = sections.map((s) => s.id).join(',');
  const [activeSection, setActiveSection] = useState(sectionIds.split(',')[0]);

  // Highlight the sub-nav link for the section currently in view. Guarded:
  // jsdom (unit tests) has no IntersectionObserver.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveSection(entry.target.id);
        }
      },
      { rootMargin: '-25% 0px -65% 0px' }
    );
    for (const id of sectionIds.split(',')) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [sectionIds]);

  const navigate = (id: string) => {
    setActiveSection(id);
    document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  };

  const runRestore = async (file: File) => {
    try {
      const { imported } = await importFullBackup(file);
      // Restore replaced the settings row in IndexedDB — refresh the mounted UI
      // state so a later toggle doesn't overwrite the just-restored settings.
      setSettings(await loadSettings());
      pushToast('gain', 'Backup restored', `Restored ${imported} transactions.`);
    } catch (err) {
      pushToast('loss', 'Restore failed', err instanceof Error ? err.message : 'Failed to restore backup.');
    } finally {
      setPendingRestore(null);
    }
  };

  useEffect(() => {
    loadSettings().then((s) => setSettings(s));
  }, []);

  if (!settings) return null;

  const update = async (patch: Partial<TaxSettings>) => {
    // Optimistic UI first (toggles feel instant), then merge into the RAW
    // local row — persisting the effective (server-merged) view would
    // clobber local-only fields (BYOK API keys, manualEvmChain) and stamp
    // server-derived flags into the local row. The UI state finally re-loads
    // via loadSettings so it keeps reflecting the effective view.
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    const local = await getSettings();
    await saveSettings({ ...local, ...patch });
    setSettings(await loadSettings());
    pushToast('gain', 'Settings saved');
  };

  return (
    <div>
      <div className="max-w-2xl">
        <h2 className="page-title">Settings</h2>
        <p className="mt-1 text-sm text-low">
          {isAdmin
            ? 'Admin: manage server API keys below. Tax preferences are still local to this browser.'
            : saas
              ? 'Tax preferences stored locally. Network features run through SoloLedger — no API keys needed.'
              : 'Stored locally in IndexedDB. Nothing here is synced anywhere.'}
        </p>
      </div>

      <div className="mt-8 flex items-start gap-9">
        <SettingsSubNav sections={sections} activeId={activeSection} onNavigate={navigate} />

        <div className="min-w-0 max-w-2xl flex-1 space-y-6">
          <div id="settings-tax" className="scroll-mt-24">
            <Card>
              <CardHeader>
                <CardTitle>Tax defaults</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
                  <label className="block">
                    <span className="text-xs font-semibold text-low">Jurisdiction</span>
                    <select
                      value={settings.jurisdiction}
                      onChange={(e) => update({ jurisdiction: e.target.value as Jurisdiction, reportingCurrency: JURISDICTIONS[e.target.value as Jurisdiction].currency })}
                      className="sl-select mt-1.5 block w-full"
                    >
                      {Object.values(JURISDICTIONS).map((j) => (
                        <option key={j.code} value={j.code}>
                          {j.label} ({j.currency})
                        </option>
                      ))}
                    </select>
                    <span className="mt-1.5 block text-xs leading-relaxed text-low">
                      Sets tax rules and the reporting currency across every report.
                    </span>
                  </label>
                  <label className="block">
                    <span className="text-xs font-semibold text-low">Default cost basis method</span>
                    <select
                      value={settings.defaultCostBasisMethod}
                      onChange={(e) => update({ defaultCostBasisMethod: e.target.value as TaxSettings['defaultCostBasisMethod'] })}
                      className="sl-select mt-1.5 block w-full"
                    >
                      <option value="FIFO">FIFO — First In, First Out</option>
                      <option value="LIFO">LIFO — Last In, First Out</option>
                      <option value="HIFO">HIFO — Highest In, First Out</option>
                      <option value="SpecID">Specific Identification</option>
                    </select>
                    <span className="mt-1.5 block text-xs leading-relaxed text-low">
                      Applied per asset, across all connections.
                    </span>
                  </label>
                  <label className="block sm:col-span-2">
                    <span className="text-xs font-semibold text-low">Derivatives tax treatment</span>
                    <select
                      value={settings.derivativesTreatment ?? (settings.jurisdiction === 'IN' || settings.jurisdiction === 'CA' ? 'business_income' : 'capital_gains')}
                      onChange={(e) =>
                        update({
                          derivativesTreatment: e.target.value as TaxSettings['derivativesTreatment']
                        })
                      }
                      className="sl-select mt-1.5 block w-full"
                    >
                      <option value="business_income">Business income &amp; expenses (profits − fees/losses)</option>
                      <option value="capital_gains">Capital gains / losses</option>
                    </select>
                    <span className="mt-1.5 block text-xs leading-relaxed text-low">
                      Applies to Hyperliquid perps and other derivative imports. Defaults by jurisdiction (India/Canada →
                      business income). Change anytime — reports update without re-importing.
                    </span>
                  </label>
                </div>
              </CardContent>
            </Card>
          </div>

          {isAdmin && <AdminServerSettings />}

          {!saas && (
            <div id="settings-network" className="scroll-mt-24">
              <Card>
                <CardHeader className="flex items-center gap-3">
                  <CardTitle>Network features</CardTitle>
                  <Badge tone="gain" className="ml-auto">
                    <Shield className="h-3 w-3" aria-hidden="true" />
                    Off by default
                  </Badge>
                </CardHeader>
                <CardContent className="py-2">
                  <div className="divide-y divide-hi/10">
                    <div className="py-4">
                      <ToggleRow
                        title="Live price lookup"
                        checked={settings.priceApiEnabled}
                        onChange={(v) => update({ priceApiEnabled: v })}
                        caption={
                          <PrivacyCaption>
                            <strong className="text-mid">Leaves your device:</strong> asset symbol + date only, to
                            price APIs to fill in market values — never wallet addresses or amounts.
                          </PrivacyCaption>
                        }
                      />
                      {settings.priceApiEnabled && (
                        <div className="mt-3 space-y-4 rounded-xl border border-hi/10 bg-elev-1/70 p-4">
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
                    </div>
                    <div className="py-4">
                      <ToggleRow
                        title="Wallet address lookup"
                        checked={settings.rpcLookupEnabled}
                        onChange={(v) => update({ rpcLookupEnabled: v })}
                        caption={
                          <PrivacyCaption>
                            <strong className="text-mid">Leaves your device:</strong> the public address you look up,
                            to public RPC/explorer endpoints — already-public chain data; your keys are never
                            involved.
                          </PrivacyCaption>
                        }
                      />
                      {settings.rpcLookupEnabled && (
                        <div className="mt-3 space-y-4 rounded-xl border border-hi/10 bg-elev-1/70 p-4">
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
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {!saas && (
            <div id="settings-ai" className="scroll-mt-24">
              <Card>
                <CardHeader className="flex items-center gap-3">
                  <CardTitle>AI Tax Advisor</CardTitle>
                  {settings.aiConsentGranted ? (
                    <Badge tone="gain" className="ml-auto">
                      <Sparkles className="h-3 w-3" aria-hidden="true" />
                      Opted in
                    </Badge>
                  ) : (
                    <Badge tone="neutral" className="ml-auto">
                      Off by default
                    </Badge>
                  )}
                </CardHeader>
                <CardContent className="space-y-4">
                  <ToggleRow
                    title="AI Tax Advisor"
                    checked={Boolean(settings.aiConsentGranted)}
                    onChange={(v) => update({ aiConsentGranted: v })}
                    caption={
                      <span className="mt-1 block text-xs leading-relaxed text-low">
                        Off by default — check to opt in. The advisor stays off until you explicitly enable it here
                        or from its panel.
                      </span>
                    }
                  />
                  <ApiKeyField
                    label="OpenRouter API key"
                    value={settings.aiApiKey}
                    onSave={(key) => update({ aiApiKey: key })}
                    onDelete={() => update({ aiApiKey: undefined })}
                    placeholder="sk-or-v1-…"
                  />
                  <div className="rounded-xl border border-primary/25 bg-primary/[0.06] p-4 text-xs leading-relaxed text-low">
                    <p className="flex items-center gap-2 font-semibold text-hi">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-aurora text-on-aurora">
                        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                      </span>
                      How your AI data travels
                    </p>
                    <p className="mt-2">
                      <strong className="text-accent">With your own OpenRouter key (this build):</strong> the
                      aggregated summary goes <strong className="text-mid">directly</strong> to OpenRouter —
                      SoloLedger never sees it.
                    </p>
                    <p className="mt-1">
                      <strong className="text-primary">On the hosted SoloLedger app with no key:</strong> the same
                      summary is <strong className="text-mid">relayed</strong> through SoloLedger's server to
                      OpenRouter.
                    </p>
                    <p className="mt-1">
                      Either way, only an aggregated summary (holdings, cost basis, realized gains, jurisdiction)
                      and your typed question leave the device — never raw wallet addresses or transaction hashes.
                      The advisor is off until you opt in, and you can revoke consent any time from its panel or
                      here.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {saas && !isAdmin && (
            <div id="settings-ai" className="scroll-mt-24">
              <Card>
                <CardHeader className="flex items-center gap-3">
                  <CardTitle>AI Tax Advisor</CardTitle>
                  <Badge tone="gain" className="ml-auto">
                    <Sparkles className="h-3 w-3" aria-hidden="true" />
                    On for subscribers
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-4">
                  <ToggleRow
                    title="AI Tax Advisor"
                    checked={settings.aiConsentGranted !== false}
                    onChange={(v) => update({ aiConsentGranted: v })}
                    caption={
                      <span className="mt-1 block text-xs leading-relaxed text-low">
                        On by default for subscribers — uncheck anytime to opt out.
                      </span>
                    }
                  />
                  <div className="rounded-xl border border-primary/25 bg-primary/[0.06] p-4 text-xs leading-relaxed text-low">
                    <p className="flex items-center gap-2 font-semibold text-hi">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-aurora text-on-aurora">
                        <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                      </span>
                      How your AI data travels
                    </p>
                    <p className="mt-2">
                      On the hosted app you don't add an OpenRouter key. When you ask the AI Advisor a question, an
                      aggregated summary (holdings, cost basis, realized gains, jurisdiction) plus your typed
                      question is <strong className="text-primary">relayed</strong> through SoloLedger's server to
                      OpenRouter — never raw wallet addresses or transaction hashes. The advisor is on by default
                      for subscribers, and you can turn it off any time from its panel or the checkbox above.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          <div id="settings-data" className="scroll-mt-24">
            <Card>
              <CardHeader>
                <CardTitle>Your data</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Button variant="secondary" className="flex-1" onClick={() => exportFullBackup()}>
                    <Download className="h-4 w-4" aria-hidden="true" />
                    Export full backup (JSON)
                  </Button>
                  <label className="flex-1">
                    <input
                      type="file"
                      accept="application/json"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0] ?? null;
                        // Reset so re-selecting the same file fires onChange again.
                        e.target.value = '';
                        if (file) setPendingRestore(file);
                      }}
                    />
                    <span className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-hi/10 bg-elev-1 px-5 text-sm font-bold text-hi shadow-xs transition-all hover:border-primary/40 hover:bg-primary/[0.06] hover:text-primary">
                      <Upload className="h-4 w-4" aria-hidden="true" />
                      Import backup
                    </span>
                  </label>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-low">
                  Everything lives in this browser's IndexedDB — a backup file is the only copy. Keep one somewhere
                  safe.
                </p>

                {pendingRestore && (
                  <div className="mt-4 rounded-xl border border-warn/30 bg-warn/10 p-4">
                    <p className="text-sm font-semibold text-hi">Restore this backup?</p>
                    <p className="mt-1 text-sm text-warn">
                      Restoring replaces all local data with the backup. Continue?
                    </p>
                    <div className="mt-3 flex items-center gap-3">
                      <Button variant="danger" size="sm" onClick={() => runRestore(pendingRestore)}>
                        Yes, restore backup
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setPendingRestore(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                <div
                  data-testid="danger-zone"
                  className="mt-5 rounded-xl border border-loss/30 bg-loss/[0.06] p-4 sm:p-5"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1 basis-64">
                      <h3 className="text-sm font-bold text-loss">Danger zone</h3>
                      <p className="mt-1.5 text-xs leading-relaxed text-low">
                        Erase every transaction, connection, key and setting stored in this browser. There is no
                        server copy to fall back on.
                      </p>
                    </div>
                    {!confirmDelete ? (
                      <Button variant="danger" size="sm" className="shrink-0" onClick={() => setConfirmDelete(true)}>
                        Delete all local data
                      </Button>
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="text-sm text-loss">
                          This permanently deletes everything. Are you sure?
                        </span>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={async () => {
                            await clearAllData();
                            // clearAllData resets settings to defaults in IndexedDB —
                            // refresh the mounted UI state to match.
                            setSettings(await loadSettings());
                            setConfirmDelete(false);
                            pushToast(
                              'warn',
                              'All local data erased',
                              'Every transaction, connection, key and setting in this browser was deleted.'
                            );
                          }}
                        >
                          Yes, delete everything
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
                          Cancel
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          {saas && !isAdmin && (
            <div id="settings-subscription" className="scroll-mt-24">
              <SubscriptionCard />
            </div>
          )}

          {!saas && (
            <div id="settings-registries" className="scroll-mt-24">
              <AddressRegistrySettingsSection coingeckoApiKey={settings.coingeckoApiKey} />
            </div>
          )}

          <div id="settings-appearance" className="scroll-mt-24">
            <AppearanceSettings />
          </div>
        </div>
      </div>

      <ToastViewport>
        {toasts.map((t) => (
          <Toast
            key={t.id}
            tone={t.tone}
            title={t.title}
            description={t.description}
            onDismiss={() => dismissToast(t.id)}
          />
        ))}
      </ToastViewport>
    </div>
  );
}
