import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  claimAccountOwnershipPrompt,
  ensureAccountIdentity,
  getLookupAddresses,
  updateAccountOwnership
} from '@/lib/storage/db';
import { getEffectiveSettings, hasWalletLookupKeys } from '@/lib/saas/effectiveSettings';
import { buildLookupConfig } from '@/lib/saas/lookupConfig';
import { isSaasMode } from '@/lib/saas/config';
import { CHAINS, DROPDOWN_HIDDEN_CHAINS, isEvmChain, type ChainId } from '@/lib/rpc/providers';
import { fetchWalletActiveChains } from '@/lib/rpc/moralis';
import {
  allChainsChecked,
  reconcileCheckedChains,
  runSequentialChainImport,
  setAllChains,
  toggleChain,
  type ChainImportOutcome
} from '@/lib/rpc/multiChainImport';
import {
  runWalletImport,
  useImportJob,
  importJob,
  type WalletInitialIdentity
} from '@/lib/importJob';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toast, ToastViewport } from '@/components/ui/toast';
import { AlertTriangle, Check, Eye, RefreshCw } from 'lucide-react';
import { syncCoinGeckoRewardRegistryInBackground } from '@/lib/assets/coingeckoRewardRegistry';
import { BrandIcon, chainIconId } from './brandIcons';
import { canonicalWalletAddress } from '@/lib/ledger/chainNamespace';
import { isBitcoinAddress, isEvmAddress, isSolanaAddress } from '@/lib/rpc/walletAddressValidation';
import { walletAccountCanonicalKey, type AccountIdentityRow } from '@/lib/accounts/accountIdentity';
import { SourceOwnershipDialog, type SourceOwnershipDecision } from './SourceOwnershipDialog';

const inputCls =
  'mt-1 block w-full rounded-lg border border-hi/10 bg-elev-1 px-3.5 py-2.5 text-sm text-hi shadow-xs transition-colors placeholder:text-faint hover:border-hi/20 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30';

/** Detect blockchain from wallet address format — works for BTC, Solana; EVM still needs chain selection. */
function detectChainFromAddress(address: string): ChainId | null {
  const a = address.trim();
  if (!a) return null;
  if (isBitcoinAddress(a)) return 'bitcoin';
  if (isEvmAddress(a)) return 'ethereum';
  if (isSolanaAddress(a) && !a.startsWith('bc1')) return 'solana';
  return null;
}

const EVM_CHAIN_IDS: ChainId[] = CHAINS.filter(
  (chain) => chain.provider === 'alchemy_evm' && !DROPDOWN_HIDDEN_CHAINS.has(chain.id)
).map((chain) => chain.id);

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
  /** No outgoing activity anywhere — still surfaces incoming-only (spam) finds. */
  | { status: 'none'; incomingOnly: ChainId[] }
  | { status: 'failed' }
  | { status: 'unavailable' };

/** One-line note about chains with incoming-only (usually spam) activity.
 *  Shared by the chain picker and the "no outgoing activity" state. */
function IncomingOnlyNote({ chains }: { chains: ChainId[] }) {
  if (chains.length === 0) return null;
  return (
    <p className="text-[11px] text-low" data-testid="incoming-only-note">
      Incoming-only activity (usually spam airdrops) found on:{' '}
      {chains.map((cid) => CHAINS.find((c) => c.id === cid)?.label ?? cid).join(', ')}. Not
      auto-listed — pick a chain manually if you actually need one.
    </p>
  );
}

interface WalletAddressFormProps {
  /** Chain picked in the drawer's Which step (Blockchain address flow), or the
   *  wallet app's headline chain from the catalog (Wallet app flow). */
  preselectChain?: ChainId;
  /** Wallet-name prefill (required field) — the wallet-app flow passes the app name ("MetaMask"). */
  defaultLabel?: string;
  /** Wallet catalog identity selected in step 2; persisted independently of the editable label. */
  walletAppId?: string;
  /** Return to the wallet-app picker while the import continues in the background. */
  onAddAnother?: () => void;
  /** Close Add data and return to Connections while the import continues. */
  onContinueInBackground?: () => void;
}

/**
 * Drawer step 3 (wallet app / blockchain address) — watch-only address
 * import. This is the WalletLookupPanel form re-skinned into the drawer: ALL
 * behavior is unchanged (multi-address paste, BTC/Solana/EVM auto-detect,
 * Moralis active-chain detection with the multi-chain picker, custom
 * explorer config, sequential multi-chain import, job banners). The saved-
 * wallets list moved out — watched wallets are connection cards on the
 * Connections home now.
 *
 * Live-feedback round (item 4): the Wallet name is REQUIRED (prefilled with
 * the wallet app name, applied via updateWalletLabel) so transactions stay
 * identifiable by wallet; and the form takes ONE address by default — an
 * opt-in checkbox reveals the multi-address paste with a warning that one
 * name for many addresses muddies the Transactions tab.
 */
export function WalletAddressForm({
  preselectChain,
  defaultLabel,
  walletAppId,
  onAddAnother,
  onContinueInBackground
}: WalletAddressFormProps) {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof getEffectiveSettings>> | null>(null);
  const [chainId, setChainId] = useState<ChainId>(preselectChain ?? 'solana');
  const [addressText, setAddressText] = useState('');
  /** One address by default; the checkbox reveals the multi-line box. */
  const [multiAddress, setMultiAddress] = useState(false);
  const [nickname, setNickname] = useState(defaultLabel ?? '');
  /** Wallet name is required — set when an import is attempted without one. */
  const [nameError, setNameError] = useState(false);
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [customAsset, setCustomAsset] = useState('');
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
  const [showBackgroundPrompt, setShowBackgroundPrompt] = useState(false);
  /** Address snapshot whose terminal global-job messages belong to this form. */
  const [visibleJobAddress, setVisibleJobAddress] = useState<string | null>(null);
  const [ownershipQueue, setOwnershipQueue] = useState<AccountIdentityRow[]>([]);
  const [ownershipAccount, setOwnershipAccount] = useState<AccountIdentityRow | null>(null);
  const [ownershipError, setOwnershipError] = useState<string | null>(null);
  const pendingImport = useRef<null | (() => void | Promise<void>)>(null);
  /** Previous detected chain set — preserves checkbox choices across re-detects. */
  const detectedRef = useRef<ChainId[]>([]);

  // Global import job state — persists across tab navigation
  const job = useImportJob();

  const lookedUpRaw = useLiveQuery(() => getLookupAddresses(), []);
  /** False until the lookup registry answers — detection must wait for it so an
   *  already-imported wallet never triggers a detection burst on paste. */
  const lookupLoaded = lookedUpRaw !== undefined;
  const lookedUp = useMemo(() => lookedUpRaw ?? [], [lookedUpRaw]);

  // Duplicate-warning toasts (popup) — self-contained host, same pattern as
  // the Connections home toasts.
  const [toasts, setToasts] = useState<{ id: number; tone: 'warn'; title: string; description?: string }[]>([]);
  const toastId = useRef(0);
  const pushToast = (t: { tone: 'warn'; title: string; description?: string }) => {
    const id = ++toastId.current;
    setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
    window.setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 6000);
  };

  useEffect(() => { getEffectiveSettings().then(setSettings); }, []);

  const changeAddressText = (next: string) => {
    setAddressText(next);
    setChainSummary(null);
    setToasts([]);
    setVisibleJobAddress(null);
    detectedRef.current = [];
    setDetection({ status: 'idle' });
    setCheckedChains(new Set());
  };

  // Auto-detect chain when addresses are typed
  useEffect(() => {
    const first = addressText.split(/[\n,]/)[0]?.trim();
    if (!first) return;
    const detected = detectChainFromAddress(first);
    const selected = CHAINS.find((chain) => chain.id === chainId);
    // All EVM chains share the same address shape. Keep a registry-backed EVM
    // preselection (including newly exposed chains) instead of collapsing it
    // back to Ethereum as soon as the user pastes the address.
    if (detected === 'ethereum' && selected && isEvmChain(selected)) return;
    if (detected && detected !== chainId) setChainId(detected);
  }, [addressText, chainId]);

  const parsedAddresses = addressText.split(/[\n,]/).map((a) => a.trim()).filter(Boolean);
  const evmAddresses = parsedAddresses.filter(isEvmAddress);
  const hasEvm = evmAddresses.length > 0;
  // Moralis active-chain detection is possible in hosted (relay) mode with no
  // user key, or in BYOK when a Moralis key was pasted.
  const canDetectChains = isSaasMode() || Boolean(settings?.moralisApiKey?.trim());

  // ── Duplicate-wallet short-circuit (round-4 item 1) ──
  // An EVM wallet counts as fully imported only when the lookup registry has a
  // row for it on EVERY supported EVM chain (the chains detection would find).
  const enabledEvmChainIds = EVM_CHAIN_IDS.filter((id) => CHAINS.some((c) => c.id === id));
  const isImportedOn = (address: string, cid: ChainId) =>
    lookedUp.some((row) => row.chain === cid &&
      canonicalWalletAddress(cid, row.address) === canonicalWalletAddress(cid, address));
  const importedOnEveryEvmChain = (address: string) =>
    enabledEvmChainIds.length > 0 && enabledEvmChainIds.every((cid) => isImportedOn(address, cid));
  /** Every parsed address is already imported on every applicable chain. */
  const allEvmDuplicate =
    hasEvm &&
    parsedAddresses.length > 0 &&
    parsedAddresses.every((a) => (isEvmAddress(a) ? importedOnEveryEvmChain(a) : isImportedOn(a, chainId)));

  // Unified all-duplicate state: EVM multi-chain mode checks every enabled
  // EVM chain; everything else checks the current chain. Drives the prominent
  // callout, the popup toast and the disabled Import button.
  const allDuplicate =
    lookupLoaded &&
    parsedAddresses.length > 0 &&
    (hasEvm && !manualChainMode
      ? allEvmDuplicate
      : parsedAddresses.every((a) => isImportedOn(a, chainId)));
  const importedEvmChains = useMemo(
    () => hasEvm
      ? enabledEvmChainIds.filter((cid) => evmAddresses.some((address) => isImportedOn(address, cid)))
      : [],
    // lookedUp is a live-query snapshot; addressText covers the parsed EVM address identities.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addressText, hasEvm, lookedUp]
  );
  const hasExistingEvmWallet = importedEvmChains.length > 0;
  const initialIdentityForAddress = (address: string): WalletInitialIdentity => {
    const existingEvmIdentity = isEvmAddress(address) ? [...lookedUp]
      .filter((row) => isEvmAddress(row.address) &&
        canonicalWalletAddress(row.chain, row.address) === canonicalWalletAddress(row.chain, address) &&
        (row.label?.trim() || row.walletAppId?.trim()))
      .sort((a, b) => a.chain.localeCompare(b.chain) || a.id.localeCompare(b.id))[0] : undefined;
    // Existing grouped metadata is one authoritative pair. Never fill a
    // missing half from the currently selected wallet app: that could create
    // combinations such as a Ledger title with a persisted MetaMask icon.
    if (existingEvmIdentity) {
      return {
        label: existingEvmIdentity.label?.trim() || undefined,
        walletAppId: existingEvmIdentity.walletAppId?.trim() || undefined
      };
    }
    return { label: nickname.trim(), walletAppId };
  };
  const duplicateMessage = (() => {
    if (!allDuplicate) return '';
    const evmMulti = hasEvm && !manualChainMode;
    if (parsedAddresses.length === 1) {
      return evmMulti
        ? 'This wallet is already imported on every supported EVM chain. Sync from the connection card on the Connections home to refresh.'
        : 'This wallet is already imported. Sync from the connection card on the Connections home to refresh.';
    }
    return `All ${parsedAddresses.length} addresses are already imported${
      evmMulti ? ' on every supported chain' : ''
    }. Sync from the connection card on the Connections home to refresh.`;
  })();

  // Popup toast for an all-duplicate paste — fires once per distinct message
  // and re-arms when the paste stops being all-duplicate.
  const lastDupToastRef = useRef<string | null>(null);
  useEffect(() => {
    if (!duplicateMessage) {
      lastDupToastRef.current = null;
      return;
    }
    if (lastDupToastRef.current === duplicateMessage) return;
    lastDupToastRef.current = duplicateMessage;
    pushToast({ tone: 'warn', title: 'Already imported', description: duplicateMessage });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duplicateMessage]);

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
    if (!lookupLoaded || allEvmDuplicate) {
      // Fully covered short-circuit: zero network calls when every supported
      // EVM chain is already connected. Partial duplicates are announced
      // immediately, then detection may discover fresh active chains.
      detectedRef.current = [];
      setDetection({ status: 'idle' });
      return;
    }
    setDetection({ status: 'detecting' });
    let cancelled = false;
    // Mixed paste: detect only the fresh wallets — an already-imported one
    // (present on every EVM chain) never burns relay quota.
    const targets = evmAddresses.filter((a) => !importedOnEveryEvmChain(a)).slice(0, MAX_DETECTION_ADDRESSES);
    if (targets.length === 0) {
      detectedRef.current = [];
      setDetection({ status: 'idle' });
      return;
    }
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const found = new Set<ChainId>();
          const incoming = new Set<ChainId>();
          for (const addr of targets) {
            // Stop burning relay quota when the run was superseded (the user
            // kept typing past the debounce).
            if (cancelled) return;
            // eslint-disable-next-line no-await-in-loop
            const result = await fetchWalletActiveChains(addr, settings?.moralisApiKey ?? '', {
              alchemyApiKey: settings?.alchemyApiKey,
              etherscanApiKey: settings?.customExplorerApiKey
            });
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
            setDetection({ status: 'none', incomingOnly });
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
  }, [addressText, manualChainMode, canDetectChains, settings, allEvmDuplicate, lookupLoaded]);

  if (settings === null) return <p className="text-sm text-low">Loading wallet lookup…</p>;

  if (!settings.rpcLookupEnabled) {
    return (
      <div className="rounded-lg border border-hi/10 bg-elev-2 p-4 text-sm text-low">
        Wallet lookup is off. Enable "Wallet address lookup via public RPC/explorer" in Settings.
      </div>
    );
  }

  const chain = CHAINS.find((c) => c.id === chainId)!;
  const isEvm = isEvmChain(chain);
  const isBitcoin = chainId === 'bitcoin';
  const isSolana = chainId === 'solana';
  const needsAlchemyKey =
    (chain.provider === 'alchemy_evm' && chain.id !== 'ethereum') || chain.provider === 'alchemy_solana';
  const missingAlchemyKey = needsAlchemyKey && !hasWalletLookupKeys(settings);

  const alreadyImported = parsedAddresses.filter((a) =>
    lookedUp.some((r) =>
      r.chain === chainId && canonicalWalletAddress(chainId, r.address) === canonicalWalletAddress(chainId, a)
    )
  );
  const freshAddresses = parsedAddresses.filter((a) =>
    !lookedUp.some((r) =>
      r.chain === chainId && canonicalWalletAddress(chainId, r.address) === canonicalWalletAddress(chainId, a)
    )
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
        (a) => !lookedUp.some((r) =>
          r.chain === cid && canonicalWalletAddress(cid, r.address) === canonicalWalletAddress(cid, a)
        )
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
      (cid) => !lookedUp.some((r) =>
        r.chain === cid && canonicalWalletAddress(cid, r.address) === canonicalWalletAddress(cid, a)
      )
    )
  );
  const multiImportWalletCount =
    multiFreshWallets.length > 0 ? multiFreshWallets.length : evmAddresses.length;

  /** Wallet name is required — block the connect and flag the field inline. */
  const requireName = (): boolean => {
    if (nickname.trim()) return true;
    setNameError(true);
    return false;
  };

  const beginAfterOwnership = async (
    addresses: string[],
    ownershipChain: ChainId,
    action: () => void | Promise<void>
  ) => {
    setOwnershipError(null);
    try {
      const queue: AccountIdentityRow[] = [];
      for (const address of addresses) {
        const identity = initialIdentityForAddress(address);
        // eslint-disable-next-line no-await-in-loop
        const account = await ensureAccountIdentity({
          kind: 'wallet', canonicalKey: walletAccountCanonicalKey(ownershipChain, address),
          label: identity.label, walletAppId: identity.walletAppId
        });
        queue.push(account);
      }
      pendingImport.current = action;
      await claimNextOwnershipPrompt(queue);
    } catch (error) {
      setOwnershipError(error instanceof Error ? error.message : 'Could not prepare the wallet account.');
    }
  };

  const claimNextOwnershipPrompt = async (accounts: AccountIdentityRow[]): Promise<void> => {
    const [next, ...rest] = accounts;
    if (!next) {
      setOwnershipQueue([]);
      setOwnershipAccount(null);
      const action = pendingImport.current;
      pendingImport.current = null;
      await action?.();
      return;
    }
    const claim = await claimAccountOwnershipPrompt(next.id);
    if (!claim.claimed) {
      await claimNextOwnershipPrompt(rest);
      return;
    }
    setOwnershipQueue(rest);
    setOwnershipAccount(claim.account);
  };

  const finishOwnershipDecision = async (decision: SourceOwnershipDecision) => {
    const account = ownershipAccount;
    if (!account) return;
    if (decision !== 'unknown') {
      await updateAccountOwnership(account.id, { status: decision, origin: 'user' }, account.lifecycleRevision);
    }
    setOwnershipAccount(null);
    await claimNextOwnershipPrompt(ownershipQueue);
  };

  const cancelOwnershipPrompt = () => {
    setOwnershipAccount(null);
    setOwnershipQueue([]);
    pendingImport.current = null;
  };

  const startImportNow = (addrs: string[]) => {
    if (addrs.length === 0 || job.active) return;
    // Generic registry refresh only: no wallet address is included in these
    // CoinGecko requests. Seven-day cache + single-flight keep this best effort.
    syncCoinGeckoRewardRegistryInBackground(settings.coingeckoApiKey);
    importJob.reset();
    const operationToken = importJob._beginBatch();
    setChainSummary(null);
    setVisibleJobAddress(addressText);
    setShowBackgroundPrompt(true);
    void runWalletImport(
      addrs,
      chain,
      settings,
      buildLookupConfig(chain, settings, {
        customBaseUrl: customBaseUrl || settings.customExplorerBaseUrl,
        customApiKey: customApiKey || settings.customExplorerApiKey,
        customAsset
      }),
      false,
      initialIdentityForAddress,
      operationToken
    )
      .catch(() => undefined)
      .finally(() => importJob._endBatch(operationToken));
  };

  const startImport = (addressesOverride?: string[]) => {
    const addrs = addressesOverride ?? freshAddresses;
    if (addrs.length === 0 || job.active) return;
    if (!requireName()) return;
    void beginAfterOwnership(addrs, chain.id, () => startImportNow(addrs));
  };

  /**
   * Multi-chain import: run the existing single-chain path once per selected
   * chain, sequentially, then show an aggregated per-chain summary.
   */
  const startMultiChainImportNow = async () => {
    if (evmAddresses.length === 0 || selectedChains.length === 0 || job.active) return;
    syncCoinGeckoRewardRegistryInBackground(settings.coingeckoApiKey);
    importJob.reset();
    setChainSummary(null);
    setVisibleJobAddress(addressText);
    setShowBackgroundPrompt(true);
    try {
      const outcomes = await runSequentialChainImport(evmAddresses, selectedChains, {
        settings,
        lookupExtras: {
          customBaseUrl: customBaseUrl || settings.customExplorerBaseUrl,
          customApiKey: customApiKey || settings.customExplorerApiKey,
          customAsset
        },
        onChainStart: (cid) => setImportingChain(cid),
        initialIdentity: initialIdentityForAddress
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

  const startMultiChainImport = () => {
    if (evmAddresses.length === 0 || selectedChains.length === 0 || job.active) return;
    if (!requireName()) return;
    // Every selected EVM chain resolves to the same B1 account key.
    void beginAfterOwnership(evmAddresses, selectedChains[0], startMultiChainImportNow);
  };

  const detectedIcon = chainIconId(chainId);

  return (
    <div className="flex flex-col gap-3.5" data-testid="wallet-address-form">
      {ownershipError && <p role="alert" className="text-sm text-loss">{ownershipError}</p>}
      <SourceOwnershipDialog
        open={ownershipAccount !== null}
        mode="prompt"
        accountLabel={ownershipAccount?.label ?? (nickname.trim() || 'this wallet')}
        sourceDescription={ownershipAccount
          ? `Wallet address ${ownershipAccount.canonicalKey.split(':').slice(-1)[0]}`
          : 'Wallet account'}
        onDecision={finishOwnershipDecision}
        onCancel={cancelOwnershipPrompt}
      />
      {/* All-duplicate short-circuit: prominent callout pinned to the top of
          the form (the popup toast fires from the effect above). Detection is
          skipped entirely and Import stays disabled while this is up. */}
      {allDuplicate && (
        <div
          className="flex items-start gap-3 rounded-xl border border-warn/40 bg-elev-2 px-3.5 py-3 shadow-xs"
          data-testid="duplicate-wallet-warning"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-[18px] w-[18px] shrink-0 text-warn" aria-hidden="true" />
          <p className="text-[13px] leading-relaxed text-hi">{duplicateMessage}</p>
        </div>
      )}
      {!allDuplicate && hasExistingEvmWallet && (
        <div
          className="flex items-start gap-3 rounded-xl border border-warn/40 bg-elev-2 px-3.5 py-3 shadow-xs"
          data-testid="existing-wallet-warning"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-[18px] w-[18px] shrink-0 text-warn" aria-hidden="true" />
          <p className="text-[13px] leading-relaxed text-hi">
            This wallet is already imported on {importedEvmChains.map((cid) =>
              CHAINS.find((chain) => chain.id === cid)?.label ?? cid
            ).join(', ')}. Checking other active chains now; Import stays disabled unless new chain coverage is available or selected.
          </p>
        </div>
      )}

      {/* Wallet name — REQUIRED so every transaction is identifiable by wallet
          in the Transactions tab. Prefilled with the wallet app name. */}
      <label className="text-xs font-semibold text-mid">
        Wallet name <span className="font-normal text-faint">(required)</span>
        <input
          className={inputCls}
          value={nickname}
          onChange={(e) => {
            setNickname(e.target.value);
            if (nameError) setNameError(false);
          }}
          placeholder="e.g. My MetaMask"
          aria-invalid={nameError || undefined}
        />
      </label>
      {nameError && (
        <p className="-mt-1.5 text-xs text-loss" role="alert">
          Name this wallet — it's how its transactions are identified in the Transactions tab.
        </p>
      )}

      {/* Address input — a single address by default. The checkbox reveals the
          multi-line box for pasting several addresses under one name. */}
      {!multiAddress ? (
        <label className="text-xs font-semibold text-mid">
          Wallet address
          <input
            className={`${inputCls} font-mono`}
            value={addressText}
            onChange={(e) => changeAddressText(e.target.value.split(/[\n,]/)[0]?.trim() ?? '')}
            placeholder="Paste one wallet address or xPub — BTC, Solana and EVM chains are auto-detected."
          />
        </label>
      ) : (
        <label className="text-xs font-semibold text-mid">
          Wallet addresses — one per line or comma-separated
          <textarea
            className={`${inputCls} h-24 font-mono`}
            value={addressText}
            onChange={(e) => changeAddressText(e.target.value)}
            placeholder={
              'Paste any wallet addresses here.\nThe app auto-detects BTC, Solana, and the active chains of EVM wallets.\nYou can always pick a chain manually below.'
            }
          />
        </label>
      )}
      <label className="flex items-start gap-2 text-xs font-medium text-mid">
        <input
          type="checkbox"
          className="mt-0.5 accent-primary"
          checked={multiAddress}
          onChange={(e) => {
            const on = e.target.checked;
            setMultiAddress(on);
            // Back to one address — keep only the first so a hidden extra
            // line cannot silently import with it.
            if (!on) changeAddressText(addressText.split(/[\n,]/)[0]?.trim() ?? '');
          }}
        />
        <span>
          Add multiple addresses under this name
          <span className="mt-0.5 block text-[11px] font-normal leading-snug text-low">
            Entering multiple addresses under one wallet name can make it harder to tell
            transactions apart in the Transactions tab.
          </span>
        </span>
      </label>

      {/* EVM active-chain detection: progress line, chain picker, or notes above the manual dropdown */}
      {showDetecting && (
        <p className="flex items-center gap-2 text-xs text-low">
          <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" /> Detecting the chains this wallet is active on…
        </p>
      )}

      {showChainPicker && (
        <div className="space-y-2 rounded-lg border border-hi/10 bg-elev-3/30 px-3 py-2.5" data-testid="chain-picker">
          <label className="flex items-center gap-2 text-xs font-medium text-mid">
            <input
              type="checkbox"
              className="accent-primary"
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
                  className="accent-primary"
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
          <IncomingOnlyNote chains={incomingOnlyChains} />
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
        <div className="space-y-1">
          <p className="text-xs text-low">
            No outgoing activity found on supported chains for this address — pick a chain
            manually below.
          </p>
          <IncomingOnlyNote chains={detection.incomingOnly} />
        </div>
      )}

      {/* Chain selector — manual fallback (or default when nothing pasted); hidden for auto-detected BTC/Solana and while the chain picker is up */}
      {!showChainPicker && !showDetecting && (
        parsedAddresses.length === 0 || isEvm || chainId === 'custom_evm' || hasEvm ? (
          <label className="text-xs font-semibold text-mid">
            Chain
            {(isBitcoin || isSolana) && <span className="ml-1 font-normal text-gain">(auto-detected)</span>}
            <select className={inputCls} value={chainId} onChange={(e) => setChainId(e.target.value as ChainId)}>
              {CHAINS.filter((c) => !DROPDOWN_HIDDEN_CHAINS.has(c.id)).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} {c.needsKey ? '' : '(no key needed)'}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="flex items-center gap-2 rounded-lg border border-gain/30 bg-gain/10 px-3 py-2 text-xs text-gain">
            <BrandIcon id={detectedIcon ?? null} fallback={chain.label} size={18} />
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Auto-detected: <strong>{chain.label}</strong>
            <select
              aria-label="Change chain"
              className="ml-auto rounded border border-hi/10 bg-elev-2 px-2 py-0.5 text-xs text-mid"
              value={chainId}
              onChange={(e) => setChainId(e.target.value as ChainId)}
            >
              {CHAINS.filter((c) => !DROPDOWN_HIDDEN_CHAINS.has(c.id)).map((c) => (
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
          className="self-start text-xs text-low underline hover:text-mid"
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
          <label className="text-xs font-semibold text-mid sm:col-span-2">
            Explorer base URL
            <input className={inputCls} value={customBaseUrl} onChange={(e) => setCustomBaseUrl(e.target.value)} placeholder="https://api.etherscan.io/v2/api?chainid=..." />
          </label>
          <label className="text-xs font-semibold text-mid">
            API key
            <input className={inputCls} value={customApiKey} onChange={(e) => setCustomApiKey(e.target.value)} />
          </label>
          <label className="text-xs font-semibold text-mid">
            Asset label
            <input className={inputCls} value={customAsset} onChange={(e) => setCustomAsset(e.target.value)} placeholder="e.g. FTM" />
          </label>
        </div>
      )}

      {showChainPicker && evmAddresses.length > 0 && selectedChains.length > 0 && multiFreshTotal === 0 && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          {evmAddresses.length === 1 ? 'This wallet is' : 'These wallets are'} already imported on the
          selected chains. Sync from the connection card on the Connections home to refresh.
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
      {!showChainPicker && !allDuplicate && alreadyImported.length > 0 && freshAddresses.length > 0 && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
          {alreadyImported.length} already imported (will be skipped). {freshAddresses.length} new will be imported.
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={
            job.active ||
            showDetecting ||
            allDuplicate ||
            (showChainPicker
              ? selectedChains.length === 0 || multiFreshTotal === 0
              : freshAddresses.length === 0 || (needsAlchemyKey && missingAlchemyKey))
          }
          onClick={() => (showChainPicker ? void startMultiChainImport() : startImport())}
        >
          {showChainPicker
            ? `Import ${multiImportWalletCount || ''} wallet${multiImportWalletCount === 1 ? '' : 's'} on ${selectedChains.length} chain${selectedChains.length === 1 ? '' : 's'}`
            : allDuplicate
              ? 'Import wallets'
              : `Import ${freshAddresses.length || ''} wallet${freshAddresses.length === 1 ? '' : 's'}`}
        </Button>
        {settings.priceApiEnabled && !job.active && (showChainPicker ? multiFreshTotal > 0 : freshAddresses.length > 0) && (
          <span className="text-xs text-gain">✓ Swap detection + price fetch runs automatically</span>
        )}
      </div>

      {importingChain && job.active && (
        <p className="flex items-center gap-2 text-xs text-low">
          <RefreshCw className="h-3 w-3 animate-spin" aria-hidden="true" />
          Importing {CHAINS.find((c) => c.id === importingChain)?.label ?? importingChain}…
        </p>
      )}

      {/* Aggregated per-chain summary after a multi-chain import */}
      {!job.active && chainSummary && (
        <div className="space-y-1 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs" data-testid="chain-summary">
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
      {!job.active && job.result && visibleJobAddress === addressText && !chainSummary && !importingChain && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-gain">
          <strong>{job.result.imported}</strong> transactions imported
          {job.result.swapsDetected > 0 ? `, ${job.result.swapsDetected} swaps detected` : ''}
          {job.result.pricesUpdated > 0 ? `, ${job.result.pricesUpdated} prices fetched` : ''}.
        </div>
      )}
      {job.error && visibleJobAddress === addressText && !chainSummary && (
        <div className="rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">
          {job.error}
        </div>
      )}
      {!job.active && visibleJobAddress === addressText && job.warnings.length > 0 && (
        <div className="space-y-1 text-xs text-warn">
          {job.warnings.slice(0, 6).map((w, i) => <p key={i}>{w}</p>)}
        </div>
      )}
      {!job.active && visibleJobAddress === addressText && job.failed.length > 0 && (
        <div className="space-y-1 rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">
          {job.failed.map((f, i) => <p key={i}>{f.address}: {f.message}</p>)}
        </div>
      )}

      {/* Watch-only privacy note (mockup `watchonly-note`) */}
      <div className="flex items-start gap-3 rounded-xl border border-hi/10 bg-elev-2 px-3.5 py-3">
        <Eye className="mt-0.5 h-[18px] w-[18px] shrink-0 text-primary" aria-hidden="true" />
        <p className="text-[13px] leading-relaxed text-mid">
          We only ever read the public ledger. No keys, no seed phrase — SoloLedger can never move
          your funds.{' '}
          {isSaasMode()
            ? "Whichever explorer answers will see every address you query. Lookups run through SoloLedger's secure proxy — no API keys needed."
            : 'Whichever explorer answers will see every address you query. Bitcoin uses Blockstream (no key); other chains use your own Alchemy key.'}
        </p>
      </div>

      {/* Duplicate-wallet popup toasts */}
      <ToastViewport>
        {toasts.map((t) => (
          <Toast
            key={t.id}
            tone={t.tone}
            title={t.title}
            description={t.description}
            onDismiss={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))}
          />
        ))}
      </ToastViewport>
      <ConfirmDialog
        open={showBackgroundPrompt}
        title="Add another wallet?"
        body="Your wallet import is continuing in the background. Would you like to choose another wallet or address now?"
        confirmLabel="Yes"
        cancelLabel="No"
        onConfirm={() => {
          setShowBackgroundPrompt(false);
          onAddAnother?.();
        }}
        onCancel={() => {
          setShowBackgroundPrompt(false);
          onContinueInBackground?.();
        }}
      />
    </div>
  );
}
