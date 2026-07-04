import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSettings, getLookupAddresses, upsertLookupAddress, deleteLookupAddress } from '@/lib/storage/db';
import { CHAINS, lookupManyAddresses, type ChainId } from '@/lib/rpc/providers';
import { applyMissingPrices } from '@/lib/pricing/fetchMissingPrices';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';

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
  const [result, setResult] = useState<{ imported: number; addressesQueried: number; priced: number } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [failed, setFailed] = useState<{ address: string; message: string }[]>([]);
  const [priceErrors, setPriceErrors] = useState<string[]>([]);
  const [pricingProgress, setPricingProgress] = useState<{ done: number; total: number } | null>(null);

  const lookedUp = useLiveQuery(() => getLookupAddresses(), []) ?? [];

  useEffect(() => {
    getSettings().then(setSettings);
  }, []);

  if (settings === null) {
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-800 p-4 text-sm text-mist-400">
        Loading wallet lookup settings…
      </div>
    );
  }

  if (!settings.rpcLookupEnabled) {
    return (
      <div className="rounded-lg border border-ink-700 bg-ink-800 p-4 text-sm text-mist-400">
        Wallet lookup is off. Enable "Wallet address lookup via public RPC/explorer" in Settings to use it — any
        explorer you query will see the address(es) you look up. That's inherent to how address lookups work
        (see Settings for why), not a limitation specific to this app.
      </div>
    );
  }

  const chain = CHAINS.find((c) => c.id === chainId)!;
  const needsAlchemyKey = chain.provider === 'alchemy_evm' || chain.provider === 'alchemy_solana';
  const missingAlchemyKey = needsAlchemyKey && !settings.alchemyApiKey;

  const runLookup = async (addressesOverride?: string[]) => {
    setLoading(true);
    setResult(null);
    setWarnings([]);
    setFailed([]);
    setPriceErrors([]);
    setPricingProgress(null);
    const addresses =
      addressesOverride ??
      addressText
        .split(/[\n,]/)
        .map((a) => a.trim())
        .filter(Boolean);

    try {
      const activeSettings = await getSettings();
      const { transactions, warnings: w, failed: f, perAddress } = await lookupManyAddresses(
        addresses,
        {
          chain,
          alchemyApiKey: activeSettings.alchemyApiKey,
          customBaseUrl: customBaseUrl || activeSettings.customExplorerBaseUrl,
          customApiKey: customApiKey || activeSettings.customExplorerApiKey,
          customAsset
        },
        (done, total) => setProgress({ done, total })
      );
      if (transactions.length > 0) await db.transactions.bulkPut(transactions);
      await Promise.all(perAddress.map((p) => upsertLookupAddress(chainId, p.address, p.count)));

      let priced = 0;
      const priceLookupErrors: string[] = [];
      if (activeSettings.priceApiEnabled && transactions.length > 0) {
        // Brief pause after heavy RPC traffic before starting price lookups.
        await new Promise((r) => setTimeout(r, 1500));
        const priceResult = await applyMissingPrices(transactions, activeSettings, (done, total) =>
          setPricingProgress({ done, total })
        );
        priced = priceResult.priced;
        priceLookupErrors.push(...priceResult.errors);
      }

      setResult({ imported: transactions.length, addressesQueried: addresses.length, priced });
      setWarnings(w.map((x) => `${x.address}: ${x.message}`));
      setFailed(f);
      setPriceErrors(priceLookupErrors);
    } finally {
      setLoading(false);
      setProgress(null);
      setPricingProgress(null);
    }
  };

  const addressCount = addressText.split(/[\n,]/).map((a) => a.trim()).filter(Boolean).length;

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-800 p-4">
        <div className="flex items-start gap-2 rounded-lg bg-gold/10 px-3 py-2 text-xs text-gold-600">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Whichever explorer answers this will see every address you query — that's true of any address lookup
            service, free or paid. Bitcoin uses Blockstream (no key needed); other chains use your own Alchemy key
            so the lookup runs under your account, not a shared one.
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
            Add a free Alchemy API key in Settings first — one key covers this chain plus every other EVM chain and
            Solana in this list. Get one at{' '}
            <a href="https://www.alchemy.com" target="_blank" rel="noreferrer" className="underline">
              alchemy.com
            </a>{' '}
            (free tier, no credit card).
          </p>
        )}

        {chain.provider === 'etherscan_compatible' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-mist-400 sm:col-span-2">
              Explorer base URL (Etherscan-compatible)
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

        <label className="text-xs text-mist-400">
          Wallet addresses — one per line (or comma-separated)
          <textarea
            className={inputCls + ' h-24 font-mono'}
            value={addressText}
            onChange={(e) => setAddressText(e.target.value)}
            placeholder={'0x1234...\n0xabcd...\nbc1q...'}
          />
        </label>

        <div className="flex items-center gap-3">
          <Button disabled={addressCount === 0 || loading || (needsAlchemyKey && missingAlchemyKey)} onClick={() => runLookup()}>
            {loading
              ? pricingProgress
                ? `Fetching prices ${pricingProgress.done}/${pricingProgress.total}…`
                : `Looking up ${progress?.done ?? 0}/${progress?.total ?? addressCount}…`
              : `Look up ${addressCount || ''} address${addressCount === 1 ? '' : 'es'}`}
          </Button>
        </div>

        {result && (
          <Badge tone="emerald">
            {result.imported} transactions imported across {result.addressesQueried} address
            {result.addressesQueried === 1 ? '' : 'es'}
            {settings.priceApiEnabled
              ? ` — ${result.priced} priced automatically. Open Review for the full list.`
              : ' — including tokens and NFTs where the chain supports it. Enable Live price lookup in Settings to fill in values automatically.'}
          </Badge>
        )}
        {priceErrors.length > 0 && (
          <div className="space-y-1 rounded-lg border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold-600">
            {priceErrors.slice(0, 5).map((e, i) => (
              <p key={i}>{e}</p>
            ))}
            {priceErrors.length > 5 && <p>…and {priceErrors.length - 5} more price lookup errors.</p>}
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
              <p key={i}>{f.address}: {f.message}</p>
            ))}
          </div>
        )}
      </div>

      {lookedUp.length > 0 && (
        <div className="rounded-lg border border-ink-700 bg-ink-800 p-4">
          <h3 className="mb-3 text-sm font-medium text-mist">Already looked up</h3>
          <div className="space-y-2">
            {lookedUp.map((row) => {
              const chainLabel = CHAINS.find((c) => c.id === row.chain)?.label ?? row.chain;
              return (
                <div key={row.id} className="flex flex-wrap items-center gap-3 rounded-lg bg-ink-700/40 px-3 py-2 text-xs">
                  <Badge tone="violet">{chainLabel}</Badge>
                  <span className="font-mono text-mist-300" title={row.address}>
                    {row.address.length > 16 ? `${row.address.slice(0, 8)}…${row.address.slice(-6)}` : row.address}
                  </span>
                  <span className="text-mist-400">{row.txCount} transactions</span>
                  <span className="text-mist-400">synced {new Date(row.lastSyncedAt).toLocaleDateString()}</span>
                  <div className="ml-auto flex gap-2">
                    <button
                      className="flex items-center gap-1 text-emerald-600 hover:underline"
                      onClick={() => {
                        setChainId(row.chain as ChainId);
                        setAddressText(row.address);
                        runLookup([row.address]);
                      }}
                    >
                      <RefreshCw className="h-3 w-3" /> Look up again
                    </button>
                    <button
                      className="flex items-center gap-1 text-loss hover:underline"
                      onClick={() => deleteLookupAddress(row.id)}
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
    </div>
  );
}
