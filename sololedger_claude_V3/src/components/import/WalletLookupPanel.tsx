import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  db,
  getSettings,
  getLookupAddresses,
  upsertLookupAddress,
  deleteLookupAddressAndTransactions,
  updateWalletLabel
} from '@/lib/storage/db';
import { CHAINS, lookupManyAddresses, type ChainId } from '@/lib/rpc/providers';
import { reprocessSwapDetectionInDb } from '@/lib/rpc/reprocessSwaps';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { AlertTriangle, RefreshCw, Trash2, Pencil, Check, X } from 'lucide-react';

const inputCls =
  'mt-1 block w-full rounded border border-ink-600 bg-ink-800 px-2 py-1.5 text-sm text-mist focus:border-violet focus:outline-none';

export function WalletLookupPanel() {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getSettings>> | null>(null);
  const [chainId, setChainId] = useState<ChainId>('bitcoin');
  const [addressText, setAddressText] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [customAsset, setCustomAsset] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [phase, setPhase] = useState<'importing' | 'classifying' | 'pricing' | null>(null);
  const [result, setResult] = useState<{
    imported: number;
    addressesQueried: number;
    pricesUpdated?: number;
  } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [failed, setFailed] = useState<{ address: string; message: string }[]>([]);
  const [removeConfirm, setRemoveConfirm] = useState<{ id: string; address: string; txCount: number } | null>(null);
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState('');
  const labelInputRef = useRef<HTMLInputElement>(null);

  const lookedUp = useLiveQuery(() => getLookupAddresses(), []) ?? [];

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  useEffect(() => {
    if (editingLabel) setTimeout(() => labelInputRef.current?.focus(), 30);
  }, [editingLabel]);

  if (settings === null) return <p className="text-sm text-mist-400">Loading wallet lookup…</p>;

  if (!settings.rpcLookupEnabled) {
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-800 p-4 text-sm text-mist-400">
        Wallet lookup is off. Enable "Wallet address lookup via public RPC/explorer" in Settings to use it.
      </div>
    );
  }

  const chain = CHAINS.find((c) => c.id === chainId)!;
  const needsAlchemyKey =
    (chain.provider === 'alchemy_evm' && chain.id !== 'ethereum') || chain.provider === 'alchemy_solana';
  const missingAlchemyKey = needsAlchemyKey && !settings.alchemyApiKey;

  const runLookup = async (addressesOverride?: string[]) => {
    setLoading(true);
    setResult(null);
    setWarnings([]);
    setFailed([]);
    setProgress(null);
    setPhase('importing');
    const addresses =
      addressesOverride ??
      addressText
        .split(/[\n,]/)
        .map((a) => a.trim())
        .filter(Boolean);

    try {
      const { transactions, warnings: w, failed: f, perAddress } = await lookupManyAddresses(
        addresses,
        {
          chain,
          alchemyApiKey: settings.alchemyApiKey,
          customBaseUrl: customBaseUrl || settings.customExplorerBaseUrl,
          customApiKey: customApiKey || settings.customExplorerApiKey,
          customAsset
        },
        (done, total) => setProgress({ done, total })
      );

      if (transactions.length > 0) {
        await db.transactions.bulkPut(transactions);
      }

      // --- Phase 2: Swap / DeFi classification ---
      setPhase('classifying');
      setProgress(null);
      const swapResult = transactions.length > 0
        ? await reprocessSwapDetectionInDb(
            settings.novesApiKey,
            (done, total) => setProgress({ done, total })
          )
        : null;

      await Promise.all(perAddress.map((p) => upsertLookupAddress(chainId, p.address, p.count)));

      const apiWarnings = w.map((x) => `${x.address}: ${x.message}`);
      if (swapResult && (swapResult.tradesCreated > 0 || swapResult.reclassified > 0)) {
        apiWarnings.unshift(swapResult.message);
      }

      // --- Phase 3: Auto-fetch prices (if enabled) ---
      let pricesUpdated = 0;
      if (settings.priceApiEnabled && transactions.length > 0) {
        setPhase('pricing');
        setProgress(null);
        const priceResult = await fetchMissingPricesForAllTransactions(settings, (done, total) =>
          setProgress({ done, total })
        );
        pricesUpdated = priceResult.updated;
        if (priceResult.updated > 0) {
          apiWarnings.unshift(
            `Fetched prices for ${priceResult.updated} transaction${priceResult.updated === 1 ? '' : 's'}. ` +
              (priceResult.failed > 0 ? `${priceResult.failed} could not be priced (obscure/spam tokens).` : '')
          );
        }
      }

      setResult({ imported: transactions.length, addressesQueried: addresses.length, pricesUpdated });
      setWarnings(apiWarnings);
      setFailed(f);
    } finally {
      setLoading(false);
      setProgress(null);
      setPhase(null);
    }
  };

  const saveLabel = async (id: string) => {
    await updateWalletLabel(id, labelDraft);
    setEditingLabel(null);
  };

  const addressCount = addressText.split(/[\n,]/).map((a) => a.trim()).filter(Boolean).length;

  const phaseLabel = {
    importing: `Importing ${progress ? `${progress.done}/${progress.total}` : ''}…`,
    classifying: `Classifying swaps ${progress ? `${progress.done}/${progress.total}` : ''}…`,
    pricing: `Fetching prices ${progress ? `${progress.done}/${progress.total}` : ''}…`
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-800 p-4">
        <div className="flex items-start gap-2 rounded-lg bg-gold/10 px-3 py-2 text-xs text-gold-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Whichever explorer answers will see every address you query. Bitcoin uses Blockstream (no key); other
            chains use your own Alchemy key.
          </span>
        </div>

        <label className="text-xs text-mist-400">
          Chain
          <select className={inputCls} value={chainId} onChange={(e) => setChainId(e.target.value as ChainId)}>
            {CHAINS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} {c.needsKey ? '' : '(no key needed)'}
              </option>
            ))}
          </select>
        </label>

        {missingAlchemyKey && (
          <p className="rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold-600">
            Add a free Alchemy API key in Settings first — one key covers this chain plus all other EVM chains and
            Solana.
          </p>
        )}

        {chain.provider === 'etherscan_compatible' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-mist-400 sm:col-span-2">
              Explorer base URL
              <input
                className={inputCls}
                value={customBaseUrl}
                onChange={(e) => setCustomBaseUrl(e.target.value)}
                placeholder="https://api.etherscan.io/v2/api?chainid=..."
              />
            </label>
            <label className="text-xs text-mist-400">
              API key
              <input className={inputCls} value={customApiKey} onChange={(e) => setCustomApiKey(e.target.value)} />
            </label>
            <label className="text-xs text-mist-400">
              Asset label
              <input
                className={inputCls}
                value={customAsset}
                onChange={(e) => setCustomAsset(e.target.value)}
                placeholder="e.g. FTM"
              />
            </label>
          </div>
        )}

        <label className="text-xs text-mist-400">
          Wallet addresses — one per line or comma-separated
          <textarea
            className={`${inputCls} h-24 font-mono`}
            value={addressText}
            onChange={(e) => setAddressText(e.target.value)}
            placeholder={'0x1234...\n0xabcd...\nbc1q...'}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={addressCount === 0 || loading || (needsAlchemyKey && missingAlchemyKey)}
            onClick={() => runLookup()}
          >
            {loading
              ? phaseLabel[phase!] ?? 'Working…'
              : `Import ${addressCount || ''} wallet${addressCount === 1 ? '' : 's'}`}
          </Button>
          {settings.priceApiEnabled && !loading && (
            <span className="text-xs text-emerald-600">✓ Prices will be fetched automatically after import</span>
          )}
        </div>

        {result && (
          <div className="rounded-lg border border-emerald/30 bg-emerald/10 px-3 py-2 text-xs text-emerald-700">
            <strong>{result.imported}</strong> transactions imported
            {result.pricesUpdated != null && result.pricesUpdated > 0
              ? `, ${result.pricesUpdated} prices fetched`
              : ''}
            . {settings.priceApiEnabled ? 'Head to Review for any remaining missing prices.' : 'Enable price lookup in Settings to auto-fetch prices.'}
          </div>
        )}
        {warnings.length > 0 && (
          <div className="space-y-1 text-xs text-gold-600">
            {warnings.slice(0, 5).map((w, i) => (
              <p key={i}>{w}</p>
            ))}
          </div>
        )}
        {failed.length > 0 && (
          <div className="space-y-1 rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">
            {failed.map((f, i) => (
              <p key={i}>
                {f.address}: {f.message}
              </p>
            ))}
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
                <div
                  key={row.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg bg-ink-700/40 px-3 py-2 text-xs"
                >
                  <Badge tone="violet">{chainLabel}</Badge>

                  {/* Wallet name / label */}
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
                        className="w-40 rounded border border-violet bg-ink-800 px-2 py-0.5 text-xs text-mist focus:outline-none"
                        placeholder="e.g. My Phantom wallet"
                      />
                      <button onClick={() => void saveLabel(row.id)} className="text-emerald-600">
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setEditingLabel(null)} className="text-mist-400">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        setEditingLabel(row.id);
                        setLabelDraft(row.label ?? '');
                      }}
                      className="flex items-center gap-1 text-mist-300 hover:text-mist"
                      title={row.address}
                    >
                      {row.label ? (
                        <span className="font-medium text-mist">{row.label}</span>
                      ) : (
                        <span className="font-mono">
                          {row.address.length > 16
                            ? `${row.address.slice(0, 8)}…${row.address.slice(-6)}`
                            : row.address}
                        </span>
                      )}
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
                      className="flex items-center gap-1 text-emerald-600 hover:underline"
                      onClick={() => {
                        setChainId(row.chain as ChainId);
                        setAddressText(row.address);
                        void runLookup([row.address]);
                      }}
                    >
                      <RefreshCw className="h-3 w-3" /> Sync
                    </button>
                    <button
                      className="flex items-center gap-1 text-loss hover:underline"
                      onClick={() =>
                        setRemoveConfirm({ id: row.id, address: row.address, txCount: row.txCount })
                      }
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

      {/* Remove confirmation modal */}
      {removeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4">
          <div className="max-w-md rounded-lg border border-ink-700 bg-ink-800 p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-mist">Remove wallet and its transactions?</h3>
            <p className="mt-2 text-xs text-mist-400">
              This deletes <strong className="text-mist">{removeConfirm.txCount}</strong> imported transaction
              {removeConfirm.txCount === 1 ? '' : 's'} for{' '}
              <span className="font-mono text-mist-300">{removeConfirm.address}</span>. Cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRemoveConfirm(null)}>
                Cancel
              </Button>
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
