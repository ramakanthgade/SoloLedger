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
import { fetchWalletActiveChains } from '@/lib/rpc/moralis';
import {
  allChainsChecked,
  reconcileCheckedChains,
  runSequentialChainImport,
  setAllChains,
  toggleChain,
  type ChainImportOutcome
} from '@/lib/rpc/multiChainImport';
import { runWalletImport, useImportJob, importJob } from '@/lib/importJob';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/card';
import { AlertTriangle, RefreshCw, Trash2, Pencil, Check, X } from 'lucide-react';
import { syncCoinGeckoRewardRegistryInBackground } from '@/lib/assets/coingeckoRewardRegistry';

const inputCls =
  'mt-1 block w-full rounded border border-white/10 bg-elev-2 px-2 py-1.5 text-sm text-mid focus:border-violet focus:outline-none';

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

/** True for an EVM-format address (0x + 40 hex). */
function isEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

const EVM_CHAIN_IDS: ChainId[] = ['ethereum', 'polygon', 'arbitrum', 'base', 'bsc', 'optimism', 'avalanche'];

/** Debounce between the last keystroke and the Moralis active-chains call. */
const CHAIN_DETECT_DEBOUNCE_MS = 500;
/** Cap detection calls per paste burst; extra addresses still import on the detected chains. */
const MAX_DETECTION_ADDRESSES = 10;

/** Chain-detection lifecycle for EVM addresses. */
type ChainDetection =
  | { status: 'idle' }
  | { status: 'detecting' }
  /** `chains` = outgoing-verified; `incomingOnly` = spam-airdrop pattern, note-only. */
  | { status: 'done'; chains: ChainId[]; incomingOnly: ChainId[] }
  | { status: 'none' }
  | { status: 'failed' }
  | { status: 'unavailable' };

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
  /** Active-chain detection lifecycle for pasted EVM addresses. */
  const [detection, setDetection] = useState<ChainDetection>({ status: 'idle' });
  /** Checked chains in the detected-chain picker (defaults to all detected). */
  const [checkedChains, setCheckedChains] = useState<Set<ChainId>>(new Set());
  /** Escape hatch: force the classic single-chain dropdown for EVM addresses. */
  const [manualChainMode, setManualChainMode] = useState(false);
  /** Aggregated per-chain results after a multi-chain import. */
  const [chainSummary, setChainSummary] = useState<ChainImportOutcome[] | null>(null);
  /** Chain currently importing (multi-chain progress line). */
  const [importingChain, setImportingChain] = useState<ChainId | null>(null);
  /** Previous detected chain set — preserves checkbox choices across re-detects. */
  const detectedRef = useRef<ChainId[]>([]);

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

  const parsedAddresses = addressText.split(/[\n,]/).map((a) => a.trim()).filter(Boolean);
  const evmAddresses = parsedAddresses.filter(isEvmAddress);
  const hasEvm = evmAddresses.length > 0;
  // Moralis active-chain detection is possible in hosted (relay) mode with no
  // user key, or in BYOK when a Moralis key was pasted.
  const canDetectChains = isSaasMode() || Boolean(settings?.moralisApiKey?.trim());

  // Debounced active-chain detection for EVM addresses. Every failure mode
  // falls back softly to the manual single-chain dropdown.
  useEffect(() => {
    if (!hasEvm || manualChainMode) {
      detectedRef.current = [];
      setDetection({ status: 'idle' });
      return;
    }
    if (!canDetectChains) {
      detectedRef.current = [];
      setDetection({ status: 'unavailable' });
      return;
    }
    setDetection({ status: 'detecting' });
    let cancelled = false;
    const targets = evmAddresses.slice(0, MAX_DETECTION_ADDRESSES);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const found = new Set<ChainId>();
          const incoming = new Set<ChainId>();
          for (const addr of targets) {
            // eslint-disable-next-line no-await-in-loop
            const result = await fetchWalletActiveChains(addr, settings?.moralisApiKey ?? '');
            result.active.forEach((c) => found.add(c));
            result.incomingOnly.forEach((c) => incoming.add(c));
          }
          if (cancelled) return;
          const chains = CHAINS.filter((c) => found.has(c.id)).map((c) => c.id);
          // A chain with outgoing activity on ANY pasted wallet is active —
          // never note it as incoming-only because another wallet only
          // received (spam) there.
          const incomingOnly = CHAINS.filter((c) => incoming.has(c.id) && !found.has(c.id)).map(
            (c) => c.id
          );
          if (chains.length === 0) {
            detectedRef.current = [];
            setDetection({ status: 'none' });
            return;
          }
          // Capture the previous detection BEFORE updating the ref: React may
          // invoke the state updater lazily, after the ref already points at
          // the new chains — reading the ref inside the updater would treat
          // every chain as "previously detected but unchecked" and clear all
          // checkboxes.
          const prevDetected = detectedRef.current;
          setCheckedChains((prev) => reconcileCheckedChains(prev, prevDetected, chains));
          detectedRef.current = chains;
          setDetection({ status: 'done', chains, incomingOnly });
        } catch {
          if (!cancelled) setDetection({ status: 'failed' });
        }
      })();
    }, CHAIN_DETECT_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // evmAddresses/hasEvm derive from addressText; settings identity is stable after load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addressText, manualChainMode, canDetectChains, settings]);

  // A new paste invalidates the previous multi-chain summary.
  useEffect(() => { setChainSummary(null); }, [addressText]);

  if (settings === null) return <p className="text-sm text-low">Loading wallet lookup…</p>;

  if (!settings.rpcLookupEnabled) {
    return (
      <div className="rounded-lg border border-white/10 bg-elev-2 p-4 text-sm text-low">
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

  const alreadyImported = parsedAddresses.filter((a) =>
    lookedUp.some((r) => r.chain === chainId && r.address.toLowerCase() === a.toLowerCase())
  );
  const freshAddresses = parsedAddresses.filter((a) =>
    !lookedUp.some((r) => r.chain === chainId && r.address.toLowerCase() === a.toLowerCase())
  );

  // Multi-chain picker flow (EVM addresses with successful detection).
  const showChainPicker = hasEvm && !manualChainMode && detection.status === 'done';
  const showDetecting = hasEvm && !manualChainMode && detection.status === 'detecting';
  const pickerChains = detection.status === 'done' ? detection.chains : [];
  const incomingOnlyChains = detection.status === 'done' ? detection.incomingOnly : [];
  const selectedChains = pickerChains.filter((c) => checkedChains.has(c));
  const multiFreshTotal = selectedChains.reduce(
    (total, cid) =>
      total +
      evmAddresses.filter(
        (a) => !lookedUp.some((r) => r.chain === cid && r.address.toLowerCase() === a.toLowerCase())
      ).length,
    0
  );
  // Wallets fresh on at least one selected chain — the wallets the import will
  // actually fetch. The button label counts these so a mixed paste (some
  // addresses already imported on every selected chain) does not over-promise.
  // Falls back to the pasted count when nothing is fresh so the disabled
  // button still reads sensibly next to the "already imported" note.
  const multiFreshWallets = evmAddresses.filter((a) =>
    selectedChains.some(
      (cid) => !lookedUp.some((r) => r.chain === cid && r.address.toLowerCase() === a.toLowerCase())
    )
  );
  const multiImportWalletCount =
    multiFreshWallets.length > 0 ? multiFreshWallets.length : evmAddresses.length;

  const startImport = (addressesOverride?: string[]) => {
    const addrs = addressesOverride ?? freshAddresses;
    if (addrs.length === 0 || job.active) return;
    // Generic registry refresh only: no wallet address is included in these
    // CoinGecko requests. Seven-day cache + single-flight keep this best effort.
    syncCoinGeckoRewardRegistryInBackground(settings.coingeckoApiKey);
    importJob.reset();
    setChainSummary(null);
    void runWalletImport(addrs, chain, settings, buildLookupConfig(chain, settings, {
      customBaseUrl: customBaseUrl || settings.customExplorerBaseUrl,
      customApiKey: customApiKey || settings.customExplorerApiKey,
      customAsset
    }));
  };

  /**
   * Multi-chain import: run the existing single-chain path once per selected
   * chain, sequentially, then show an aggregated per-chain summary.
   */
  const startMultiChainImport = async () => {
    if (evmAddresses.length === 0 || selectedChains.length === 0 || job.active) return;
    syncCoinGeckoRewardRegistryInBackground(settings.coingeckoApiKey);
    importJob.reset();
    setChainSummary(null);
    try {
      const outcomes = await runSequentialChainImport(evmAddresses, selectedChains, {
        settings,
        lookupExtras: {
          customBaseUrl: customBaseUrl || settings.customExplorerBaseUrl,
          customApiKey: customApiKey || settings.customExplorerApiKey,
          customAsset
        },
        onChainStart: (cid) => setImportingChain(cid)
      });
      setChainSummary(outcomes);
    } catch (err) {
      // The orchestrator itself failed outside a per-chain import (e.g. the
      // lookup-registry read rejected) — surface it like a single-chain error
      // instead of letting the void call reject unhandled.
      importJob._error(err instanceof Error ? err.message : 'Import failed.');
    } finally {
      setImportingChain(null);
    }
  };

  const saveLabel = async (id: string) => {
    await updateWalletLabel(id, labelDraft);
    setEditingLabel(null);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-white/10 bg-elev-2 p-4">
        <div className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {isSaasMode()
              ? 'Whichever explorer answers will see every address you query. Lookups run through SoloLedger\'s secure proxy — no API keys needed.'
              : 'Whichever explorer answers will see every address you query. Bitcoin uses Blockstream (no key); other chains use your own Alchemy key.'}
          </span>
        </div>

        <label className="text-xs text-low">
          Wallet addresses — one per line or comma-separated
          <textarea
            className={`${inputCls} h-24 font-mono`}
            value={addressText}
            onChange={(e) => setAddressText(e.target.value)}
            placeholder={
              'Paste any wallet addresses here.\nThe app auto-detects BTC, Solana, and the active chains of EVM wallets.\nYou can always pick a chain manually below.'
            }
          />
        </label>

        {/* EVM active-chain detection: progress line, chain picker, or notes above the manual dropdown */}
        {showDetecting && (
          <p className="flex items-center gap-2 text-xs text-low">
            <RefreshCw className="h-3 w-3 animate-spin" /> Detecting the chains this wallet is active on…
          </p>
        )}

        {showChainPicker && (
          <div className="space-y-2 rounded-lg border border-white/10 bg-elev-3/30 px-3 py-2.5" data-testid="chain-picker">
            <label className="flex items-center gap-2 text-xs font-medium text-mid">
              <input
                type="checkbox"
                className="accent-violet"
                checked={allChainsChecked(pickerChains, checkedChains)}
                onChange={(e) => setCheckedChains(setAllChains(pickerChains, e.target.checked))}
              />
              All active chains
            </label>
            <div className="grid gap-1.5 pl-5 sm:grid-cols-2">
              {pickerChains.map((cid) => (
                <label key={cid} className="flex items-center gap-2 text-xs text-mid">
                  <input
                    type="checkbox"
                    className="accent-violet"
                    checked={checkedChains.has(cid)}
                    onChange={(e) => setCheckedChains((prev) => toggleChain(prev, cid, e.target.checked))}
                  />
                  {CHAINS.find((c) => c.id === cid)?.label ?? cid}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-low">
              Chains with no detected activity are hidden.{' '}
              <button
                type="button"
                className="underline hover:text-mid"
                onClick={() => setManualChainMode(true)}
              >
                choose a chain manually instead
              </button>
            </p>
            {incomingOnlyChains.length > 0 && (
              <p className="text-[11px] text-low" data-testid="incoming-only-note">
                Incoming-only activity (usually spam airdrops) also found on:{' '}
                {incomingOnlyChains
                  .map((cid) => CHAINS.find((c) => c.id === cid)?.label ?? cid)
                  .join(', ')}
                . Not listed above — pick a chain manually if you actually need one.
              </p>
            )}
          </div>
        )}

        {hasEvm && !manualChainMode && detection.status === 'failed' && (
          <p className="text-xs text-low">
            Couldn't detect active chains automatically — pick a chain manually below.
          </p>
        )}
        {hasEvm && !manualChainMode && detection.status === 'unavailable' && (
          <p className="text-xs text-low">
            Paste a free Moralis API key in Settings to auto-detect the chains a wallet is active on.
          </p>
        )}
        {hasEvm && !manualChainMode && detection.status === 'none' && (
          <p className="text-xs text-low">
            No activity found on supported chains for this address — pick a chain manually below.
          </p>
        )}

        {/* Chain selector — manual fallback (or default when nothing pasted); hidden for auto-detected BTC/Solana and while the chain picker is up */}
        {!showChainPicker && !showDetecting && (
          parsedAddresses.length === 0 || isEvm || chainId === 'custom_evm' || hasEvm ? (
            <label className="text-xs text-low">
              Chain
              {(isBitcoin || isSolana) && <span className="ml-1 text-gain">(auto-detected)</span>}
              <select className={inputCls} value={chainId} onChange={(e) => setChainId(e.target.value as ChainId)}>
                {CHAINS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} {c.needsKey ? '' : '(no key needed)'}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="flex items-center gap-2 text-xs text-gain">
              <Check className="h-3.5 w-3.5" />
              Auto-detected: <strong>{chain.label}</strong>
              <button
                className="text-low underline hover:text-mid"
                onClick={() => {/* show full selector */}}
              >
                change
              </button>
              <select
                className="rounded border border-white/10 bg-elev-2 px-2 py-0.5 text-xs text-mid"
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
          )
        )}

        {manualChainMode && hasEvm && canDetectChains && (
          <button
            type="button"
            className="text-xs text-low underline hover:text-mid"
            onClick={() => setManualChainMode(false)}
          >
            auto-detect chains instead
          </button>
        )}

        {missingAlchemyKey && (
          <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            Add a free Alchemy API key in Settings — one key covers this chain plus all others.
          </p>
        )}

        {chain.provider === 'etherscan_compatible' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-low sm:col-span-2">
              Explorer base URL
              <input className={inputCls} value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)} placeholder="https://api.etherscan.io/v2/api?chainid=..." />
            </label>
            <label className="text-xs text-low">
              API key
              <input className={inputCls} value={customApiKey} onChange={(e) => setCustomApiKey(e.target.value)} />
            </label>
            <label className="text-xs text-low">
              Asset label
              <input className={inputCls} value={customAsset} onChange={(e) => setCustomAsset(e.target.value)} placeholder="e.g. FTM" />
            </label>
          </div>
        )}

        {showChainPicker && evmAddresses.length > 0 && selectedChains.length > 0 && multiFreshTotal === 0 && (
          <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            {evmAddresses.length === 1 ? 'This wallet is' : 'These wallets are'} already imported on the
            selected chains. Use <strong>Sync</strong> in the list below to refresh.
          </div>
        )}
        {showChainPicker &&
          evmAddresses.length > 1 &&
          multiFreshTotal > 0 &&
          multiFreshWallets.length < evmAddresses.length && (
            <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
              {evmAddresses.length - multiFreshWallets.length} already imported on the selected chains (will be
              skipped). {multiFreshWallets.length} new will be imported.
            </div>
          )}
        {!showChainPicker && alreadyImported.length > 0 && freshAddresses.length === 0 && (
          <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            {alreadyImported.length === 1
              ? 'This wallet is already imported.'
              : `All ${alreadyImported.length} addresses are already imported.`}{' '}
            Use <strong>Sync</strong> in the list below to refresh.
          </div>
        )}
        {!showChainPicker && alreadyImported.length > 0 && freshAddresses.length > 0 && (
          <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            {alreadyImported.length} already imported (will be skipped). {freshAddresses.length} new will be imported.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={
              job.active ||
              (showChainPicker
                ? selectedChains.length === 0 || multiFreshTotal === 0
                : freshAddresses.length === 0 || (needsAlchemyKey && missingAlchemyKey))
            }
            onClick={() => (showChainPicker ? void startMultiChainImport() : startImport())}
          >
            {showChainPicker
              ? `Import ${multiImportWalletCount || ''} wallet${multiImportWalletCount === 1 ? '' : 's'} on ${selectedChains.length} chain${selectedChains.length === 1 ? '' : 's'}`
              : `Import ${freshAddresses.length || ''} wallet${freshAddresses.length === 1 ? '' : 's'}`}
          </Button>
          {settings.priceApiEnabled && !job.active && (showChainPicker ? multiFreshTotal > 0 : freshAddresses.length > 0) && (
            <span className="text-xs text-gain">✓ Swap detection + price fetch runs automatically</span>
          )}
        </div>

        {importingChain && job.active && (
          <p className="flex items-center gap-2 text-xs text-low">
            <RefreshCw className="h-3 w-3 animate-spin" />
            Importing {CHAINS.find((c) => c.id === importingChain)?.label ?? importingChain}…
          </p>
        )}

        {/* Aggregated per-chain summary after a multi-chain import */}
        {!job.active && chainSummary && (
          <div className="space-y-1 rounded-lg border border-violet/30 bg-violet/10 px-3 py-2 text-xs" data-testid="chain-summary">
            <p className="font-medium text-mid">Import summary</p>
            {chainSummary.map((o) => (
              <p key={o.chainId} className={o.status === 'failed' ? 'text-loss' : 'text-gain'}>
                {o.status === 'failed' ? '✗' : '✓'} {o.chainLabel}:{' '}
                {o.status === 'skipped'
                  ? 'already imported — skipped'
                  : o.status === 'failed'
                    ? `failed — ${o.error ?? 'import failed'}`
                    : [
                        `${o.imported} transaction${o.imported === 1 ? '' : 's'} imported`,
                        o.skippedAddresses > 0 ? `${o.skippedAddresses} already imported — skipped` : null,
                        o.failures.length > 0 ? `${o.failures.length} wallet${o.failures.length === 1 ? '' : 's'} failed` : null,
                        o.warnings.length > 0 ? `${o.warnings.length} warning${o.warnings.length === 1 ? '' : 's'}` : null
                      ]
                        .filter(Boolean)
                        .join(', ')}
              </p>
            ))}
          </div>
        )}

        {/* Job result (shown after job completes) — hidden when the per-chain summary is up,
            and suppressed mid-batch (importingChain set) so chain N's result doesn't flash between chains */}
        {!job.active && job.result && !chainSummary && !importingChain && (
          <div className="rounded-lg border border-violet/30 bg-violet/10 px-3 py-2 text-xs text-gain">
            <strong>{job.result.imported}</strong> transactions imported
            {job.result.swapsDetected > 0 ? `, ${job.result.swapsDetected} swaps detected` : ''}
            {job.result.pricesUpdated > 0 ? `, ${job.result.pricesUpdated} prices fetched` : ''}.
          </div>
        )}
        {job.error && !chainSummary && (
          <div className="rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">
            {job.error}
          </div>
        )}
        {!job.active && job.warnings.length > 0 && (
          <div className="space-y-1 text-xs text-warn">
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
        <div className="rounded-lg border border-white/10 bg-elev-2 p-4">
          <h3 className="mb-3 text-sm font-medium text-mid">Your wallets</h3>
          <div className="space-y-2">
            {lookedUp.map((row) => {
              const chainLabel = CHAINS.find((c) => c.id === row.chain)?.label ?? row.chain;
              const isEditing = editingLabel === row.id;
              return (
                <div key={row.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-elev-3/40 px-3 py-2 text-xs">
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
                        className="w-44 rounded border border-violet bg-elev-2 px-2 py-0.5 text-xs text-mid focus:outline-none"
                        placeholder="e.g. My Phantom wallet"
                      />
                      <button onClick={() => void saveLabel(row.id)} className="text-gain"><Check className="h-3.5 w-3.5" /></button>
                      <button onClick={() => setEditingLabel(null)} className="text-low"><X className="h-3.5 w-3.5" /></button>
                    </span>
                  ) : (
                    <button
                      onClick={() => { setEditingLabel(row.id); setLabelDraft(row.label ?? ''); }}
                      className="flex items-center gap-1 text-low hover:text-mid"
                      title={row.address}
                    >
                      {row.label
                        ? <span className="font-medium text-mid">{row.label}</span>
                        : <span className="font-mono">{row.address.length > 16 ? `${row.address.slice(0, 8)}…${row.address.slice(-6)}` : row.address}</span>}
                      <Pencil className="h-3 w-3 opacity-40" />
                    </button>
                  )}

                  {row.label && (
                    <span className="font-mono text-low" title={row.address}>
                      {row.address.slice(0, 6)}…{row.address.slice(-4)}
                    </span>
                  )}

                  <span className="text-low">{row.txCount} txs</span>
                  <span className="text-low">synced {new Date(row.lastSyncedAt).toLocaleDateString()}</span>

                  <div className="ml-auto flex gap-2">
                    <button
                      className="flex items-center gap-1 text-gain hover:underline disabled:opacity-40"
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-canvas/60 p-4">
          <div className="max-w-md rounded-lg border border-white/10 bg-elev-2 p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-mid">Remove wallet and its transactions?</h3>
            <p className="mt-2 text-xs text-low">
              Deletes <strong className="text-mid">{removeConfirm.txCount}</strong> transaction
              {removeConfirm.txCount === 1 ? '' : 's'} for{' '}
              <span className="font-mono text-low">{removeConfirm.address}</span>. Cannot be undone.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRemoveConfirm(null)}>Cancel</Button>
              <Button
                variant="secondary"
                className="border-loss/40 text-loss hover:bg-loss/10"
                onClick={async () => {
                  // Capture whether an import was active BEFORE the await: a job
                  // could FINISH during deleteLookupAddressAndTransactions, flipping
                  // active to false — resetting then would erase that just-finished
                  // import's completion banner. Only reset when the job was idle the
                  // whole time (idle before AND after the await).
                  const hadActiveJob = importJob.get().active;
                  await deleteLookupAddressAndTransactions(removeConfirm.id);
                  setRemoveConfirm(null);
                  if (!hadActiveJob && !importJob.get().active) importJob.reset();
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
