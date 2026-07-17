import { Fragment, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSpecIdHints, getLookupAddresses, deleteTransactionsByIds } from '@/lib/storage/db';
import { Badge } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { TxType, Transaction, FlagReason, Jurisdiction } from '@/types/transaction';
import { formatAmountForExport, formatCompactAmount, formatCurrency, getFyBoundaries, getFyLabel, getAvailableFys, monetaryColumnLabel, downloadBlob, csvField } from '@/lib/utils';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { CHAINS } from '@/lib/rpc/providers';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { looksLikeTruncatedMint, resolveTokenSymbolFromContract } from '@/lib/assets/tokenSymbols';
import { reprocessSwapDetectionInDb } from '@/lib/rpc/reprocessSwaps';
import { countPotentialSwapPairs } from '@/lib/rpc/swapDetection';
import { detectDcaGroups, applyDcaClassification } from '@/lib/rpc/dcaDetection';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import { isSaasMode } from '@/lib/saas/config';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import {
  DISPOSAL_TYPES,
  bulkFlagsPatch,
  bulkTypeImpactLines,
  bulkTypePatch,
  initialBulkFlagsSelection,
  summarizeBulkTypeChange
} from '@/lib/review/bulkEdit';
import type { BulkFlagsSelection } from '@/lib/review/bulkEdit';
import { LotPicker } from './LotPicker';
import { Check, X, Pencil, AlertTriangle, Ban, ArrowUpDown, Trash2, ListChecks, Tags, Flag } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTabNav } from '@/lib/tabNav';
import { createBrandedPdf, pdfTableStyles, truncatePdfRef } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';
import { isDerivativeTransaction } from '@/lib/tax/derivatives';

const ALL_TYPES: TxType[] = [
  'buy', 'sell', 'trade', 'transfer_in', 'transfer_out',
  'income', 'gift_sent', 'gift_received', 'fee',
  'nft_mint', 'nft_buy', 'nft_sell',
  'defi_deposit', 'defi_withdraw', 'other'
];

const ALL_FLAGS: FlagReason[] = [
  'possible_internal_transfer',
  'missing_cost_basis',
  'duplicate_suspected',
  'unrecognized_asset',
  'needs_review'
];

const FLAG_LABELS: Record<FlagReason, string> = {
  possible_internal_transfer: 'Possible internal transfer',
  missing_cost_basis: 'Missing cost basis',
  duplicate_suspected: 'Duplicate suspected',
  unrecognized_asset: 'Unrecognized asset',
  needs_review: 'Needs review'
};

function displayFlags(t: Transaction): string[] {
  const flags = new Set(t.flags ?? []);
  if (t.fiatValue == null && !t.isInternalTransfer) flags.add('missing_cost_basis');
  return [...flags];
}

function FlagSelector({ tx }: { tx: Transaction }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const storedFlags = new Set(tx.flags ?? []);
  const shownFlags = displayFlags(tx);

  const patch = async (update: Partial<Transaction>) => {
    setSaving(true);
    await db.transactions.update(tx.id, update);
    setSaving(false);
  };

  const toggleFlag = async (flag: FlagReason) => {
    const next = new Set(tx.flags ?? []);
    if (next.has(flag)) next.delete(flag);
    else next.add(flag);
    await patch({ flags: [...next] as FlagReason[] });
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Click to flag this transaction"
        className="flex max-w-[14rem] flex-wrap items-center gap-1 text-left"
      >
        {tx.isInternalTransfer && <Badge tone="neutral" className="text-[10px]">internal</Badge>}
        {tx.isSpam && <Badge tone="loss" className="text-[10px]">spam</Badge>}
        {tx.category === 'nft' && <Badge tone="pink" className="text-[10px]">nft</Badge>}
        {shownFlags.map((f) => (
          <Badge key={f} tone="gold" className="text-[10px]">
            {f.replace(/_/g, ' ')}
          </Badge>
        ))}
        {shownFlags.length === 0 && !tx.isInternalTransfer && !tx.isSpam && tx.category !== 'nft' && (
          <span className="text-[10px] text-low">—</span>
        )}
        {saving && <span className="h-2 w-2 animate-pulse rounded-full bg-violet" />}
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-30 min-w-[14rem] rounded-lg border border-white/10 bg-elev-2 py-1 shadow-card border-white/10">
          <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-low">Flag transaction</p>
          {ALL_FLAGS.map((flag) => {
            const on = storedFlags.has(flag);
            return (
              <button
                key={flag}
                type="button"
                onClick={() => void toggleFlag(flag)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-elev-1 ${on ? 'text-gain' : 'text-low'}`}
              >
                <span className={`h-3 w-3 rounded border ${on ? 'border-violet bg-violet' : 'border-white/10'}`} />
                {FLAG_LABELS[flag]}
              </button>
            );
          })}
          <div className="my-1 border-t border-white/10" />
          <button
            type="button"
            onClick={() =>
              void patch({
                isInternalTransfer: !tx.isInternalTransfer,
                flags: tx.isInternalTransfer
                  ? (['possible_internal_transfer'] as FlagReason[])
                  : ([] as FlagReason[])
              })
            }
            className="flex w-full px-3 py-1.5 text-left text-xs text-low hover:bg-elev-1"
          >
            {tx.isInternalTransfer ? '↩ Unmark internal transfer' : '✓ Mark as internal transfer'}
          </button>
          <button
            type="button"
            onClick={() => void patch({ isSpam: !tx.isSpam })}
            className="flex w-full px-3 py-1.5 text-left text-xs text-low hover:bg-elev-1"
          >
            {tx.isSpam ? '↩ Unmark spam' : '🚫 Mark as spam'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-1 border-t border-white/10 px-3 py-1.5 text-[10px] text-low hover:text-mid"
          >
            <X className="h-3 w-3" /> Close
          </button>
        </div>
      )}
    </div>
  );
}

function TypeSelector({
  txId,
  current,
  flags
}: {
  txId: string;
  current: TxType;
  flags: string[];
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const reclassify = async (next: TxType) => {
    if (next === current) { setOpen(false); return; }
    setSaving(true);
    const newFlags = (flags ?? []).filter(
      (f) => f !== 'possible_internal_transfer' && f !== 'missing_cost_basis'
    ) as import('@/types/transaction').FlagReason[];
    await db.transactions.update(txId, { type: next, flags: newFlags });
    setSaving(false);
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Click to reclassify this transaction"
        className="inline-flex items-center gap-1"
      >
        <Badge tone={TYPE_TONE[current]}>{current}</Badge>
        {saving && <span className="h-2 w-2 animate-pulse rounded-full bg-violet" />}
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-30 min-w-[10rem] rounded-lg border border-white/10 bg-elev-2 py-1 shadow-card border-white/10">
          <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-low">Reclassify as</p>
          {ALL_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => void reclassify(t)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-elev-1 ${t === current ? 'text-gain' : 'text-low'}`}
            >
              <Badge tone={TYPE_TONE[t]} className="pointer-events-none text-[10px]">{t}</Badge>
            </button>
          ))}
          <button
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-1 border-t border-white/10 px-3 py-1.5 text-[10px] text-low hover:text-mid"
          >
            <X className="h-3 w-3" /> Cancel
          </button>
        </div>
      )}
    </div>
  );
}

const TYPE_TONE: Record<TxType, 'neutral' | 'emerald' | 'gold' | 'loss' | 'violet' | 'pink'> = {
  buy: 'emerald',
  sell: 'loss',
  trade: 'violet',
  transfer_in: 'neutral',
  transfer_out: 'neutral',
  income: 'emerald',
  gift_sent: 'neutral',
  gift_received: 'neutral',
  fee: 'neutral',
  nft_mint: 'pink',
  nft_buy: 'pink',
  nft_sell: 'pink',
  defi_deposit: 'gold',
  defi_withdraw: 'gold',
  other: 'neutral'
};

function truncateAddress(addr?: string): string {
  if (!addr) return '—';
  if (addr.length <= 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Derive From/To for Review display. Fees are paid FROM the wallet. */
function txFromToAddresses(t: Transaction): { fromAddr?: string; toAddr?: string } {
  if (t.type === 'fee') {
    return { fromAddr: t.walletAddress, toAddr: undefined };
  }
  if (t.type === 'transfer_out' || t.type === 'gift_sent' || t.type === 'sell') {
    return { fromAddr: t.walletAddress, toAddr: t.counterpartyAddress };
  }
  // transfer_in, income, trade, buy, …
  return { fromAddr: t.counterpartyAddress, toAddr: t.walletAddress };
}

export function ReviewTab() {
  const [query, setQuery] = useState('');
  const [assetFilter, setAssetFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<TxType | 'all'>('all');
  const [walletFilter, setWalletFilter] = useState<string>('all');
  const [fyFilter, setFyFilter] = useState<number | null>(null);
  const [showNeedsPrice, setShowNeedsPrice] = useState(false);
  const [showSpam, setShowSpam] = useState(false);
  const [sortBy, setSortBy] = useState<'date_desc' | 'date_asc' | 'wallet' | 'asset' | 'type' | 'fy'>('date_desc');
  const [instrumentFilter, setInstrumentFilter] = useState<'all' | 'spot' | 'derivative'>('all');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 200;
  const [walletLabels, setWalletLabels] = useState<Map<string, string>>(new Map());
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pdfConfirmOpen, setPdfConfirmOpen] = useState(false);
  // Bulk-edit: "Set type" (dropdown → impact-summary confirm) + "Set flags".
  const [bulkTypeMenuOpen, setBulkTypeMenuOpen] = useState(false);
  const [pendingBulkType, setPendingBulkType] = useState<TxType | null>(null);
  const [bulkFlagsMenuOpen, setBulkFlagsMenuOpen] = useState(false);
  const [bulkFlagsSel, setBulkFlagsSel] = useState<BulkFlagsSelection | null>(null);
  const [applyingBulk, setApplyingBulk] = useState(false);
  const [dcaGroups, setDcaGroups] = useState<Awaited<ReturnType<typeof detectDcaGroups>>>([]);
  const [applyingDca, setApplyingDca] = useState(false);
  const settingsRow = useLiveQuery(() => db.settings.get('singleton'), []);
  const settings = useMemo(() => {
    if (!settingsRow) return null;
    const { id: _id, ...rest } = settingsRow;
    return rest;
  }, [settingsRow]);
  const [openLotPicker, setOpenLotPicker] = useState<string | null>(null);
  const [fetchingPrices, setFetchingPrices] = useState(false);
  const [priceProgress, setPriceProgress] = useState<{ done: number; total: number } | null>(null);
  const [priceErrors, setPriceErrors] = useState<string[]>([]);
  const [editingFiat, setEditingFiat] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [detectingSwaps, setDetectingSwaps] = useState(false);
  const [swapDetectMsg, setSwapDetectMsg] = useState<string | null>(null);
  const [resolvingSymbols, setResolvingSymbols] = useState(false);
  const [novesProgress, setNovesProgress] = useState<{ done: number; total: number } | null>(null);

  const { goToImport } = useTabNav();
  const transactions = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const hints = useLiveQuery(() => getSpecIdHints(), []) ?? {};

  // Load wallet labels + jurisdiction on mount
  useEffect(() => {
    getLookupAddresses().then((rows) => {
      const map = new Map<string, string>();
      for (const r of rows) if (r.label) map.set(r.address.toLowerCase(), r.label);
      setWalletLabels(map);
    });
    db.settings.get('singleton').then((s) => {
      if (s?.jurisdiction) setJurisdiction(s.jurisdiction as Jurisdiction);
    });
  }, []);

  const availableFys = useMemo(
    () => getAvailableFys(transactions.map((t) => t.timestamp), jurisdiction),
    [transactions, jurisdiction]
  );
  const availableWallets = useMemo(() => {
    const ws = new Set<string>();
    for (const t of transactions) if (t.walletAddress) ws.add(t.walletAddress);
    return Array.from(ws);
  }, [transactions]);


  // Transactions with truncated/contract-address assets that could be resolved to a
  // real ticker via CoinGecko. Kept as a memo (no network) — the lookup only runs
  // when the user explicitly clicks "Resolve token names" (AC-A1: no background
  // network calls in default local mode without a user trigger).
  const unresolvedSymbolTxs = useMemo(
    () =>
      transactions.filter(
        (t) => t.contractAddress && t.chain && (looksLikeTruncatedMint(t.asset) || t.asset.startsWith('0x'))
      ),
    [transactions]
  );

  const resolveTokenSymbols = async () => {
    if (resolvingSymbols || unresolvedSymbolTxs.length === 0) return;
    setResolvingSymbols(true);
    try {
      for (const t of unresolvedSymbolTxs) {
        // eslint-disable-next-line no-await-in-loop
        const symbol = await resolveTokenSymbolFromContract(t.asset, t.contractAddress, t.chain);
        if (symbol && symbol !== t.asset) {
          // eslint-disable-next-line no-await-in-loop
          await db.transactions.update(t.id, { asset: symbol });
        }
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 350));
      }
    } finally {
      setResolvingSymbols(false);
    }
  };

  const engineResult = useMemo(() => {
    if (!settings) return null;
    return calculateCostBasis(transactions, { method: settings.defaultCostBasisMethod, specIdHints: hints });
  }, [transactions, settings, hints]);

  /** Non-spam transactions missing a fiat value (includes internal transfers for display). */
  const missingPriceTxs = useMemo(
    () => transactions.filter((t) => !t.isSpam && t.fiatValue == null),
    [transactions]
  );

  const spamTxCount = useMemo(() => transactions.filter((t) => t.isSpam).length, [transactions]);

  const rpcTransferCount = useMemo(
    () =>
      transactions.filter(
        (t) =>
          t.source.startsWith('rpc:') &&
          (t.type === 'transfer_in' || t.type === 'transfer_out') &&
          t.fiatValue == null
      ).length,
    [transactions]
  );

  const potentialSwapPairs = useMemo(() => countPotentialSwapPairs(transactions), [transactions]);

  // One-time auto-detect for wallet imports stored before swap detection shipped.
  useEffect(() => {
    if (potentialSwapPairs === 0) return;
    const key = 'sololedger_swap_detect_v2';
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, '1');
    void reprocessSwapDetectionInDb(settings?.novesApiKey).then((result) => {
      if (result.tradesCreated > 0 || result.reclassified > 0) {
        setSwapDetectMsg(result.message);
      }
    });
  }, [potentialSwapPairs]);

  const fetchMissingPrices = async () => {
    if (!settings?.priceApiEnabled || missingPriceTxs.length === 0) return;
    setFetchingPrices(true);
    setPriceErrors([]);
    try {
      const r = await fetchMissingPricesForAllTransactions(settings, (done, total) =>
        setPriceProgress({ done, total })
      );
      const msg = `Finished: ${r.updated} updated, ${r.failed} could not be priced.`;
      setPriceErrors([msg]);
    } catch (err) {
      setPriceErrors([err instanceof Error ? err.message : 'Price fetch failed unexpectedly.']);
    } finally {
      setFetchingPrices(false);
      setPriceProgress(null);
    }
  };

  const bulkMarkSpam = async () => {
    await Promise.all(Array.from(selected).map((id) => db.transactions.update(id, { isSpam: true })));
    setSelected(new Set());
  };

  const runSwapDetection = async () => {
    setDetectingSwaps(true);
    setSwapDetectMsg(null);
    setNovesProgress(null);
    try {
      const result = await reprocessSwapDetectionInDb(
        settings?.novesApiKey,
        (done, total) => setNovesProgress({ done, total })
      );
      setSwapDetectMsg(result.message);
    } finally {
      setDetectingSwaps(false);
      setNovesProgress(null);
    }
  };

  const startEditFiat = (txId: string, current?: number) => {
    setEditingFiat(txId);
    setEditValue(current != null ? String(current) : '');
  };

  const saveFiat = async (tx: (typeof transactions)[number]) => {
    const parsed = Number(editValue);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    await db.transactions.update(tx.id, {
      fiatValue: parsed,
      flags: (tx.flags ?? []).filter((f) => f !== 'missing_cost_basis')
    });
    setEditingFiat(null);
  };

  const assets = useMemo(() => Array.from(new Set(transactions.map((t) => t.asset))).sort(), [transactions]);

  // Detect DCA groups whenever transactions change (only unclassified deposits).
  // Auto-classify real groups so users don't need the manual button.
  useEffect(() => {
    const groups = detectDcaGroups(transactions.filter((t) => !t.isInternalTransfer && !t.isSpam));
    setDcaGroups(groups);
    if (groups.length === 0) return;
    const key = 'sololedger_review_dca_auto_v1';
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
    void (async () => {
      setApplyingDca(true);
      try {
        await applyDcaClassification(
          groups,
          settings?.alchemyApiKey ?? (isSaasMode() ? SAAS_PROXY_KEY : undefined)
        );
      } finally {
        setApplyingDca(false);
      }
    })();
  }, [transactions, settings?.alchemyApiKey]);

  const filtered = useMemo(() => {
    const fyBounds = fyFilter != null ? getFyBoundaries(fyFilter, jurisdiction) : null;
    const base = transactions.filter((t) => {
      if (!showSpam && t.isSpam) return false;
      if (showSpam && !t.isSpam) return false;
      if (showNeedsPrice && !(t.fiatValue == null && !t.isSpam)) return false;
      if (assetFilter !== 'all' && t.asset !== assetFilter) return false;
      if (typeFilter !== 'all' && t.type !== typeFilter) return false;
      if (walletFilter !== 'all' && t.walletAddress?.toLowerCase() !== walletFilter.toLowerCase()) return false;
      if (fyBounds && (t.timestamp < fyBounds.start || t.timestamp > fyBounds.end)) return false;
      if (instrumentFilter === 'derivative' && !isDerivativeTransaction(t)) return false;
      if (instrumentFilter === 'spot' && isDerivativeTransaction(t)) return false;
      if (query && !`${t.asset} ${t.type} ${t.source} ${t.walletAddress ?? ''} ${t.notes ?? ''}`.toLowerCase().includes(query.toLowerCase()))
        return false;
      return true;
    });

    return [...base].sort((a, b) => {
      switch (sortBy) {
        case 'date_asc': return a.timestamp - b.timestamp;
        case 'wallet': {
          const wa = a.walletAddress ?? '';
          const wb = b.walletAddress ?? '';
          return wa.localeCompare(wb) || b.timestamp - a.timestamp;
        }
        case 'asset': return a.asset.localeCompare(b.asset) || b.timestamp - a.timestamp;
        case 'type': return a.type.localeCompare(b.type) || b.timestamp - a.timestamp;
        case 'date_desc':
        default: return b.timestamp - a.timestamp;
      }
    });
  }, [transactions, assetFilter, typeFilter, walletFilter, fyFilter, jurisdiction, instrumentFilter, query, showNeedsPrice, showSpam, sortBy]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, safePage, PAGE_SIZE]);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [assetFilter, typeFilter, walletFilter, fyFilter, instrumentFilter, query, showNeedsPrice, showSpam, sortBy]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const visibleIds = useMemo(() => pageRows.map((t) => t.id), [pageRows]);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      });
    } else {
      setSelected((prev) => new Set([...prev, ...visibleIds]));
    }
  };

  const bulkMarkInternal = async () => {
    await Promise.all(
      Array.from(selected).map((id) => db.transactions.update(id, { isInternalTransfer: true, flags: [] }))
    );
    setSelected(new Set());
  };

  // ---- Bulk "Set type" + "Set flags" ----

  const selectedTxs = useMemo(
    () => transactions.filter((t) => selected.has(t.id)),
    [transactions, selected]
  );

  const bulkTypeImpact = useMemo(
    () => (pendingBulkType ? summarizeBulkTypeChange(selectedTxs, pendingBulkType) : null),
    [selectedTxs, pendingBulkType]
  );

  const applyBulkType = async () => {
    if (!pendingBulkType) return;
    const newType = pendingBulkType;
    setApplyingBulk(true);
    try {
      // Rows already of the target type are left completely untouched (the
      // impact dialog counts them as "unchanged"), mirroring TypeSelector's
      // early-return when next === current.
      await Promise.all(
        selectedTxs
          .filter((t) => t.type !== newType)
          .map((t) => db.transactions.update(t.id, bulkTypePatch(t, newType)))
      );
    } finally {
      setApplyingBulk(false);
      setPendingBulkType(null);
      setSelected(new Set());
    }
  };

  const openBulkFlags = () => {
    setBulkTypeMenuOpen(false);
    setBulkFlagsSel(initialBulkFlagsSelection(selectedTxs));
    setBulkFlagsMenuOpen(true);
  };

  const setBulkFlag = (flag: FlagReason, on: boolean) => {
    setBulkFlagsSel((cur) => {
      if (!cur) return cur;
      const flags = new Map(cur.flags);
      flags.set(flag, on);
      return { ...cur, flags };
    });
  };

  const applyBulkFlags = async () => {
    if (!bulkFlagsSel) return;
    const sel = bulkFlagsSel;
    setApplyingBulk(true);
    try {
      await Promise.all(
        selectedTxs.map((t) => db.transactions.update(t.id, bulkFlagsPatch(t, sel)))
      );
    } finally {
      setApplyingBulk(false);
      setBulkFlagsMenuOpen(false);
      setBulkFlagsSel(null);
      setSelected(new Set());
    }
  };

  const bulkDelete = async () => {
    await deleteTransactionsByIds(Array.from(selected));
    setSelected(new Set());
  };


  const exportFilteredCsv = () => {
    const exportCurrency = (settings?.reportingCurrency ?? 'INR').toUpperCase();
    const header = [
      'date',
      'type',
      'chain',
      'asset',
      'amount',
      monetaryColumnLabel('fiat_value', exportCurrency),
      'fiat_currency',
      'from',
      'to',
      'source_ref',
      'flags',
      'is_internal_transfer',
      'is_spam',
      'notes'
    ];
    const rows = filtered.map((t) => {
      const { fromAddr, toAddr } = txFromToAddresses(t);
      return [
        new Date(t.timestamp).toISOString(),
        t.type,
        t.chain ?? '',
        t.asset,
        t.amount,
        t.fiatValue ?? '',
        t.fiatCurrency,
        fromAddr ?? '',
        toAddr ?? '',
        t.sourceRef ?? '',
        displayFlags(t).join('|'),
        t.isInternalTransfer ? 'yes' : 'no',
        t.isSpam ? 'yes' : 'no',
        (t.notes ?? '')
      ].map((v) => csvField(String(v))).join(',');
    });
    downloadBlob([header.join(','), ...rows].join('\n'), 'text/csv', 'sololedger-review-transactions.csv');
  };

  const exportFilteredJson = () => {
    downloadBlob(
      JSON.stringify(
        {
          count: filtered.length,
          exportMeta: {
            reportingCurrency: (settings?.reportingCurrency ?? 'INR').toUpperCase(),
            monetaryFields: ['fiatValue']
          },
          transactions: filtered
        },
        null,
        2
      ),
      'application/json',
      'sololedger-review-transactions.json'
    );
  };

  const exportFilteredPdf = async () => {
    const cur = (settings?.reportingCurrency ?? 'INR').toUpperCase();
    const { doc, startY } = await createBrandedPdf({
      reportTitle: 'Review Transactions',
      metaLines: [`Rows: ${filtered.length} · Currency: ${cur}`],
      landscape: true
    });
    const tbl = pdfTableStyles(7);
    autoTable(doc, {
      startY,
      ...tbl,
      head: [[
        'Date', 'Type', 'Chain', 'Asset', 'Amount',
        `Fiat (${cur})`, 'From', 'To', 'Flags', 'Source Ref'
      ]],
      body: filtered.map((t) => {
        const { fromAddr, toAddr } = txFromToAddresses(t);
        return [
        new Date(t.timestamp).toISOString().slice(0, 10),
        t.type,
        t.chain ?? '—',
        t.asset,
        formatCompactAmount(t.amount),
        t.fiatValue != null ? formatAmountForExport(t.fiatValue, t.fiatCurrency) : '—',
        fromAddr ? truncateAddress(fromAddr) : '—',
        toAddr ? truncateAddress(toAddr) : '—',
        displayFlags(t).join(', ') || '—',
        t.sourceRef ? truncatePdfRef(t.sourceRef) : '—'
      ];
      })
    });
    doc.save('sololedger-review-transactions.pdf');
  };

  if (transactions.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="page-title">Review</h2>
          <p className="mt-1 text-sm text-low">Give each transaction a quick once-over before you file.</p>
        </div>
        <EmptyState
          icon={<ListChecks className="h-11 w-11" />}
          title="No transactions to review"
          description="This is where you'll check what we read — matched transfers, filled-in prices, and anything that needs a second look before it counts."
          actionLabel="Import your trades"
          onAction={goToImport}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="page-title">Review</h2>
        <p className="mt-1 text-sm text-low">Give each transaction a quick once-over before you file.</p>
      </div>
      {/* Token-name resolution — user-gated so no background CoinGecko calls fire on mount. */}
      {unresolvedSymbolTxs.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-white/10 bg-elev-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-mid">
              {unresolvedSymbolTxs.length} token{unresolvedSymbolTxs.length === 1 ? '' : 's'} shown by contract address
            </p>
            <p className="mt-1 text-xs text-low">
              Look up the real ticker symbols from CoinGecko (a network call by contract address — never wallet addresses).
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={resolvingSymbols}
            onClick={() => void resolveTokenSymbols()}
            className="shrink-0"
          >
            {resolvingSymbols ? 'Resolving…' : 'Resolve token names'}
          </Button>
        </div>
      )}

      {/* DCA / Recurring order banner */}
      {dcaGroups.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-violet/40 bg-violet/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-mid">
              {dcaGroups.length} DCA / Recurring order{dcaGroups.length === 1 ? '' : 's'} detected
            </p>
            <div className="mt-1 space-y-0.5 text-xs text-low">
              {dcaGroups.map((g) => (
                <p key={g.vaultAddress}>
                  {g.totalInput.toFixed(0)} {g.inputAsset} → {g.fillTxs.length} fills of {g.outputAsset} (vault {g.vaultAddress.slice(0, 8)}…{g.vaultAddress.slice(-4)})
                </p>
              ))}
            </div>
            <p className="mt-1 text-xs text-low">
              Koinly approach: mark the deposit as internal (non-taxable escrow), classify each fill as a buy.
              Fetch prices after classifying.
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={applyingDca}
            onClick={async () => {
              setApplyingDca(true);
              await applyDcaClassification(
                dcaGroups,
                settings?.alchemyApiKey ?? (isSaasMode() ? SAAS_PROXY_KEY : undefined)
              );
              setApplyingDca(false);
            }}
            className="shrink-0 border-violet/40 text-gain"
          >
            {applyingDca ? 'Classifying…' : 'Classify DCA fills'}
          </Button>
        </div>
      )}

      {potentialSwapPairs > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-violet/40 bg-violet/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-mid">
              {potentialSwapPairs} possible DEX swap{potentialSwapPairs === 1 ? '' : 's'} waiting to be merged
            </p>
            <p className="text-xs text-low">
              Wallet imports show as transfer_in/out until merged into trades. Click Detect DEX swaps, then fetch
              prices — Capital Gains will show matched buy/sell rows.
            </p>
          </div>
          <Button variant="secondary" disabled={detectingSwaps} onClick={runSwapDetection} className="shrink-0">
            {detectingSwaps
              ? novesProgress
                ? `Noves ${novesProgress.done}/${novesProgress.total}…`
                : 'Detecting swaps…'
              : settings?.novesApiKey ? 'Detect swaps (Noves)' : 'Detect DEX swaps'}
          </Button>
        </div>
      )}

      {missingPriceTxs.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border-2 border-warn/30 bg-warn/20 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warn text-hi">
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-mid">
                {missingPriceTxs.length} transaction{missingPriceTxs.length === 1 ? '' : 's'} still need a price
              </p>
              <p className="text-xs text-low">
                {settings?.priceApiEnabled
                  ? rpcTransferCount > 0
                    ? 'Wallet imports are included — click the button to fetch historical prices. Swaps auto-detected as trades will feed cost basis after prices are filled.'
                    : 'Nothing happens automatically — click the button to fetch them now.'
                  : 'Turn on "Live price lookup" in Settings, or click any dash below to type a value in yourself.'}
              </p>
            </div>
          </div>
          {settings?.priceApiEnabled && (
            <Button
              disabled={fetchingPrices}
              onClick={fetchMissingPrices}
              className="shrink-0 animate-pulse disabled:animate-none"
            >
              {fetchingPrices
                ? `Fetching ${priceProgress?.done ?? 0}/${priceProgress?.total ?? missingPriceTxs.length}…`
                : `Fetch ${missingPriceTxs.length} missing price${missingPriceTxs.length === 1 ? '' : 's'} now`}
            </Button>
          )}
        </div>
      )}
      {priceErrors.length > 0 && (
        <div className={`rounded-sm border px-3 py-2 text-xs ${priceErrors[0]?.startsWith('Finished') ? 'border-violet/30 bg-violet/10 text-gain' : 'border-loss/30 bg-loss/10 text-loss'}`}>
          {priceErrors.slice(0, 5).join(' · ')}
          {priceErrors.length > 5 ? ` · +${priceErrors.length - 5} more` : ''}
        </div>
      )}

      {swapDetectMsg && (
        <div className="rounded-sm border border-violet/30 bg-violet/10 px-3 py-2 text-xs text-gain">
          {swapDetectMsg}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search transactions…"
          className="rounded-md border border-white/10 bg-elev-2 px-3 py-2 text-sm text-mid shadow-soft placeholder:text-low focus:border-violet focus:outline-none focus:ring-2 focus:ring-violet/20"
        />
        {/* Asset filter */}
        <select
          value={assetFilter}
          onChange={(e) => setAssetFilter(e.target.value)}
          className="rounded-md border border-white/10 bg-elev-2 px-3 py-2 text-sm text-mid shadow-soft focus:border-violet focus:outline-none focus:ring-2 focus:ring-violet/20"
        >
          <option value="all">All assets</option>
          {assets.map((a) => (<option key={a} value={a}>{a}</option>))}
        </select>

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as TxType | 'all')}
          className="rounded-md border border-white/10 bg-elev-2 px-3 py-2 text-sm text-mid shadow-soft focus:border-violet focus:outline-none focus:ring-2 focus:ring-violet/20"
        >
          <option value="all">All types</option>
          {ALL_TYPES.map((t) => (
            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
          ))}
        </select>

        {/* Wallet filter */}
        {availableWallets.length > 1 && (
          <select
            value={walletFilter}
            onChange={(e) => setWalletFilter(e.target.value)}
            className="max-w-[180px] truncate rounded-md border border-white/10 bg-elev-2 px-3 py-2 text-sm text-mid shadow-soft focus:border-violet focus:outline-none focus:ring-2 focus:ring-violet/20"
          >
            <option value="all">All wallets</option>
            {availableWallets.map((w) => (
              <option key={w} value={w}>{walletLabels.get(w.toLowerCase()) ?? `${w.slice(0, 8)}…`}</option>
            ))}
          </select>
        )}

        {/* FY filter */}
        <select
          value={fyFilter ?? ''}
          onChange={(e) => setFyFilter(e.target.value ? Number(e.target.value) : null)}
          className="rounded-md border border-white/10 bg-elev-2 px-3 py-2 text-sm text-mid shadow-soft focus:border-violet focus:outline-none focus:ring-2 focus:ring-violet/20"
        >
          <option value="">All periods</option>
          {availableFys.map((fy) => (
            <option key={fy} value={fy}>{getFyLabel(fy, jurisdiction)}</option>
          ))}
        </select>

        {/* Sort selector */}
        <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-elev-2 px-3 py-1.5">
          <ArrowUpDown className="h-3.5 w-3.5 text-low" />
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
            className="bg-transparent text-sm text-mid focus:outline-none"
          >
            <option value="date_desc">Date ↓ (newest)</option>
            <option value="date_asc">Date ↑ (oldest)</option>
            <option value="wallet">By wallet</option>
            <option value="asset">By asset</option>
            <option value="type">By type</option>
          </select>
        </div>

        {/* Quick-filter toggles */}
        <button
          onClick={() => { setShowNeedsPrice((v) => !v); setShowSpam(false); }}
          className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${showNeedsPrice ? 'border-warn/30 bg-warn/20 text-warn' : 'border-white/10 text-low hover:text-mid'}`}
        >
          {showNeedsPrice ? `Needs price (${missingPriceTxs.length})` : `Needs price: ${missingPriceTxs.length}`}
        </button>
        {spamTxCount > 0 && (
          <button
            onClick={() => { setShowSpam((v) => !v); setShowNeedsPrice(false); }}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${showSpam ? 'border-loss bg-loss/20 text-loss' : 'border-white/10 text-low hover:text-mid'}`}
          >
            {showSpam ? `Spam (${spamTxCount}) ← back` : `Spam: ${spamTxCount}`}
          </button>
        )}

        <span className="text-xs text-low">{filtered.length} shown</span>
        <div className="flex rounded-full border border-white/10 p-0.5 text-xs">
          {(
            [
              ['all', 'All'],
              ['spot', 'Spot'],
              ['derivative', 'Derivatives']
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setInstrumentFilter(id)}
              className={`rounded-full px-3 py-1 font-medium transition ${
                instrumentFilter === id ? 'bg-violet text-white' : 'text-low hover:text-mid'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-low">Export: CSV/JSON recommended for detailed CA review</span>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={exportFilteredCsv} className="text-xs">CSV</Button>
          <Button variant="secondary" onClick={exportFilteredJson} className="text-xs">JSON</Button>
          <Button variant="secondary" onClick={() => setPdfConfirmOpen(true)} className="text-xs">PDF</Button>
        </div>

        {/* Noves: only show for non-Helius users or as an explicit re-run option */}
        {!settings?.heliusApiKey && (
          <Button variant="secondary" disabled={detectingSwaps} onClick={runSwapDetection} className="shrink-0 text-xs">
            {detectingSwaps
              ? novesProgress ? `Noves ${novesProgress.done}/${novesProgress.total}…` : 'Detecting…'
              : settings?.novesApiKey ? 'Classify (Noves)' : 'Detect swaps'}
          </Button>
        )}

        {missingPriceTxs.length > 0 && settings?.priceApiEnabled && (
          <Button disabled={fetchingPrices} onClick={fetchMissingPrices} className="ml-auto shrink-0">
            {fetchingPrices
              ? `Fetching ${priceProgress?.done ?? 0}/${priceProgress?.total ?? missingPriceTxs.length}…`
              : `Fetch ${missingPriceTxs.length} price${missingPriceTxs.length === 1 ? '' : 's'}`}
          </Button>
        )}

        {selected.size > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* Bulk: Set type (dropdown → impact-summary confirm) */}
            <div className="relative">
              <Button
                variant="secondary"
                disabled={applyingBulk}
                onClick={() => {
                  setBulkFlagsMenuOpen(false);
                  setBulkTypeMenuOpen((o) => !o);
                }}
              >
                <Tags className="mr-1 h-3 w-3" />
                Set type ({selected.size})
              </Button>
              {bulkTypeMenuOpen && (
                <div className="absolute right-0 top-10 z-30 max-h-80 min-w-[11rem] overflow-y-auto rounded-lg border border-white/10 bg-elev-2 py-1 shadow-card">
                  <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-low">
                    Set {selected.size} selected to
                  </p>
                  {ALL_TYPES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => {
                        setBulkTypeMenuOpen(false);
                        setPendingBulkType(t);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-elev-1"
                    >
                      <Badge tone={TYPE_TONE[t]} className="pointer-events-none text-[10px]">{t}</Badge>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setBulkTypeMenuOpen(false)}
                    className="flex w-full items-center gap-1 border-t border-white/10 px-3 py-1.5 text-[10px] text-low hover:text-mid"
                  >
                    <X className="h-3 w-3" /> Cancel
                  </button>
                </div>
              )}
            </div>

            {/* Bulk: Set flags (checkbox list → Apply) */}
            <div className="relative">
              <Button variant="secondary" disabled={applyingBulk} onClick={openBulkFlags}>
                <Flag className="mr-1 h-3 w-3" />
                Set flags ({selected.size})
              </Button>
              {bulkFlagsMenuOpen && bulkFlagsSel && (
                <div className="absolute right-0 top-10 z-30 min-w-[16rem] rounded-lg border border-white/10 bg-elev-2 py-1 shadow-card">
                  <p className="px-3 py-1 text-[10px] uppercase tracking-wide text-low">
                    Apply to {selected.size} selected
                  </p>
                  <p className="px-3 pb-1 text-[10px] text-low">
                    Checked = set on all · unchecked = remove from all
                  </p>
                  {ALL_FLAGS.map((flag) => (
                    <label
                      key={flag}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-1"
                    >
                      <input
                        type="checkbox"
                        checked={bulkFlagsSel.flags.get(flag) ?? false}
                        onChange={(e) => setBulkFlag(flag, e.target.checked)}
                        className="accent-violet"
                      />
                      {FLAG_LABELS[flag]}
                    </label>
                  ))}
                  <p className="px-3 pb-1 text-[10px] text-low">
                    “Missing cost basis” also appears automatically while a row has no fiat value.
                  </p>
                  <div className="my-1 border-t border-white/10" />
                  <label className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-1">
                    <input
                      type="checkbox"
                      checked={bulkFlagsSel.internal}
                      onChange={(e) =>
                        setBulkFlagsSel((cur) => (cur ? { ...cur, internal: e.target.checked } : cur))
                      }
                      className="accent-violet"
                    />
                    Internal transfer (non-taxable)
                  </label>
                  <label className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-1">
                    <input
                      type="checkbox"
                      checked={bulkFlagsSel.spam}
                      onChange={(e) =>
                        setBulkFlagsSel((cur) => (cur ? { ...cur, spam: e.target.checked } : cur))
                      }
                      className="accent-violet"
                    />
                    Spam (excluded everywhere)
                  </label>
                  <div className="mt-1 flex justify-end gap-2 border-t border-white/10 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setBulkFlagsMenuOpen(false);
                        setBulkFlagsSel(null);
                      }}
                      className="rounded-full px-3 py-1 text-xs text-low hover:text-mid"
                    >
                      Cancel
                    </button>
                    <Button
                      variant="primary"
                      disabled={applyingBulk}
                      onClick={() => void applyBulkFlags()}
                      className="px-3 py-1 text-xs"
                    >
                      {applyingBulk ? 'Applying…' : `Apply to ${selected.size}`}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            <Button variant="secondary" disabled={applyingBulk} onClick={bulkMarkInternal}>
              Mark {selected.size} as internal
            </Button>
            <Button
              variant="secondary"
              onClick={bulkMarkSpam}
              disabled={applyingBulk}
              className="border-loss/40 text-loss hover:bg-loss/10"
            >
              <Ban className="mr-1 h-3 w-3" />
              Mark {selected.size} as spam
            </Button>
            <Button
              variant="secondary"
              onClick={() => setDeleteConfirmOpen(true)}
              className="border-loss/40 text-loss hover:bg-loss/10"
            >
              <Trash2 className="mr-1 h-3 w-3" />
              Delete {selected.size}
            </Button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={deleteConfirmOpen}
        destructive
        title={`Permanently delete ${selected.size} transaction${selected.size === 1 ? '' : 's'}?`}
        body="This cannot be undone. Use this to remove duplicate rows."
        confirmLabel="Delete"
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          void bulkDelete();
        }}
        onCancel={() => setDeleteConfirmOpen(false)}
      />

      <ConfirmDialog
        open={pdfConfirmOpen}
        title="Export as PDF?"
        body="PDF is best for sharing summaries. For detailed CA review, CSV/JSON is recommended."
        confirmLabel="Continue with PDF"
        onConfirm={() => {
          setPdfConfirmOpen(false);
          void exportFilteredPdf();
        }}
        onCancel={() => setPdfConfirmOpen(false)}
      />

      {/* Bulk "Set type" — impact-summary confirmation */}
      <ConfirmDialog
        open={pendingBulkType != null && bulkTypeImpact != null}
        title={
          pendingBulkType
            ? `Set ${selectedTxs.length} transaction${selectedTxs.length === 1 ? '' : 's'} to "${pendingBulkType.replace(/_/g, ' ')}"?`
            : ''
        }
        body={
          bulkTypeImpact ? (
            <div className="space-y-2">
              <p>
                Now:{' '}
                {bulkTypeImpact.fromCounts
                  .map(([t, n]) => `${n}× ${t.replace(/_/g, ' ')}`)
                  .join(', ')}
              </p>
              <ul className="list-disc space-y-1 pl-4">
                {bulkTypeImpactLines(bulkTypeImpact).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          ) : undefined
        }
        confirmLabel={applyingBulk ? 'Applying…' : `Apply to ${selectedTxs.length}`}
        onConfirm={() => void applyBulkType()}
        onCancel={() => setPendingBulkType(null)}
      />

      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="bg-elev-2 text-left text-xs uppercase tracking-wide text-low">
            <tr>
              <th className="w-8 px-2 py-2">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  title="Select all shown rows"
                  aria-label="Select all shown rows"
                />
              </th>
              <th className="px-2 py-2">Date</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Chain</th>
              <th className="px-2 py-2">Asset</th>
              <th className="px-2 py-2 text-right">Amount</th>
              <th className="px-2 py-2 text-right">Fiat</th>
              <th className="px-2 py-2">From</th>
              <th className="px-2 py-2">To</th>
              <th className="px-2 py-2">Tx Hash</th>
              <th className="min-w-[10rem] px-2 py-2">Flags</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-figures">
            {pageRows.map((t) => {
              const isDisposal = DISPOSAL_TYPES.has(t.type);
              const candidates = engineResult?.disposalCandidates[t.id] ?? [];
              const { fromAddr, toAddr } = txFromToAddresses(t);
              const chainLabel = t.chain ? CHAINS.find((c) => c.id === t.chain)?.label ?? t.chain : '—';
              const assetLabel = resolveAssetLabel(t.asset, t.contractAddress, t.chain);
              const isEditing = editingFiat === t.id;
              return (
                <Fragment key={t.id}>
                  <tr className={`border-t border-white/10 hover:bg-elev-1/20 ${t.isSpam ? 'opacity-50 line-through' : ''}`}>
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                    </td>
                    <td className="px-3 py-2 text-low">{new Date(t.timestamp).toISOString().slice(0, 10)}</td>
                    <td className="px-3 py-2">
                      <TypeSelector txId={t.id} current={t.type} flags={t.flags} />
                    </td>
                    <td className="px-3 py-2 text-low">{chainLabel}</td>
                    <td className="px-3 py-2 text-mid" title={t.contractAddress}>
                      {assetLabel}
                      {t.type === 'trade' && t.counterAsset && (
                        <span className="ml-1 text-low">
                          → {resolveAssetLabel(t.counterAsset, undefined, t.chain)}
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-2 text-right text-mid" title={
                      t.type === 'trade' && t.counterAmount != null
                        ? `${t.amount} → ${t.counterAmount}`
                        : String(t.amount)
                    }>
                      {t.type === 'trade' && t.counterAmount != null
                        ? `${formatCompactAmount(t.amount)} → ${formatCompactAmount(t.counterAmount)}`
                        : formatCompactAmount(t.amount)}
                    </td>
                    <td className="px-3 py-2 text-right text-low">
                      {isEditing ? (
                        <span className="flex items-center justify-end gap-1">
                          <input
                            autoFocus
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-24 rounded border border-violet bg-white px-2 py-0.5 text-right text-xs text-mid focus:outline-none"
                            placeholder="0.00"
                          />
                          <button onClick={() => saveFiat(t)} className="text-gain" aria-label="Save">
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => setEditingFiat(null)} className="text-low" aria-label="Cancel">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => startEditFiat(t.id, t.fiatValue)}
                          className="group inline-flex items-center gap-1 hover:text-gain"
                          title="Click to enter a fiat value manually"
                        >
                          {t.fiatValue != null ? formatCurrency(t.fiatValue, t.fiatCurrency) : '—'}
                          <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-2 text-low" title={fromAddr}>
                      {fromAddr ? (
                        <span title={fromAddr}>
                          {walletLabels.get(fromAddr.toLowerCase())
                            ? <span className="text-gain">{walletLabels.get(fromAddr.toLowerCase())}</span>
                            : truncateAddress(fromAddr)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-2 py-2 text-low" title={toAddr}>
                      {toAddr ? (
                        <span title={toAddr}>
                          {walletLabels.get(toAddr.toLowerCase())
                            ? <span className="text-gain">{walletLabels.get(toAddr.toLowerCase())}</span>
                            : truncateAddress(toAddr)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs text-low">
                      {t.sourceRef ? (
                        <a
                          href={
                            t.chain === 'solana'
                              ? `https://solscan.io/tx/${t.sourceRef}`
                              : `https://etherscan.io/tx/${t.sourceRef}`
                          }
                          target="_blank"
                          rel="noreferrer"
                          title={t.sourceRef}
                          className="hover:text-gain"
                        >
                          {t.sourceRef.slice(0, 8)}…
                        </a>
                      ) : '—'}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <FlagSelector tx={t} />
                      {isDisposal && settings?.defaultCostBasisMethod === 'SpecID' && (
                        <button
                          className="mt-1 text-gain underline decoration-dotted"
                          onClick={() => setOpenLotPicker((cur) => (cur === t.id ? null : t.id))}
                        >
                          match lots
                        </button>
                      )}
                    </td>
                  </tr>
                  {openLotPicker === t.id && (
                    <tr>
                      <td colSpan={11} className="bg-elev-1/60 px-3 py-3">
                        <LotPicker
                          txId={t.id}
                          candidates={candidates}
                          currentHint={hints[t.id]}
                          currency={t.fiatCurrency}
                          onSaved={() => setOpenLotPicker(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <p className="text-xs text-low">
            Showing {(safePage - 1) * PAGE_SIZE + 1}–
            {Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              className="text-xs"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <span className="text-xs text-low">
              Page {safePage} of {totalPages}
            </span>
            <Button
              variant="secondary"
              className="text-xs"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
