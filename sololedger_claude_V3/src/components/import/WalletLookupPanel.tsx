import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  getLookupAddresses,
  deleteLookupAddressAndTransactions,
  updateWalletLabel
} from '@/lib/storage/db';
import { getEffectiveSettings, hasWalletLookupKeys } from '@/lib/saas/effectiveSettings';
import { buildLookupConfig } from '@/lib/saas/lookupConfig';
import { isSaasMode } from '@/lib/saas/config';
import { CHAINS, type ChainId } from '@/lib/rpc/providers';
import { runWalletImport, useImportJob, importJob } from '@/lib/importJob';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { AlertTriangle, RefreshCw, Trash2, Pencil, Check, X } from 'lucide-react';

const inputCls =
  'mt-1 block w-full rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-sm text-mist focus:border-emerald focus:outline-none';

/** Detect blockchain from wallet address format — works for BTC, Solana; EVM still needs chain selection. */
function detectChainFromAddress(address: string): ChainId | null {
  const a = address.trim();
  if (!a) return null;
  // Bitcoin: 1..., 3..., bc1...
  if (/^(1[1-9A-HJ-NP-Za-km-z]{25,34}|3[1-9A-HJ-NP-Za-km-z]{25,34}|bc1[ac-hj-np-z02-9]{6,87})$/i.test(a)) return 'bitcoin';
  // Ethereum / EVM: 0x + 40 hex chars
  if (/^0x[a-fA-F0-9]{40}$/.test(a)) return 'ethereum';
  // Solana: base58, 32–44 chars, no 0x prefix
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && !a.startsWith('bc1')) return 'solana';
  return null;
}

const EVM_CHAIN_IDS: ChainId[] = ['ethereum', 'polygon', 'arbitrum', 'base', 'bsc', 'optimism', 'avalanche'];

export function WalletLookupPanel() {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getEffectiveSettings>> | null>(null);
  const [chainId, setChainId] = useState<ChainId>('solana');
  const [addressText, setAddressText] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [customAsset, setCustomAsset] = useState('');
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const [removeConfirm, setRemoveConfirm] = useState<{ id: string; address: string; txCount: number } | null>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);

  // Global import job state — persists across tab navigation
  const job = useImportJob();

  const lookedUp = useLiveQuery(() => getLookupAddresses(), []) ?? [];

  useEffect(() => { getEffectiveSettings().then(setSettings); }, []);
  useEffect(() => { if (editingLabel) setTimeout(() => labelInputRef.current?.focus(), 30); }, [editingLabel]);

  // Auto-detect chain when addresses are typed
  useEffect(() => {
    const first = addressText.split(/[\n,]/)[0]?.trim();
    if (!first) return;
    const detected = detectChainFromAddress(first);
    if (detected && detected !== chainId) setChainId(detected);
  }, [addressText]);

  if (settings === null) return <p className="text-sm text-mist-400">Loading wallet lookup…</p>;

  if (!settings.rpcLookupEnabled) {
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-800 p-4 text-sm text-mist-400">
        Wallet lookup is off. Enable "Wallet address lookup via public RPC/explorer" in Settings.
      </div>
    );
  }

  const chain = CHAINS.find((c) => c.id === chainId)!;
  const isEvm = EVM_CHAIN_IDS.includes(chainId);
  const isBitcoin = chainId === 'bitcoin';
  const isSolana = chainId === 'solana';
  const needsAlchemyKey =
    (chain.provider === 'alchemy_evm' && chain.id !== 'ethereum') || chain.provider === 'alchemy_solana';
  const missingAlchemyKey = needsAlchemyKey && !hasWalletLookupKeys(settings);

  const parsedAddresses = addressText.split(/[\n,]/).map((a) => a.trim()).filter(Boolean);
  const alreadyImported = parsedAddresses.filter((a) =>
    lookedUp.some((r) => r.chain === chainId && r.address.toLowerCase() === a.toLowerCase())
  );
  const freshAddresses = parsedAddresses.filter((a) =>
    !lookedUp.some((r) => r.chain === chainId && r.address.toLowerCase() === a.toLowerCase())
  );

  const startImport = (addressesOverride?: string[]) => {
    const addrs = addressesOverride ?? freshAddresses;
    if (addrs.length === 0 || job.active) return;
    importJob.reset();
    void runWalletImport(addrs, chain, settings, buildLookupConfig(chain, settings, {
      customBaseUrl: customBaseUrl || settings.customExplorerBaseUrl,
      customApiKey: customApiKey || settings.customExplorerApiKey,
      customAsset
    }));
  };

  const saveLabel = async (id: string) => {
    await updateWalletLabel(id, labelDraft);
    setEditingLabel(null);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-800 p-4">
        <div className="flex items-start gap-2 rounded-lg bg-gold/10 px-3 py-2 text-xs text-gold-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {isSaasMode()
              ? 'Whichever explorer answers will see every address you query. Lookups run through SoloLedger\'s secure proxy — no API keys needed.'
              : 'Whichever explorer answers will see every address you query. Bitcoin uses Blockstream (no key); other chains use your own Alchemy key.'}
          </span>
        </div>

        <label className="text-xs text-mist-400">
          Wallet addresses — one per line or comma-separated
          <textarea
            className={`${inputCls} h-24 font-mono`}
            value={addressText}
            onChange={(e) => setAddressText(e.target.value)}
            placeholder={
              'Paste any wallet addresses here.\nThe app auto-detects BTC, Solana, and Ethereum.\nFor other EVM chains, select below.'
            }
          />
        </label>

        {/* Chain selector — shown for EVM (needed) or custom; hidden for auto-detected BTC/Solana */}
        {parsedAddresses.length === 0 || isEvm || chainId === 'custom_evm' ? (
          <label className="text-xs text-mist-400">
            Chain
            {(isBitcoin || isSolana) && <span className="ml-1 text-emerald-600">(auto-detected)</span>}
            <select className={inputCls} value={chainId} onChange={(e) => setChainId(e.target.value as ChainId)}>
              {CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} {c.needsKey ? '' : '(no key needed)'}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="flex items-center gap-2 text-xs text-emerald-600">
            <Check className="h-3.5 w-3.5" />
            Auto-detected: <strong>{chain.label}</strong>
            <button
              className="text-mist-400 underline hover:text-mist"
              onClick={() => {/* show full selector */}}
            >
              change
            </button>
            <select
              className="rounded border border-ink-600 bg-ink-800 px-2 py-0.5 text-xs text-mist"
              value={chainId}
              onChange={(e) => setChainId(e.target.value as ChainId)}
            >
              {CHAINS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {missingAlchemyKey && (
          <p className="rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold-600">
            Add a free Alchemy API key in Settings — one key covers this chain plus all others.
          </p>
        )}

        {chain.provider === 'etherscan_compatible' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-mist-400 sm:col-span-2">
              Explorer base URL
              <input className={inputCls} value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)} placeholder="https://api.etherscan.io/v2/api?chainid=..." />
            </label>
            <label className="text-xs text-mist-400">
              API key
              <input className={inputCls} value={customApiKey} onChange={(e) => setCustomApiKey(e.target.value)} />
            </label>
            <label className="text-xs text-mist-400">
              Asset label
              <input className={inputCls} value={customAsset} onChange={(e) => setCustomAsset(e.target.value)} placeholder="e.g. FTM" />
            </label>
          </div>
        )}

        {alreadyImported.length > 0 && freshAddresses.length === 0 && (
          <div className="rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold-600">
            {alreadyImported.length === 1
              ? 'This wallet is already imported.'
              : `All ${alreadyImported.length} addresses are already imported.`}{' '}
            Use <strong>Sync</strong> in the list below to refresh.
          </div>
        )}
        {alreadyImported.length > 0 && freshAddresses.length > 0 && (
          <div className="rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold-600">
            {alreadyImported.length} already imported (will be skipped). {freshAddresses.length} new will be imported.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={freshAddresses.length === 0 || job.active || (needsAlchemyKey && missingAlchemyKey)}
            onClick={() => startImport()}
          >
            Import {freshAddresses.length || ''} wallet{freshAddresses.length === 1 ? '' : 's'}
          </Button>
          {settings.priceApiEnabled && !job.active && freshAddresses.length > 0 && (
            <span className="text-xs text-emerald-600">✓ Swap detection + price fetch runs automatically</span>
          )}
        </div>

        {/* Job result (shown after job completes) */}
        {!job.active && job.result && (
          <div className="rounded-lg border border-emerald/30 bg-emerald/10 px-3 py-2 text-xs text-emerald-700">
            <strong>{job.result.imported}</strong> transactions imported
            {job.result.swapsDetected > 0 ? `, ${job.result.swapsDetected} swaps detected` : ''}
            {job.result.pricesUpdated > 0 ? `, ${job.result.pricesUpdated} prices fetched` : ''}.
          </div>
        )}
        {job.error && (
          <div className="rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">
            {job.error}
          </div>
        )}
        {!job.active && job.warnings.length > 0 && (
          <div className="space-y-1 text-xs text-gold-600">
            {job.warnings.slice(0, 6).map((w, i) => <p key={i}>{w}</p>)}
          </div>
        )}
        {!job.active && job.failed.length > 0 && (
          <div className="space-y-1 rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">
            {job.failed.map((f, i) => <p key={i}>{f.address}: {f.message}</p>)}
          </div>
        )}
      </div>

      {/* Saved wallets */}
      {lookedUp.length > 0 && (
        <div className="rounded-lg border border-ink-700 bg-ink-800 p-4">
          <h3 className="mb-3 text-sm font-medium text-mist">Your wallets</h3>
          <div className="space-y-2">
            {lookedUp.map((row) => {
              const chainLabel = CHAINS.find((c) => c.id === row.chain)?.label ?? row.chain;
              const isEditing = editingLabel === row.id;
              return (
                <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-ink-700/40 px-3 py-2 text-xs">
                  <Badge tone="violet">{chainLabel}</Badge>

                  {isEditing ? (
                    <span className="flex items-center gap-1">
                      <input
                        ref={labelInputRef}
                        value={labelDraft}
                        onChange={(e) => setLabelDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveLabel(row.id);
                          if (e.key === 'Escape') setEditingLabel(null);
                        }}
                        className="w-44 rounded border border-emerald bg-ink-800 px-2 py-0.5 text-xs text-mist focus:outline-none"
                        placeholder="e.g. My Phantom wallet"
                      />
                      <button onClick={() => void saveLabel(row.id)} className="text-emerald-600"><Check className="h-3.5 w-3.5" /></button>
                      <button onClick={() => setEditingLabel(null)} className="text-mist-400"><X className="h-3.5 w-3.5" /></button>
                    </span>
                  ) : (
                    <button
                      onClick={() => { setEditingLabel(row.id); setLabelDraft(row.label ?? ''); }}
                      className="flex items-center gap-1 text-mist-300 hover:text-mist"
                      title={row.address}
                    >
                      {row.label
                        ? <span className="font-medium text-mist">{row.label}</span>
                        : <span className="font-mono">{row.address.length > 16 ? `${row.address.slice(0, 8)}…${row.address.slice(-6)}` : row.address}</span>}
                      <Pencil className="h-3 w-3 opacity-40" />
                    </button>
                  )}

                  {row.label && (
                    <span className="font-mono text-mist-400" title={row.address}>
                      {row.address.slice(0, 6)}…{row.address.slice(-4)}
                    </span>
                  )}

                  <span className="text-mist-400">{row.txCount} txs</span>
                  <span className="text-mist-400">synced {new Date(row.lastSyncedAt).toLocaleDateString()}</span>

                  <div className="ml-auto flex gap-2">
                    <button
                      className="flex items-center gap-1 text-emerald-600 hover:underline disabled:opacity-40"
                      disabled={job.active}
                      onClick={() => {
                        const c = CHAINS.find((ch) => ch.id === row.chain);
                        if (!c) return;
                        void runWalletImport(
                          [row.address],
                          c,
                          settings,
                          buildLookupConfig(c, settings, {
                            customBaseUrl: customBaseUrl || settings.customExplorerBaseUrl,
                            customApiKey: customApiKey || settings.customExplorerApiKey,
                            customAsset
                          }),
                          true
                        );
                      }}
                    >
                      <RefreshCw className="h-3 w-3" /> Sync (fetch new txs)
                    </button>
                    <button
                      className="flex items-center gap-1 text-loss hover:underline"
                      onClick={() => setRemoveConfirm({ id: row.id, address: row.address, txCount: row.txCount })}
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Remove confirmation */}
      {removeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4">
          <div className="max-w-md rounded-lg border border-ink-700 bg-ink-800 p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-mist">Remove wallet and its transactions?</h3>
            <p className="mt-2 text-xs text-mist-400">
              Deletes <strong className="text-mist">{removeConfirm.txCount}</strong> transaction
              {removeConfirm.txCount === 1 ? '' : 's'} for{' '}
              <span className="font-mono text-mist-300">{removeConfirm.address}</span>. Cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRemoveConfirm(null)}>Cancel</Button>
              <Button
                variant="secondary"
                className="border-loss/40 text-loss hover:bg-loss/10"
                onClick={async () => {
                  await deleteLookupAddressAndTransactions(removeConfirm.id);
                  setRemoveConfirm(null);
                }}
              >
                Remove wallet
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
