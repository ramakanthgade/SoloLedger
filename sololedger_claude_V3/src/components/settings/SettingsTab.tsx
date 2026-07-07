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
              the result into your reporting currency. Prices are fetched automatically after CSV import and wallet
              sync; you can also re-run from Review → Fetch missing prices.
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
              <p className="text-xs font-semibold text-emerald-600">
                Primary sources (richest data — use these first)
              </p>
              <ApiKeyField
                label={
                  <>
                    <strong className="text-mist">Helius API key</strong> — PRIMARY for Solana.
                    Returns pre-parsed labels: SWAP, STAKE, NFT_SALE, etc. Handles Jupiter DCA fills
                    with exact token amounts. No Noves needed for Solana. Free tier at{' '}
                    <a href="https://dev.helius.xyz/" target="_blank" rel="noreferrer" className="text-emerald-600 underline">
                      dev.helius.xyz
                    </a>
                  </>
                }
                value={settings.heliusApiKey}
                onSave={(key) => update({ heliusApiKey: key })}
                onDelete={() => update({ heliusApiKey: undefined })}
                placeholder="Paste your Helius API key"
              />
              <ApiKeyField
                label={
                  <>
                    <strong className="text-mist">Moralis API key</strong> — PRIMARY for EVM chains.
                    Returns decoded + spam-flagged transactions with category labels (token swap, nft
                    sale, staking, airdrop). Covers 30+ chains. From{' '}
                    <a href="https://moralis.io/" target="_blank" rel="noreferrer" className="text-emerald-600 underline">
                      moralis.io
                    </a>
                  </>
                }
                value={settings.moralisApiKey}
                onSave={(key) => update({ moralisApiKey: key })}
                onDelete={() => update({ moralisApiKey: undefined })}
                placeholder="Paste your Moralis API key"
              />
              <p className="text-xs font-semibold text-mist-400">
                Fallback sources (used when Helius/Moralis are not set)
              </p>
              <ApiKeyField
                label={
                  <>
                    Alchemy API key (fallback for Solana + EVM — covers Ethereum, Polygon, Arbitrum,
                    Base, BNB Chain, Optimism, Avalanche; free key from{' '}
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
                    Etherscan API key (optional fallback; one key covers many EVM chains via{' '}
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

          {settings.priceApiEnabled && (
            <div className="ml-7 space-y-4 border-l border-ink-700 pl-4">
              <ApiKeyField
                label={
                  <>
                    Birdeye API key (Solana token pricing — covers any SPL token with a DEX pool; free plan from{' '}
                    <a href="https://birdeye.so" target="_blank" rel="noreferrer" className="text-emerald-600 underline">
                      birdeye.so
                    </a>
                    )
                  </>
                }
                value={settings.birdeyeApiKey}
                onSave={(key) => update({ birdeyeApiKey: key })}
                onDelete={() => update({ birdeyeApiKey: undefined })}
                placeholder="Paste your Birdeye API key"
              />
              <ApiKeyField
                label={
                  <>
                    Noves API key (DeFi classification — auto-identifies swaps, staking, LP deposits, etc. on 120+
                    chains; from{' '}
                    <a href="https://noves.fi" target="_blank" rel="noreferrer" className="text-emerald-600 underline">
                      noves.fi
                    </a>{' '}
                    or{' '}
                    <a
                      href="https://marketplace.quicknode.com/add-on/noves-translate-api"
                      target="_blank"
                      rel="noreferrer"
                      className="text-emerald-600 underline"
                    >
                      QuickNode Starter $50/mo
                    </a>
                    )
                  </>
                }
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
          <p className="text-xs text-mist-400">
            Ask your taxes anything — in text or by voice. Uses{' '}
            <a href="https://openrouter.ai" target="_blank" rel="noreferrer" className="text-violet underline">
              OpenRouter
            </a>{' '}
            to route to Claude, GPT-4, Gemini and more. Your existing OpenRouter credits work immediately.
            Your claude.ai subscription is a separate consumer product — for API access, use your{' '}
            <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="text-violet underline">
              openrouter.ai/keys
            </a>{' '}
            key instead.
          </p>
          <ApiKeyField
            label="OpenRouter API key (enables AI Tax Advisor — pay-per-use from your credits)"
            value={settings.aiApiKey}
            onSave={(key) => update({ aiApiKey: key })}
            onDelete={() => update({ aiApiKey: undefined })}
            placeholder="sk-or-v1-…"
          />
          {settings.aiApiKey && (
            <label className="block text-sm text-mist-300">
              AI model
              <select
                value={settings.aiModel ?? 'anthropic/claude-opus-4-5'}
                onChange={(e) => update({ aiModel: e.target.value })}
                className="mt-1 block w-full rounded border border-ink-600 bg-ink-800 px-3 py-2 text-mist focus:border-violet focus:outline-none"
              >
                <option value="anthropic/claude-opus-4-5">Claude Sonnet 4.5 — recommended</option>
                <option value="anthropic/claude-opus-4">Claude Opus 4 — most capable</option>
                <option value="openai/gpt-4o">GPT-4o</option>
                <option value="google/gemini-2.5-flash">Gemini 2.5 Flash — fast & cheap</option>
                <option value="anthropic/claude-3.5-haiku">Claude Haiku 3.5 — fastest</option>
              </select>
            </label>
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
