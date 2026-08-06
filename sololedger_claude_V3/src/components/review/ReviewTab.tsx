import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSpecIdHints, deleteTransactionsByIds, setTransactionSafetyVisibility } from '@/lib/storage/db';
import { Badge } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { TxType, Transaction, TransactionCategory, FlagReason, Jurisdiction, TaxSettings } from '@/types/transaction';
import { cn, formatAmountForExport, formatCompactAmount, formatCurrency, getFyBoundaries, getFyLabel, getAvailableFys, monetaryColumnLabel, downloadBlob, csvField } from '@/lib/utils';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { CHAINS } from '@/lib/rpc/providers';
import { buildWalletLabelMap, walletLabelFor } from './walletLabels';
import { explorerTxUrl } from '@/lib/parsers/explorer';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { looksLikeTruncatedMint, resolveTokenSymbolFromContract } from '@/lib/assets/tokenSymbols';
import { reprocessSwapDetectionInDb } from '@/lib/rpc/reprocessSwaps';
import { applyDefiLlamaRewardSuggestions, countNeedsReview, isNeedsReview, isUnclassifiedSolanaTransferIn, reclassifyTypePatch } from '@/lib/rpc/rewardSuggestions';
import { countPotentialSwapPairs } from '@/lib/rpc/swapDetection';
import { detectDcaGroups, applyDcaClassification } from '@/lib/rpc/dcaDetection';
import { repairDcaMisclassifications } from '@/lib/rpc/dcaRepair';
import {
  shouldAutoResolveTokenNames,
  markTokenResolveAutoRun,
  showTokenResolveBanner,
  showLlamaBanner,
  showLlamaResultMessage,
  shouldAutoApplyDca,
  dcaGroupSignature,
  showDcaBanner,
  shouldRunDcaRepair,
  markDcaRepairDone
} from '@/lib/review/hostedAuto';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import { isSaasMode } from '@/lib/saas/config';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { SAAS_PROXY_KEY } from '@/lib/saas/lookupConfig';
import { llamaBannerHint, markLlamaAutoRun, shouldAutoRunLlamaSuggestions } from '@/lib/review/llamaAutoSuggest';
import {
  ALL_FLAGS,
  BULK_FLAG_CHECKBOXES,
  bulkFlagsPatch,
  bulkCategoryPatch,
  bulkTypeImpactLines,
  bulkTypePatch,
  initialBulkFlagsSelection,
  needsPriceLine,
  summarizeBulkTypeChange
} from '@/lib/review/bulkEdit';
import { supportsSpecificIdEditing } from '@/lib/review/specificIdEditing';
import type { BulkFlagsSelection } from '@/lib/review/bulkEdit';
import { displayFlags } from '@/lib/review/displayFlags';
import { filterRows, paginate } from '@/lib/review/reviewTableView';
import { requiresMarketValue } from '@/lib/transactions/requiresMarketValue';
import { AssetIcon, SourceIcon } from './brandIcons';
import {
  groupRowsByDate, formatGroupDateLabel, pageNumberList, reviewTransactionHash
} from './reviewListUtils';
import { buildTxSummary, reviewTypeLabel, txFlow, truncateAddress, OWN_ACCOUNT_SIDE, type RowLeg } from './rowAnatomy';
import {
  Check, X, Pencil, AlertTriangle, ArrowUpDown, Trash2, ListChecks, Tags, Flag, Sparkles,
  ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Copy, ArrowRight, ArrowLeft, Search, Link2, Wallet, Banknote
} from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTabNav } from '@/lib/tabNav';
import { createBrandedPdf, pdfTableStyles, truncatePdfRef } from '@/lib/export/pdfTheme';
import autoTable from 'jspdf-autotable';
import { isDerivativeTransaction } from '@/lib/tax/derivatives';
import { derivePostings, resolveAccountScope } from '@/lib/ledger/derivedPostings';
import { buildTransactionPostingIndex, preparePostingAggregation } from '@/lib/ledger/postingBalances';
import { reconcileDerivedPostings } from '@/lib/reconcile/sourceReconcile';
import { buildReconciliationEvidenceIndexes, projectReconciliationCoverage } from '@/lib/reconcile/evidenceIndexes';
import { setBulkActionsActive } from '@/lib/ui/floatingOverlayActivity';
import { decideSuggestedTransferPair, unlinkTransferPair } from '@/lib/internalTransfers/persistence';
import { buildTransactionCostAnalysisIndexes, buildTransactionCostAnalysisModel } from './transactionCostAnalysisModel';
import { parseManualMarketValue } from './manualMarketValue';
import { buildReviewReconciliationEvidence } from './reviewReconciliationEvidence';
import { TransactionDetailPanel, type DetailTab } from './TransactionDetailPanel';
import { LotPicker } from './LotPicker';
import { type TransactionNavigationIntent, type TransactionScopeFilter } from '@/lib/navigationIntent';
import { canonicalWalletIdentity } from '@/lib/ledger/chainNamespace';
import { isTransactionExcluded } from '@/lib/safety/assetSafety';
import { hasDurableNavigationScope, resolveReviewTransactionTarget, transactionMatchesNavigationScope } from './reviewNavigation';
import { buildSourcePresentationIndexes, buildTransactionSourcePresentations } from '@/lib/sources/sourcePresentation';
import { buildReviewSourceFilterOptions, transactionMatchesSourceFilter } from './reviewSourceFilters';
import { resolveTaxPolicy } from '@/lib/taxonomy/taxPolicy';
import { buildTransactionById, linkedCounterpartFor, transactionPage } from './counterpartNavigation';
import { principalAssetIdentityForLeg } from './reviewAssetIcons';
import { categoryLabel } from '@/lib/taxonomy/categories';
import {
  canResetClassification,
  compatibleCategories,
  confirmClassification,
  rejectClassificationSuggestion,
  resetClassification,
  userClassificationPatch
} from '@/lib/taxonomy/classification';

const ALL_TYPES: TxType[] = [
  'buy', 'sell', 'trade', 'transfer_in', 'transfer_out',
  'income', 'gift_sent', 'gift_received', 'fee',
  'nft_mint', 'nft_buy', 'nft_sell',
  'defi_deposit', 'defi_withdraw', 'other'
];

const FLAG_LABELS: Record<FlagReason, string> = {
  possible_internal_transfer: 'Possible internal transfer',
  missing_market_value: 'Missing market value',
  missing_cost_basis: 'Missing cost basis',
  invalid_transaction_data: 'Invalid transaction data',
  duplicate_suspected: 'Duplicate suspected',
  unrecognized_asset: 'Unrecognized asset',
  needs_review: 'Needs review'
};

/** Directional dot color on the row-face type label (mockup: teal buy, rose sell…). */
const TYPE_DOT: Record<TxType, string> = {
  buy: 'bg-gain',
  sell: 'bg-loss',
  trade: 'bg-primary',
  transfer_in: 'bg-gain',
  transfer_out: 'bg-loss',
  income: 'bg-gain',
  gift_sent: 'bg-faint',
  gift_received: 'bg-gain',
  fee: 'bg-faint',
  nft_mint: 'bg-accent',
  nft_buy: 'bg-accent',
  nft_sell: 'bg-accent',
  defi_deposit: 'bg-warn',
  defi_withdraw: 'bg-warn',
  other: 'bg-faint'
};

/**
 * Filter-bar dropdown styled as a mockup `.chip` — pill shaped, 44px touch
 * target, ember highlight while a non-default value is active.
 */
function ChipSelect({
  value,
  onChange,
  ariaLabel,
  active,
  icon,
  className,
  children
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  active?: boolean;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('relative', className)}>
      {icon && (
        <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint">{icon}</span>
      )}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={cn(
          'h-11 max-w-full appearance-none text-ellipsis rounded-full border bg-elev-1 pr-8 text-[0.8125rem] font-semibold shadow-xs transition-colors',
          'hover:border-hi/20 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30',
          icon ? 'pl-9' : 'pl-4',
          active ? 'border-primary/50 bg-primary/[0.06] text-primary' : 'border-hi/10 text-mid'
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
    </div>
  );
}

export function FlagSelector({ tx, derivedFlags = [] }: { tx: Transaction; derivedFlags?: readonly FlagReason[] }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pairActionError, setPairActionError] = useState<string | null>(null);
  const [localFlagState, setLocalFlagState] = useState<{
    source: Transaction['flags'];
    value: FlagReason[];
  }>(() => ({ source: tx.flags, value: tx.flags ?? [] }));
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const closeAndRestoreFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  // Match TypeSelector: dismiss on Escape or a press outside the selector.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeAndRestoreFocus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // A changed Dexie row supersedes the optimistic value without an extra
  // synchronization render; while the prop is unchanged, the local value
  // keeps the just-persisted deselection visible.
  const localFlags = localFlagState.source === tx.flags
    ? localFlagState.value
    : tx.flags ?? [];
  const storedFlags = new Set(localFlags);
  const shownFlags = displayFlags({ ...tx, flags: localFlags }, derivedFlags);
  const spam = isTransactionExcluded(tx);

  const patch = async (update: Partial<Transaction>) => {
    setSaving(true);
    try {
      await db.transactions.update(tx.id, update);
    } finally {
      setSaving(false);
    }
  };

  const toggleFlag = async (flag: FlagReason) => {
    const previous = localFlags;
    const next = new Set(previous);
    if (next.has(flag)) next.delete(flag);
    else next.add(flag);
    const nextFlags = [...next] as FlagReason[];
    setLocalFlagState({ source: tx.flags, value: nextFlags });
    try {
      await patch({ flags: nextFlags });
    } catch {
      setLocalFlagState({ source: tx.flags, value: previous });
    }
  };

  const expectedPairState = tx.internalTransferPairId && tx.linkedTransferId && tx.internalTransferDecision &&
    tx.internalTransferDecisionAt != null && tx.internalTransferMatcherVersion
    ? {
        transactionId: tx.id,
        pairId: tx.internalTransferPairId,
        linkedTransactionId: tx.linkedTransferId,
        decision: tx.internalTransferDecision,
        decisionAt: tx.internalTransferDecisionAt,
        matcherVersion: tx.internalTransferMatcherVersion
      }
    : undefined;

  const runPairAction = async (action: () => Promise<void>) => {
    setSaving(true);
    setPairActionError(null);
    try {
      await action();
      setOpen(false);
    } catch (error) {
      setPairActionError(error instanceof Error ? error.message : 'The internal transfer action could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Click to flag this transaction"
        aria-label="Edit transaction flags"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        className="flex min-h-[36px] max-w-[16rem] flex-wrap items-center gap-1 rounded-md px-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        {tx.isInternalTransfer && <Badge tone="neutral" className="text-[10px]">internal</Badge>}
        {spam && <Badge tone="loss" className="text-[10px]">spam</Badge>}
        {tx.category === 'nft' && <Badge tone="accent" className="text-[10px]">nft</Badge>}
        {shownFlags.map((f) => (
          <Badge
            key={f}
            tone={f === 'possible_internal_transfer' ? 'primary' : 'warn'}
            className="text-[10px]"
            title={ALL_FLAGS.includes(f) ? undefined : 'Automatically detected; resolve the underlying issue to clear it'}
          >
            {f.replace(/_/g, ' ')}{!ALL_FLAGS.includes(f) && ' · automatic'}
          </Badge>
        ))}
        {shownFlags.length === 0 && !tx.isInternalTransfer && !spam && tx.category !== 'nft' && (
          <span className="text-[10px] text-faint">—</span>
        )}
        {saving && <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />}
      </button>
      {open && (
        <div id={menuId} role="group" aria-labelledby={`${menuId}-label`} className="absolute left-0 top-9 z-30 min-w-[15rem] rounded-xl border border-hi/10 bg-elev-2 py-1 shadow-pop">
          <p id={`${menuId}-label`} className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-low">Flag transaction</p>
          {ALL_FLAGS.map((flag) => {
            const on = storedFlags.has(flag);
            return (
              <button
                key={flag}
                type="button"
                aria-pressed={on}
                onClick={() => void toggleFlag(flag)}
                className={`flex min-h-[40px] w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-elev-3 ${on ? 'font-semibold text-gain' : 'text-mid'}`}
              >
                <span className={`grid h-4 w-4 place-items-center rounded border ${on ? 'border-primary bg-primary text-white' : 'border-hi/25 bg-transparent'}`} aria-hidden="true">
                  {on && <Check className="h-3 w-3" />}
                </span>
                {FLAG_LABELS[flag]}
              </button>
            );
          })}
          <div className="my-1 border-t border-hi/10" />
          {pairActionError && <p role="alert" className="px-3 py-2 text-xs text-loss">{pairActionError}</p>}
          {tx.internalTransferDecision === 'suggested' && expectedPairState && (
            <>
              <button type="button" onClick={() => void runPairAction(() => decideSuggestedTransferPair(expectedPairState, 'confirmed'))}
                className="flex min-h-[40px] w-full px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-3">
                Confirm suggested pair
              </button>
              <button type="button" onClick={() => void runPairAction(() => decideSuggestedTransferPair(expectedPairState, 'rejected'))}
                className="flex min-h-[40px] w-full px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-3">
                Reject suggested pair
              </button>
            </>
          )}
          {tx.internalTransferPairId && tx.internalTransferDecision !== 'suggested' && expectedPairState && (
            <button type="button" onClick={() => void runPairAction(() => unlinkTransferPair(expectedPairState))}
              className="flex min-h-[40px] w-full px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-3">
              Unlink counterpart
            </button>
          )}
          <button
            type="button"
            aria-pressed={tx.isInternalTransfer}
            disabled={tx.internalTransferPairId != null}
            onClick={() =>
              void patch({
                isInternalTransfer: !tx.isInternalTransfer,
                flags: tx.isInternalTransfer
                  ? (['possible_internal_transfer'] as FlagReason[])
                  : ([] as FlagReason[])
              })
            }
            className="flex min-h-[40px] w-full px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-3 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {tx.isInternalTransfer ? '↩ Unmark internal transfer' : '✓ Mark as internal transfer'}
          </button>
          <button
            type="button"
            aria-pressed={spam}
            onClick={() => void setTransactionSafetyVisibility(tx, spam)}
            className="flex min-h-[40px] w-full px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-3"
          >
            {spam ? '↩ Restore visibility' : 'Hide as spam'}
          </button>
          <button
            type="button"
            onClick={closeAndRestoreFocus}
            className="flex min-h-[36px] w-full items-center gap-1 border-t border-hi/10 px-3 py-1.5 text-[10px] text-low hover:text-mid"
          >
            <X className="h-3 w-3" /> Close
          </button>
        </div>
      )}
    </div>
  );
}

function TypeSelector({ tx }: { tx: Transaction }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = tx.type;

  // Close on Escape / outside press while the menu is open (capture phase so
  // the row's own key handling can't swallow Escape first).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const reclassify = async (next: TxType) => {
    if (next === current) { setOpen(false); return; }
    setSaving(true);
    // reclassifyTypePatch strips auto-derived + needs_review flags and, crucially,
    // does NOT clear a `defi_reward` category — that category persists as the
    // "already reviewed this suggestion" marker so a rejected row is never
    // re-flipped to income by applyDefiLlamaRewardSuggestions. See that helper.
    let patch: Partial<Transaction>;
    try {
      patch = userClassificationPatch(tx, next, tx.category ?? 'other');
    } catch {
      patch = userClassificationPatch(tx, next, 'other');
    }
    await db.transactions.update(tx.id, { ...reclassifyTypePatch(tx, next), ...patch });
    setSaving(false);
    setOpen(false);
  };

  return (
    <div className="relative" ref={rootRef} onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((o) => !o)}
        title="Click to reclassify this transaction"
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex min-h-[32px] items-center gap-1.5 rounded-md px-1 text-[0.8125rem] font-bold text-hi transition-colors hover:bg-elev-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      >
        <span className={cn('h-1.5 w-1.5 rounded-full', TYPE_DOT[current])} aria-hidden="true" />
        {reviewTypeLabel(tx)}
        {open
          ? <ChevronUp className="h-3 w-3 text-faint" aria-hidden="true" />
          : <ChevronDown className="h-3 w-3 text-faint" aria-hidden="true" />}
        {saving && <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />}
      </button>
      {open && (
        <div role="menu" className="absolute left-0 top-9 z-30 max-h-80 min-w-[11rem] overflow-y-auto rounded-xl border border-hi/10 bg-elev-2 py-1 shadow-pop">
          <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-low">Reclassify as</p>
          {ALL_TYPES.map((t) => (
            <button
              key={t}
              onClick={() => void reclassify(t)}
              className={`flex min-h-[36px] w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-elev-3 ${t === current ? 'bg-primary/[0.06]' : ''}`}
            >
              <Badge tone={TYPE_TONE[t]} className="pointer-events-none text-[10px]">{t}</Badge>
            </button>
          ))}
          <button
            onClick={() => setOpen(false)}
            className="flex min-h-[36px] w-full items-center gap-1 border-t border-hi/10 px-3 py-1.5 text-[10px] text-low hover:text-mid"
          >
            <X className="h-3 w-3" /> Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function CategorySelector({ tx }: { tx: Transaction }) {
  const categories = compatibleCategories(tx.type);
  const isSuggestion = tx.categoryOrigin === 'suggestion' && !tx.categoryLocked;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" onClick={(event) => event.stopPropagation()}>
      <select
        aria-label="Semantic category"
        title="Semantic category (separate from structural type)"
        value={tx.category ?? 'other'}
        onChange={(event) => void db.transactions.update(
          tx.id,
          userClassificationPatch(tx, tx.type, event.target.value as TransactionCategory)
        )}
        className="max-w-[10rem] rounded-md border border-hi/10 bg-elev-1 px-1 py-0.5 text-[10px] text-mid"
      >
        {categories.map((category) => <option key={category} value={category}>{categoryLabel(category)}</option>)}
      </select>
      {isSuggestion && (
        <>
          <button type="button" className="text-[10px] font-semibold text-gain hover:underline"
            onClick={() => void db.transactions.update(tx.id, confirmClassification(tx))}>
            Confirm classification
          </button>
          <button type="button" className="text-[10px] font-semibold text-loss hover:underline"
            onClick={() => void db.transactions.update(tx.id, rejectClassificationSuggestion(tx))}>
            Reject suggestion
          </button>
        </>
      )}
      {canResetClassification(tx) && (
        <button
          type="button"
          className="text-[10px] font-semibold text-primary hover:underline"
          title="Reset and reapply retained parser/provider evidence"
          onClick={() => void db.transactions.put(resetClassification(tx))}
        >Reset</button>
      )}
    </div>
  );
}

const TYPE_TONE: Record<TxType, 'neutral' | 'gain' | 'warn' | 'loss' | 'primary' | 'accent'> = {
  buy: 'gain',
  sell: 'loss',
  trade: 'primary',
  transfer_in: 'neutral',
  transfer_out: 'neutral',
  income: 'gain',
  gift_sent: 'neutral',
  gift_received: 'neutral',
  fee: 'neutral',
  nft_mint: 'accent',
  nft_buy: 'accent',
  nft_sell: 'accent',
  defi_deposit: 'warn',
  defi_withdraw: 'warn',
  other: 'neutral'
};

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

/** Copy-to-clipboard icon button with a brief tick confirmation. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-gain" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Label/value row inside the expanded Details panel (mockup `eyebrow` + value). */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 text-[10px] font-bold uppercase tracking-wide text-low">{label}</span>
      <span className="flex min-w-0 items-center gap-1 text-xs font-semibold text-mid">{children}</span>
    </div>
  );
}

export function ReviewTab({ navigationIntent, navigationResetToken, onNavigationIntentAcknowledged, onNavigationBack }: {
  navigationIntent?: TransactionNavigationIntent;
  navigationResetToken?: number;
  onNavigationIntentAcknowledged?: (id: string) => void;
  onNavigationBack?: () => void;
} = {}) {
  const [query, setQuery] = useState('');
  const [assetFilter, setAssetFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<TxType | 'all'>('all');
  const [flagFilter, setFlagFilter] = useState<FlagReason | 'all' | 'spam' | 'internal'>('all');
  const [walletFilter, setWalletFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [fyFilter, setFyFilter] = useState<number | null>(null);
  const [showNeedsPrice, setShowNeedsPrice] = useState(false);
  const [showNeedsReview, setShowNeedsReview] = useState(false);
  const [showSpam, setShowSpam] = useState(false);
  const [sortBy, setSortBy] = useState<'date_desc' | 'date_asc' | 'wallet' | 'asset' | 'type' | 'fy'>('date_desc');
  const [instrumentFilter, setInstrumentFilter] = useState<'all' | 'spot' | 'derivative'>('all');
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 200;
  const [jurisdiction, setJurisdiction] = useState<Jurisdiction>('IN');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    setBulkActionsActive(selected.size > 0);
    return () => setBulkActionsActive(false);
  }, [selected.size]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const [navigationTargetId, setNavigationTargetId] = useState<string | null>(null);
  const [navigationScopeFilter, setNavigationScopeFilter] = useState<TransactionScopeFilter | null>(null);
  const appliedNavigationIntent = useRef<string | null>(null);
  const [pendingNavigationFocus, setPendingNavigationFocus] = useState<TransactionNavigationIntent | null>(null);
  const [pendingCounterpartFocus, setPendingCounterpartFocus] = useState<string | null>(null);
  const [openLotPicker, setOpenLotPicker] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pdfConfirmOpen, setPdfConfirmOpen] = useState(false);
  // Bulk-edit: "Set type" (dropdown → impact-summary confirm) + "Set flags".
  const [bulkTypeMenuOpen, setBulkTypeMenuOpen] = useState(false);
  const [bulkCategoryMenuOpen, setBulkCategoryMenuOpen] = useState(false);
  const [pendingBulkCategory, setPendingBulkCategory] = useState<TransactionCategory | null>(null);
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
  const [detailTabByTxId, setDetailTabByTxId] = useState<Record<string, DetailTab>>({});
  const [fetchingPrices, setFetchingPrices] = useState(false);
  const [priceProgress, setPriceProgress] = useState<{ done: number; total: number } | null>(null);
  const [priceErrors, setPriceErrors] = useState<string[]>([]);
  const [editingFiat, setEditingFiat] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [swapDetectMsg, setSwapDetectMsg] = useState<string | null>(null);
  const [resolvingSymbols, setResolvingSymbols] = useState(false);
  // Phase 2: DefiLlama reward-income suggestions (user-gated fetch).
  const [llamaSuggesting, setLlamaSuggesting] = useState(false);
  const [llamaMsg, setLlamaMsg] = useState<string | null>(null);
  const [llamaSuggested, setLlamaSuggested] = useState(0);
  // Hosted mode: every Review-tab check runs automatically — the three action
  // banners (token names, DefiLlama, DCA) are for local/BYOK users only.
  const hosted = isSaasMode();
  // Feedback line for the manual (local/BYOK) DCA classify button.
  const [dcaMsg, setDcaMsg] = useState<string | null>(null);
  // Hosted one-time repair of pre-hardening DCA mis-classifications.
  const [repairingDca, setRepairingDca] = useState(false);
  const repairAttemptedRef = useRef(false);
  // EFFECTIVE "Live price lookup" flag. In SaaS mode the SERVER public config
  // decides — the local settings singleton reports priceApiEnabled=false for
  // the hosted admin even though the relay has it on — so resolve via
  // getEffectiveSettings(), the same way WalletLookupPanel does. `null` while
  // resolving; treated as OFF by the banner variant + the auto-run guard.
  const [priceLookupEnabled, setPriceLookupEnabled] = useState<boolean | null>(null);
  const [effectivePricingSettings, setEffectivePricingSettings] = useState<TaxSettings | null>(null);

  const { goToImport } = useTabNav();
  const transactionsLive = useLiveQuery(() => db.transactions.toArray(), []);
  // Stable empty array while the query resolves, so dependent memos don't
  // recompute on every render (react-hooks/exhaustive-deps).
  const transactions = useMemo(() => transactionsLive ?? [], [transactionsLive]);
  const transactionsById = useMemo(() => buildTransactionById(transactions), [transactions]);
  const ledgerEvidenceLive = useLiveQuery(async () => {
    const [exchangeConnections, openingBalances, coverage, authoritySnapshots, authorityAssets, accountIdentities, csvImports, lookupAddresses] = await Promise.all([
      db.exchangeConnections.toArray(), db.openingBalances.toArray(), db.sourceCoverage.toArray(), db.authoritySnapshots.toArray(), db.authorityAssets.toArray(),
      db.accountIdentities.toArray(), db.csvImports.toArray(), db.lookupAddresses.toArray()
    ]);
    return { exchangeConnections, openingBalances, coverage, authoritySnapshots, authorityAssets, accountIdentities, csvImports, lookupAddresses };
  }, []);
  const ledgerEvidence = useMemo(() => ledgerEvidenceLive ?? {
    exchangeConnections: [], openingBalances: [], coverage: [], authoritySnapshots: [], authorityAssets: [],
    accountIdentities: [], csvImports: [], lookupAddresses: []
  }, [ledgerEvidenceLive]);
  const { exchangeConnections, openingBalances, coverage, authoritySnapshots, authorityAssets, accountIdentities, csvImports, lookupAddresses } = ledgerEvidence;
  const [authoritySelectionNow] = useState(Date.now);
  const postingSnapshot = useMemo(() => {
    const context = {
      exchangeConnections: exchangeConnections.map((row) => ({
        id: row.id, exchange: row.exchange
      })),
      openingBalances
    };
    const postings = derivePostings(transactions, context);
    const prepared = preparePostingAggregation(postings, true);
    return { context, postings, prepared, index: buildTransactionPostingIndex(postings, prepared) };
  }, [transactions, exchangeConnections, openingBalances]);
  const evidenceIndexes = useMemo(() => buildReconciliationEvidenceIndexes(
    authoritySnapshots, authorityAssets, projectReconciliationCoverage(coverage, exchangeConnections)
  ), [authoritySnapshots, authorityAssets, coverage, exchangeConnections]);
  const { coverageByScope, authorityCoverageByScope, authorityByScope } = useMemo(
    () => buildReviewReconciliationEvidence(evidenceIndexes, authoritySelectionNow),
    [evidenceIndexes, authoritySelectionNow]
  );
  const hintsLive = useLiveQuery(() => getSpecIdHints(), []);
  const hints = useMemo(() => hintsLive ?? {}, [hintsLive]);

  // Wallet labels from Connections — a LIVE query so renaming a wallet in
  // Connections updates every row's name resolution in place.
  const walletLabels = useMemo(
    () => buildWalletLabelMap(lookupAddresses),
    [lookupAddresses]
  );
  const sourcePresentationIndexes = useMemo(() => buildSourcePresentationIndexes({
    accounts: accountIdentities, wallets: lookupAddresses, exchanges: exchangeConnections, csvImports
  }), [accountIdentities, lookupAddresses, exchangeConnections, csvImports]);
  const sourcePresentations = useMemo(() => buildTransactionSourcePresentations(
    transactions,
    sourcePresentationIndexes,
    (chain) => CHAINS.find((candidate) => candidate.id === chain)?.label ?? chain
  ), [transactions, sourcePresentationIndexes]);

  // Load jurisdiction on mount
  useEffect(() => {
    db.settings.get('singleton').then((s) => {
      if (s?.jurisdiction) setJurisdiction(s.jurisdiction as Jurisdiction);
    });
  }, []);

  const availableFys = useMemo(
    () => getAvailableFys(transactions.map((t) => t.timestamp), jurisdiction),
    [transactions, jurisdiction]
  );
  const availableWallets = useMemo(() => {
    const ws = new Map<string, { key: string; address: string }>();
    for (const t of transactions) {
      if (!t.walletAddress) continue;
      const key = canonicalWalletIdentity(t.chain ?? '', t.walletAddress);
      if (!ws.has(key)) ws.set(key, { key, address: t.walletAddress });
    }
    return Array.from(ws.values());
  }, [transactions]);

  /** Exact source incarnations/generations; labels never collapse same-brand accounts. */
  const availableSources = useMemo(
    () => buildReviewSourceFilterOptions(transactions, sourcePresentations),
    [transactions, sourcePresentations]
  );


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

  const resolveTokenSymbols = useCallback(async () => {
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
  }, [resolvingSymbols, unresolvedSymbolTxs]);

  // Hosted: resolve contract-address tokens to real tickers AUTOMATICALLY
  // (once per session, via the relay's CoinGecko key) — no banner, no button.
  // Local/BYOK keep the manual banner below so the network call stays
  // user-triggered.
  useEffect(() => {
    if (
      !shouldAutoResolveTokenNames({
        hosted,
        unresolvedCount: unresolvedSymbolTxs.length,
        inFlight: resolvingSymbols
      })
    ) {
      return;
    }
    markTokenResolveAutoRun();
    void resolveTokenSymbols();
  }, [hosted, unresolvedSymbolTxs.length, resolvingSymbols, resolveTokenSymbols]);

  const engineResult = useMemo(() => {
    if (!settings) return null;
    return calculateCostBasis(transactions, { method: settings.defaultCostBasisMethod, specIdHints: hints, settings });
  }, [transactions, settings, hints]);

  /** Matched disposals keyed by their source transaction id (row cost/gain sublines + expanded Analysis). */
  const disposalByTxId = useMemo(
    () => new Map((engineResult?.disposals ?? []).map((d) => [d.sourceTxId, d])),
    [engineResult]
  );
  const costAnalysisIndexes = useMemo(() => buildTransactionCostAnalysisIndexes({
    disposals: engineResult?.disposals ?? [],
    inventoryDisposals: engineResult?.inventoryDisposals ?? [],
    lots: engineResult?.lots ?? [],
    transactions: settings ? transactions : [],
    settings: settings ?? {
      jurisdiction, reportingCurrency: 'USD', defaultCostBasisMethod: 'FIFO',
      priceApiEnabled: false, rpcLookupEnabled: false
    }
  }), [engineResult, transactions, settings, jurisdiction]);

  const derivedFlagsByTxId = useMemo(() => {
    const flags = new Map<string, Set<FlagReason>>();
    const add = (transactionId: string, reason: FlagReason) => {
      const current = flags.get(transactionId) ?? new Set<FlagReason>();
      current.add(reason);
      flags.set(transactionId, current);
    };
    for (const shortfall of engineResult?.shortfalls ?? []) add(shortfall.transactionId, 'missing_cost_basis');
    for (const flag of engineResult?.flags ?? []) add(flag.transactionId, flag.reason);
    return new Map([...flags].map(([id, reasons]) => [id, [...reasons]]));
  }, [engineResult]);

  const missingCostBasisTxIds = useMemo(() => new Set(
    [...derivedFlagsByTxId]
      .filter(([, flags]) => flags.includes('missing_cost_basis'))
      .map(([id]) => id)
  ), [derivedFlagsByTxId]);

  /** Tax-relevant rows missing historical fiat value; internal custody moves do not need basis. */
  const missingPriceTxs = useMemo(
    () => transactions.filter((t) => !isTransactionExcluded(t) && !t.isInternalTransfer && t.fiatValue == null && requiresMarketValue(t)),
    [transactions]
  );

  const spamTxCount = useMemo(() => transactions.filter(isTransactionExcluded).length, [transactions]);

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

  /** Unclassified Solana transfer_ins that could be reward income (no network). */
  const solanaTransferInCount = useMemo(
    () => transactions.filter(isUnclassifiedSolanaTransferIn).length,
    [transactions]
  );

  /** The review queue: rows flagged needs_review (e.g. DefiLlama suggestions). */
  const needsReviewCount = useMemo(() => countNeedsReview(transactions), [transactions]);

  const suggestRewardIncome = useCallback(async () => {
    if (llamaSuggesting) return;
    setLlamaSuggesting(true);
    setLlamaMsg(null);
    try {
      const result = await applyDefiLlamaRewardSuggestions();
      setLlamaMsg(result.message);
      setLlamaSuggested(result.suggested);
      if (result.suggested > 0) {
        // Open the review queue and clear the other quick filters — they are
        // mutually exclusive, and leaving "Needs price"/"Spam" active would
        // hide the freshly-suggested rows (or empty the table for Spam).
        setShowNeedsReview(true);
        setShowNeedsPrice(false);
        setShowSpam(false);
      }
    } catch (err) {
      setLlamaMsg(
        err instanceof Error
          ? `DefiLlama suggestion failed: ${err.message}`
          : 'DefiLlama suggestion failed unexpectedly.'
      );
    } finally {
      setLlamaSuggesting(false);
    }
  }, [llamaSuggesting]);

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

  // Resolve the effective price-lookup flag once on mount (server public
  // config in SaaS mode, local setting otherwise).
  useEffect(() => {
    let cancelled = false;
    getEffectiveSettings()
      .then((s) => {
        if (!cancelled) {
          setPriceLookupEnabled(s.priceApiEnabled);
          setEffectivePricingSettings(s);
        }
      })
      .catch(() => {
        /* keep null → treated as OFF; the banner variant + the auto-run guard */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Once-per-session auto DefiLlama reward suggestions for CSV/manual/existing
  // data viewed in Review without a fresh wallet import. Gated behind the
  // EFFECTIVE priceApiEnabled — this is the one approved relaxation of the "no
  // background network in local mode" policy (network egress is already
  // permitted when Live price lookup is on). Wallet imports run the same pass
  // in importJob.ts. suggestRewardIncome wraps any failure into llamaMsg, so a
  // DefiLlama outage never breaks the tab (same non-fatal treatment as
  // importJob.ts). All guards (enabled / candidates / not-run-this-session /
  // none in flight) live in the pure, unit-tested shouldAutoRunLlamaSuggestions.
  useEffect(() => {
    if (
      !shouldAutoRunLlamaSuggestions({
        priceLookupEnabled,
        candidateCount: solanaTransferInCount,
        inFlight: llamaSuggesting
      })
    ) {
      return;
    }
    markLlamaAutoRun();
    void suggestRewardIncome();
  }, [priceLookupEnabled, solanaTransferInCount, llamaSuggesting, suggestRewardIncome]);

  const fetchMissingPrices = async () => {
    if (!effectivePricingSettings?.priceApiEnabled || missingPriceTxs.length === 0) return;
    setFetchingPrices(true);
    setPriceErrors([]);
    try {
      const r = await fetchMissingPricesForAllTransactions(effectivePricingSettings, (done, total) =>
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

  const startEditFiat = (txId: string, current?: number) => {
    setEditingFiat(txId);
    setEditValue(current != null ? String(current) : '');
    // The inline editor lives in the Details panel — open the row so the
    // input the user just asked for is actually on screen.
    setExpandedId(txId);
  };

  const saveFiat = async (tx: (typeof transactions)[number]) => {
    const parsed = parseManualMarketValue(editValue);
    if (parsed == null) return;
    await db.transactions.update(tx.id, {
      fiatValue: parsed,
      flags: (tx.flags ?? []).filter((f) => f !== 'missing_market_value')
    });
    setEditingFiat(null);
  };

  const assets = useMemo(() => Array.from(new Set(transactions.map((t) => t.asset))).sort(), [transactions]);

  // Detect DCA groups whenever transactions change. Detection is pure/offline;
  // spam/internal handling lives INSIDE detectDcaGroups so this caller and
  // importJob see identical results (the old pre-filter here hid classified
  // deposits from the recurrence count and diverged from importJob).
  useEffect(() => {
    setDcaGroups(detectDcaGroups(transactions));
  }, [transactions]);

  // Hosted: one-time repair of pre-hardening DCA mis-classifications (undo
  // every auto-grouping, redo with the hardened Jupiter-verified rules). Runs
  // before the auto-apply below; a Jupiter-unreachable abort does NOT consume
  // the one-time key so it retries next session.
  useEffect(() => {
    if (!hosted || repairAttemptedRef.current || !shouldRunDcaRepair(hosted)) return;
    repairAttemptedRef.current = true;
    setRepairingDca(true);
    void (async () => {
      try {
        const res = await repairDcaMisclassifications(settings?.alchemyApiKey ?? SAAS_PROXY_KEY);
        if (res.status !== 'aborted-unreachable') markDcaRepairDone();
      } catch {
        // Non-fatal — retried on the next visit.
      } finally {
        setRepairingDca(false);
      }
    })();
    // settings?.alchemyApiKey is stable for the session; the repair is one-time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hosted]);

  // Hosted: classify every detected group automatically (no banner, no
  // once-per-session cap — a second import in the same session must classify
  // too). The signature guard breaks the skip-path loop: a skipped run writes
  // nothing, so without it the effect would refire forever on the same rows.
  // Local/BYOK: no auto-apply — the banner + button below stay manual.
  const lastDcaAttemptRef = useRef<string | null>(null);
  useEffect(() => {
    const currentSignature = dcaGroupSignature(dcaGroups);
    if (
      !shouldAutoApplyDca({
        hosted,
        groupCount: dcaGroups.length,
        inFlight: applyingDca,
        repairActive: repairingDca,
        lastAttemptedSignature: lastDcaAttemptRef.current,
        currentSignature
      })
    ) {
      return;
    }
    lastDcaAttemptRef.current = currentSignature;
    void (async () => {
      setApplyingDca(true);
      try {
        await applyDcaClassification(dcaGroups, settings?.alchemyApiKey ?? SAAS_PROXY_KEY);
      } catch {
        // Non-fatal — the next NEW detection round retries.
      } finally {
        setApplyingDca(false);
      }
    })();
  }, [hosted, dcaGroups, applyingDca, repairingDca, settings?.alchemyApiKey]);

  const filtered = useMemo(() => {
    const fyBounds = fyFilter != null ? getFyBoundaries(fyFilter, jurisdiction) : null;
    const base = filterRows(transactions, {
      showSpam,
      showNeedsPrice,
      showNeedsReview,
      assetFilter,
      typeFilter,
      flagFilter,
      walletFilter,
      fyBounds,
      instrumentFilter,
      query,
      isNeedsReview,
      isDerivative: isDerivativeTransaction,
      derivedFlagsById: derivedFlagsByTxId
    });

    // Source filter — applied after the shared row filter so the lib contract
    // (and its tests) stay untouched.
    const bySource = sourceFilter === 'all' ? base : base.filter((t) =>
      transactionMatchesSourceFilter(t, sourceFilter, sourcePresentations)
    );
    const byDurableScope = navigationScopeFilter == null ? bySource : bySource.filter((transaction) =>
      transactionMatchesNavigationScope(
        transaction,
        navigationScopeFilter,
        postingSnapshot.context,
        postingSnapshot.index.byTaxEventId
      )
    );

    return [...byDurableScope].sort((a, b) => {
      if (navigationTargetId != null && (a.id === navigationTargetId || b.id === navigationTargetId)) {
        return a.id === navigationTargetId ? -1 : 1;
      }
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
  }, [transactions, assetFilter, typeFilter, flagFilter, walletFilter, sourceFilter, sourcePresentations, fyFilter, jurisdiction, instrumentFilter, query, showNeedsPrice, showNeedsReview, showSpam, sortBy, navigationTargetId, navigationScopeFilter, postingSnapshot, derivedFlagsByTxId]);

  const { pageRows, totalPages, safePage } = useMemo(
    () => paginate(filtered, page, PAGE_SIZE),
    [filtered, page, PAGE_SIZE]
  );

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [assetFilter, typeFilter, flagFilter, walletFilter, sourceFilter, fyFilter, instrumentFilter, query, showNeedsPrice, showNeedsReview, showSpam, sortBy]);

  useEffect(() => {
    if (!pendingCounterpartFocus || !pageRows.some((transaction) => transaction.id === pendingCounterpartFocus)) return;
    const frame = window.requestAnimationFrame(() => {
      const escapedId = CSS.escape(pendingCounterpartFocus);
      const row = document.querySelector<HTMLElement>(`[data-transaction-id="${escapedId}"]`);
      row?.focus();
      row?.scrollIntoView?.({ block: 'center' });
      setPendingCounterpartFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pageRows, pendingCounterpartFocus, expandedId]);

  /** Date-grouped view only makes sense while the list is date-sorted. */
  const dateSorted = sortBy === 'date_desc' || sortBy === 'date_asc';
  const groups = useMemo(
    () => (dateSorted ? groupRowsByDate(pageRows) : [{ key: 'all', rows: pageRows }]),
    [pageRows, dateSorted]
  );

  const anyFilterActive =
    query !== '' ||
    assetFilter !== 'all' ||
    typeFilter !== 'all' ||
    flagFilter !== 'all' ||
    walletFilter !== 'all' ||
    sourceFilter !== 'all' ||
    fyFilter != null ||
    showNeedsPrice ||
    showNeedsReview ||
    showSpam ||
    instrumentFilter !== 'all' ||
    navigationScopeFilter != null;

  const clearFilters = () => {
    setQuery('');
    setAssetFilter('all');
    setTypeFilter('all');
    setFlagFilter('all');
    setWalletFilter('all');
    setSourceFilter('all');
    setNavigationScopeFilter(null);
    setFyFilter(null);
    setShowNeedsPrice(false);
    setShowNeedsReview(false);
    setShowSpam(false);
    setInstrumentFilter('all');
  };

  useEffect(() => {
    if (navigationResetToken == null) return;
    setNavigationScopeFilter(null);
    setNavigationTargetId(null);
  }, [navigationResetToken]);

  useEffect(() => {
    if (!navigationIntent || appliedNavigationIntent.current === navigationIntent.id || transactionsLive === undefined) return;
    appliedNavigationIntent.current = navigationIntent.id;
    setNavigationError(null);
    const target = resolveReviewTransactionTarget(navigationIntent, transactions);
    if (navigationIntent.transactionId && !target) {
      setNavigationTargetId(null);
      setNavigationError('That exact transaction no longer exists. The stale navigation request was cleared.');
      onNavigationIntentAcknowledged?.(navigationIntent.id);
      return;
    }
    setNavigationTargetId(target?.id ?? null);
    setQuery('');
    setAssetFilter('all');
    setSourceFilter('all');
    const navigationFilter = navigationIntent.filter ?? {};
    setNavigationScopeFilter(
      navigationIntent.focus === 'filters' && hasDurableNavigationScope(navigationFilter)
        ? navigationFilter
        : null
    );
    setTypeFilter('all'); setFlagFilter('all'); setWalletFilter('all'); setFyFilter(null);
    setShowNeedsPrice(navigationIntent.focus === 'filters' && navigationFilter.needsPrice === true);
    setShowNeedsReview(navigationIntent.focus === 'filters' && navigationFilter.needsReview === true);
    setShowSpam(false); setInstrumentFilter('all'); setSortBy('date_desc'); setPage(1);
    if (target) {
      setExpandedId(target.id);
      setDetailTabByTxId((current) => ({ ...current, [target.id]: navigationIntent.detailTab ?? 'details' }));
    }
    setPendingNavigationFocus(navigationIntent);
  }, [navigationIntent, onNavigationIntentAcknowledged, transactions, transactionsLive]);

  useEffect(() => {
    if (!pendingNavigationFocus) return;
    const frame = window.requestAnimationFrame(() => {
      const row = pendingNavigationFocus.transactionId
        ? Array.from(document.querySelectorAll<HTMLElement>('[data-transaction-id]'))
          .find((element) => element.dataset.transactionId === pendingNavigationFocus.transactionId)
        : undefined;
      const detail = row?.querySelector<HTMLElement>('[data-testid="tx-details"]');
      const filterTarget = document.querySelector<HTMLElement>('[aria-label="Search transactions"]');
      const focusTarget = pendingNavigationFocus.focus === 'filters' ? filterTarget
        : pendingNavigationFocus.focus === 'detail-panel' ? detail ?? row : row;
      focusTarget?.focus();
      focusTarget?.scrollIntoView?.({ block: 'center' });
      onNavigationIntentAcknowledged?.(pendingNavigationFocus.id);
      setPendingNavigationFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [expandedId, filtered, onNavigationIntentAcknowledged, pendingNavigationFocus]);

  // Shared pagination bar — rendered both above and below the list so long
  // ledgers can be paged from either end. Both instances read the same
  // page/safePage/totalPages state, so there is no duplicated pagination state.
  const renderPagination = (wrapperClassName: string, opts?: { utcNote?: boolean }) => {
    if (filtered.length <= PAGE_SIZE && !opts?.utcNote) return null;
    return (
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${wrapperClassName}`}>
        {filtered.length > PAGE_SIZE ? (
          <p className="text-xs tabular-figures text-low">
            Showing {(safePage - 1) * PAGE_SIZE + 1}–
            {Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length}
          </p>
        ) : (
          <p className="text-xs tabular-figures text-low">{filtered.length} transactions</p>
        )}
        {opts?.utcNote && <p className="text-xs text-low">· All date/times are in UTC</p>}
        {filtered.length > PAGE_SIZE && (
          <nav aria-label="Pagination" className="ml-auto flex items-center gap-1">
            <button
              type="button"
              aria-label="Previous page"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="grid h-10 w-10 place-items-center rounded-lg border border-hi/10 bg-elev-1 text-mid shadow-xs transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            {pageNumberList(safePage, totalPages).map((p, i) =>
              p === '…' ? (
                <span key={`gap-${i}`} className="px-1 text-xs text-faint" aria-hidden="true">…</span>
              ) : (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPage(p)}
                  aria-current={p === safePage ? 'page' : undefined}
                  className={cn(
                    'h-10 w-10 rounded-lg text-xs font-bold tabular-figures transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                    p === safePage
                      ? 'bg-primary-solid text-white shadow-sm'
                      : 'border border-hi/10 bg-elev-1 text-mid shadow-xs hover:border-primary/40 hover:text-primary'
                  )}
                >
                  {p}
                </button>
              )
            )}
            <button
              type="button"
              aria-label="Next page"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="grid h-10 w-10 place-items-center rounded-lg border border-hi/10 bg-elev-1 text-mid shadow-xs transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </nav>
        )}
      </div>
    );
  };

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

  // ---- Bulk "Set type" + "Set flags" ----

  const selectedTxs = useMemo(
    () => transactions.filter((t) => selected.has(t.id)),
    [transactions, selected]
  );
  const bulkCompatibleCategories = useMemo(() => {
    if (selectedTxs.length === 0) return [] as TransactionCategory[];
    return compatibleCategories(selectedTxs[0].type).filter((category) =>
      selectedTxs.every((transaction) => compatibleCategories(transaction.type).includes(category))
    );
  }, [selectedTxs]);
  const bulkPairManagedCount = useMemo(() => selectedTxs.filter((transaction) =>
    transaction.internalTransferPairId != null || transaction.internalTransferDecision != null || transaction.linkedTransferId != null
  ).length, [selectedTxs]);

  const applyBulkCategory = async () => {
    if (!pendingBulkCategory) return;
    const category = pendingBulkCategory;
    setApplyingBulk(true);
    try {
      await Promise.all(selectedTxs.map((transaction) =>
        db.transactions.update(transaction.id, bulkCategoryPatch(transaction, category))
      ));
      setSelected(new Set());
    } finally { setApplyingBulk(false); setPendingBulkCategory(null); }
  };

  const bulkTypeImpact = useMemo(
    () => (pendingBulkType ? summarizeBulkTypeChange(selectedTxs, pendingBulkType) : null),
    [selectedTxs, pendingBulkType]
  );

  const applyBulkType = async () => {
    if (!pendingBulkType || applyingBulk) return;
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

  const patchBulkFlagsSel = (patch: Partial<BulkFlagsSelection>) =>
    setBulkFlagsSel((cur) => (cur ? { ...cur, ...patch } : cur));

  const setBulkFlag = (flag: FlagReason, on: boolean) => {
    setBulkFlagsSel((cur) => {
      if (!cur) return cur;
      const flags = new Map(cur.flags);
      flags.set(flag, on);
      return { ...cur, flags };
    });
  };

  const applyBulkFlags = async () => {
    if (!bulkFlagsSel || applyingBulk) return;
    const sel = bulkFlagsSel;
    setApplyingBulk(true);
    try {
      await Promise.all(selectedTxs.map(async (t) => {
        const patch = bulkFlagsPatch(t, sel);
        const { isSpam: nextSpam, ...nonSafetyPatch } = patch;
        await db.transactions.update(t.id, nonSafetyPatch);
        if (nextSpam !== isTransactionExcluded(t)) {
          await setTransactionSafetyVisibility(t, !nextSpam);
        }
      }));
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
        displayFlags(t, derivedFlagsByTxId.get(t.id)).join('|'),
        t.isInternalTransfer ? 'yes' : 'no',
        isTransactionExcluded(t) ? 'yes' : 'no',
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
          transactions: filtered.map((t) => ({
            ...t,
            flags: displayFlags(t, derivedFlagsByTxId.get(t.id))
          }))
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
        displayFlags(t, derivedFlagsByTxId.get(t.id)).join(', ') || '—',
        t.sourceRef ? truncatePdfRef(t.sourceRef) : '—'
      ];
      })
    });
    doc.save('sololedger-review-transactions.pdf');
  };

  // ---------- Row rendering (date-grouped ledger, mockup frame 06) ----------

  /** One leg of the row-face flow (sent or received): asset / fiat / endpoint.
   *  Every leg is the same two-line skeleton — a fixed-height main line over a
   *  fixed-height sub-line (rendered even when empty) — so amounts and
   *  sub-lines baseline-align across legs and across rows. Amounts never
   *  truncate — they wrap under the row on narrow screens. */
  const renderLeg = (leg: RowLeg, spam: boolean, assetIdentity?: Pick<Transaction, 'chain' | 'contractAddress' | 'safetyState'>) => {
    // The sub-line: cost basis under the sent side of a disposal; fiat value
    // and the gain/loss together under the received side.
    const subRow = (
      <span className="mt-0.5 flex h-3.5 items-center gap-1.5 text-[11px] tabular-figures">
        {leg.subline && <span className="whitespace-nowrap text-low">{leg.subline}</span>}
        {leg.gain && (
          <span
            className={cn(
              'whitespace-nowrap font-bold',
              leg.gain.kind === 'gain' ? 'text-gain' : 'text-loss'
            )}
          >
            {leg.gain.kind === 'gain' ? '+' : '−'}
            {leg.gain.formatted}
          </span>
        )}
      </span>
    );
    if (leg.kind === 'endpoint') {
      return (
        <span className="flex min-w-0 max-w-[15rem] flex-col">
          <span className="flex h-6 items-center gap-1.5">
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-hi/10 bg-elev-3 text-low"
              aria-hidden="true"
            >
              <Wallet className="h-3 w-3" />
            </span>
            <span
              className={cn('truncate text-[0.8125rem] font-semibold', leg.isName ? 'text-hi' : 'font-mono text-mid')}
              title={leg.title}
            >
              {leg.label}
            </span>
          </span>
          {subRow}
        </span>
      );
    }
    if (leg.kind === 'fiat') {
      return (
        <span className="flex min-w-0 max-w-[15rem] flex-col">
          <span className="flex h-6 items-center gap-1.5">
            <span
              className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-elev-3 text-[10px] font-extrabold text-low"
              aria-hidden="true"
            >
              <Banknote className="h-3.5 w-3.5" />
            </span>
            <span className={cn('whitespace-nowrap text-[0.875rem] font-bold tabular-figures text-hi', spam && 'line-through')}>
              {leg.amount != null && leg.currency ? formatCurrency(leg.amount, leg.currency) : '—'}
            </span>
          </span>
          {subRow}
        </span>
      );
    }
    return (
      <span className="flex min-w-0 max-w-[15rem] flex-col">
        <span className="flex h-6 items-center gap-1.5">
          <AssetIcon
            symbol={leg.symbol}
            chain={assetIdentity?.chain}
            contractAddress={assetIdentity?.contractAddress}
            safetyState={assetIdentity?.safetyState}
            size={22}
          />
          <span
            className={cn(
              'whitespace-nowrap text-[0.875rem] font-bold tabular-figures',
              leg.sign === '+' ? 'text-gain' : 'text-hi',
              spam && 'line-through'
            )}
          >
            {leg.sign}
            {leg.amount != null ? formatCompactAmount(leg.amount) : '—'}
          </span>
          <span className="truncate text-xs font-semibold text-mid">{leg.symbol}</span>
        </span>
        {subRow}
      </span>
    );
  };

  const renderRow = (t: Transaction, idx: number) => {
    const { fromAddr, toAddr } = txFromToAddresses(t);
    const chainLabel = t.chain ? CHAINS.find((c) => c.id === t.chain)?.label ?? t.chain : null;
    const assetLabel = resolveAssetLabel(t.asset, t.contractAddress, t.chain);
    const counterLabel = t.counterAsset ? resolveAssetLabel(t.counterAsset, undefined, t.chain) : null;
    const sourcePresentation = sourcePresentations.get(t.id)!;
    const src = { label: sourcePresentation.primaryLabel, id: sourcePresentation.iconId ?? undefined };
    const disposal = disposalByTxId.get(t.id);
    const isEditing = editingFiat === t.id;
    const expanded = expandedId === t.id;
    const needsPrice = t.fiatValue == null && !isTransactionExcluded(t) && !t.isInternalTransfer && requiresMarketValue(t);
    const derivedFlags = derivedFlagsByTxId.get(t.id) ?? [];
    const missingCostBasis = derivedFlags.includes('missing_cost_basis');
    const invalidTransactionData = derivedFlags.includes('invalid_transaction_data');
    const hash = reviewTransactionHash(t);
    // explorerTxUrl is chain-aware and enforces hash shape, so a non-null
    // result is always safe to link.
    const hashUrl = hash ? explorerTxUrl(t.chain, hash) : null;
    const isSelected = selected.has(t.id);
    const timeUtc = new Date(t.timestamp).toISOString().slice(11, 16);
    const dateUtc = formatGroupDateLabel(new Date(t.timestamp).toISOString().slice(0, 10));
    const spam = isTransactionExcluded(t);
    const resolveWallet = (addr: string) => walletLabelFor(walletLabels, t, addr);
    // Cost basis / gain only surface once the disposal is priced.
    const pricedDisposal = disposal && t.fiatValue != null ? disposal : null;
    const flow = txFlow(t, { assetLabel, counterLabel, fromAddr, toAddr, resolveWallet, disposal: pricedDisposal });
    const summary = buildTxSummary(t, {
      assetLabel,
      counterLabel,
      sourceLabel: src.label,
      typeLabel: reviewTypeLabel(t),
      resolveWallet,
      fromAddr,
      toAddr,
      disposal: pricedDisposal
    });
    const ownSide = OWN_ACCOUNT_SIDE[t.type];
    // Exchange rows carry an order/trade id in sourceRef; modern on-chain rows use txHash.
    const hashFactLabel = t.txHash || t.chain || t.source.startsWith('rpc:') ? 'Tx hash' : 'Order ID';
    const scope = resolveAccountScope(t, postingSnapshot.context);
    const scopeKey = `${scope.accountScopeId}\u001f${scope.accountClass}`;
    const eventPostings = postingSnapshot.index.byTaxEventId.get(t.id) ?? [];
    const selectedAuthority = authorityByScope.get(scopeKey);
    const principalPosting = eventPostings.find((posting) => posting.role === 'principal');
    const selectedCoverage = coverageByScope.get(scopeKey);
    const reconciliationCoverage = authorityCoverageByScope.get(scopeKey) ?? selectedCoverage;
    const reconciliation = expanded && principalPosting && selectedAuthority ? reconcileDerivedPostings({
      scopeId: scope.accountScopeId,
      accountClass: scope.accountClass,
      assetKey: principalPosting.assetKey,
      asset: principalPosting.asset,
      postings: postingSnapshot.postings,
      authority: selectedAuthority,
      coverage: {
        status: reconciliationCoverage?.status ?? 'unknown',
        provenHistoryStart: reconciliationCoverage?.observedHistoryStart,
        authorityAsOf: selectedAuthority.selectedSnapshot?.asOf
      },
      scopeStatus: scope.scopeStatus
    }) : undefined;
    const unexplainedAuthorityQuantity = reconciliation?.balanceStatus !== 'not_compared'
      ? reconciliation?.delta : undefined;
    const canEditSpecificId = supportsSpecificIdEditing(t.type, settings?.defaultCostBasisMethod ?? 'FIFO');
    const candidates = engineResult?.disposalCandidates[t.id] ?? [];
    const costAnalysis = expanded ? buildTransactionCostAnalysisModel({
      transaction: t,
      settings: settings ?? {
        jurisdiction, reportingCurrency: t.fiatCurrency,
        defaultCostBasisMethod: 'FIFO', priceApiEnabled: false, rpcLookupEnabled: false
      },
      disposal, indexes: costAnalysisIndexes, unexplainedAuthorityQuantity
    }) : null;
    const taxPolicy = expanded ? resolveTaxPolicy({
      kind: 'transaction', transaction: t,
      settings: settings ?? {
        jurisdiction, reportingCurrency: t.fiatCurrency,
        defaultCostBasisMethod: 'FIFO', priceApiEnabled: false, rpcLookupEnabled: false
      }
    }) : null;
    const linkedCounterpart = linkedCounterpartFor(t, transactionsById);
    const openLinkedCounterpart = () => {
      if (!linkedCounterpart) return;
      const counterpartIsSpam = isTransactionExcluded(linkedCounterpart);
      const counterpartOrder = transactions
        .filter((transaction) => isTransactionExcluded(transaction) === counterpartIsSpam)
        .sort((left, right) => right.timestamp - left.timestamp);
      const targetPage = transactionPage(counterpartOrder, linkedCounterpart.id, PAGE_SIZE) ?? 1;
      setQuery('');
      setAssetFilter('all');
      setTypeFilter('all');
      setFlagFilter('all');
      setWalletFilter('all');
      setSourceFilter('all');
      setNavigationScopeFilter(null);
      setNavigationTargetId(null);
      setFyFilter(null);
      setShowNeedsPrice(false);
      setShowNeedsReview(false);
      setShowSpam(counterpartIsSpam);
      setInstrumentFilter('all');
      setSortBy('date_desc');
      setExpandedId(linkedCounterpart.id);
      setPendingCounterpartFocus(linkedCounterpart.id);
      window.requestAnimationFrame(() => setPage(targetPage));
    };

    /** From/To fact value: the wallet NAME beats the raw address wherever
     * Connections knows it; the source brand stands in for the user's own
     * account side when no address was recorded. */
    const endpointFact = (addr: string | undefined, isOwnSide: boolean) => {
      if (addr) {
        const name = walletLabelFor(walletLabels, t, addr);
        return (
          <>
            {name && (
              <span
                className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border border-hi/10 bg-elev-3 text-low"
                aria-hidden="true"
              >
                <Wallet className="h-2.5 w-2.5" />
              </span>
            )}
            <span className={cn('min-w-0 truncate', name ? 'text-hi' : 'font-mono text-[11px]')} title={addr}>
              {name ?? truncateAddress(addr)}
            </span>
            <CopyButton text={addr} label="Copy address" />
          </>
        );
      }
      if (isOwnSide) {
        return (
          <>
            <SourceIcon iconId={sourcePresentation.iconId} label={sourcePresentation.primaryLabel} size={18} />
            {src.label}
          </>
        );
      }
      return '—';
    };
    return (
      <div key={t.id} className={cn(idx > 0 && 'border-t border-hi/10')} data-transaction-id={t.id} tabIndex={-1}>
        <div
          onClick={() => setExpandedId((cur) => (cur === t.id ? null : t.id))}
          className={cn(
            'flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3.5 transition-colors hover:bg-elev-3/40 sm:px-5',
            // Desktop: one continuous compact line on aligned column tracks —
            // select · type (8.5rem) · flexible flow (content capped below) ·
            // source + chevron (13.5rem, right-aligned). The minmax track lets
            // source, flags and chevrons line up without changing mobile flow.
            'lg:grid lg:grid-cols-[auto_8.5rem_minmax(0,1fr)_auto] lg:gap-x-6 xl:gap-x-8',
            isSelected && 'bg-primary/[0.05] hover:bg-primary/[0.08]',
            spam && 'opacity-60'
          )}
        >
          {/* Bulk select */}
          <label
            className="grid h-11 w-7 shrink-0 cursor-pointer place-items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggle(t.id)}
              aria-label="Select transaction"
              className="h-[18px] w-[18px] rounded accent-primary"
            />
          </label>

          {/* Type label + time + chain — fixed track, so every row's flow
              column starts at the same x (single-leg rows don't jump). */}
          <div className="min-w-0">
            <span className={cn(spam && 'line-through')}>
              <TypeSelector tx={t} />
              <CategorySelector tx={t} />
            </span>
            <p className="mt-0.5 whitespace-nowrap pl-1 text-[11px] text-low">
              {timeUtc}
              {chainLabel ? ` · ${chainLabel}` : ''}
            </p>
          </div>

          {/* The flow — sent leg → received leg. Content-sized, never
              stretched: legs cap at 15rem each (full-width row on mobile). */}
          <div
            className="order-4 flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 lg:order-none lg:w-auto lg:max-w-[34rem]"
            data-testid="tx-flow"
          >
            {flow.sent && renderLeg(flow.sent, spam, principalAssetIdentityForLeg(flow.sent, t))}
            {flow.sent && flow.received && (
              <ArrowRight className="h-4 w-4 shrink-0 text-faint" aria-hidden="true" />
            )}
            {flow.received && renderLeg(flow.received, spam, principalAssetIdentityForLeg(flow.received, t))}
          </div>

          {/* Source context + expander — one unit on mobile (wraps together,
              never an orphaned chevron); on desktop the source is a fixed
              13.5rem right-aligned block (logo + name, fee chip, flag badges —
              badges wrap under, still right-aligned) with the chevron after. */}
          <div className="order-3 ml-auto flex shrink-0 items-center gap-2.5 lg:order-none lg:ml-0 lg:justify-end">
            <div className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-1 lg:w-[13.5rem]">
              <SourceIcon iconId={sourcePresentation.iconId} label={sourcePresentation.primaryLabel} size={30} />
              <div className="min-w-0 lg:text-right">
                <p className="max-w-[7rem] truncate text-xs font-bold text-hi sm:max-w-[9rem]" title={src.label}>
                  {src.label}
                </p>
                <p className="max-w-[9rem] truncate text-[10px] text-low" title={sourcePresentation.subtitle}>
                  {sourcePresentation.subtitle}
                </p>
                {(sourcePresentation.status !== 'resolved' || t.category || t.internalTransferDecision) && (
                  <p className="max-w-[11rem] truncate text-[10px] font-semibold text-low" title={[
                    sourcePresentation.status !== 'resolved' ? `${sourcePresentation.status} source` : null,
                    t.category ? `Classification: ${t.category.replace(/_/g, ' ')}` : null,
                    t.internalTransferDecision ? `Internal transfer ${t.internalTransferDecision}` : null
                  ].filter(Boolean).join(' · ')}>
                    {[
                      sourcePresentation.status !== 'resolved' ? sourcePresentation.status : null,
                      t.category?.replace(/_/g, ' '),
                      t.internalTransferDecision ? `internal ${t.internalTransferDecision}` : null
                    ].filter(Boolean).join(' · ')}
                  </p>
                )}
                {t.feeAmount != null && t.feeAsset && (
                  <span className="mt-0.5 hidden max-w-full items-center rounded-full border border-hi/10 bg-elev-3/50 px-2 py-px text-[10px] font-bold tabular-figures text-low sm:inline-flex">
                    fee {formatCompactAmount(t.feeAmount)} {t.feeAsset}
                  </span>
                )}
              </div>
              <div className="hidden lg:block">
                <FlagSelector tx={t} derivedFlags={derivedFlags} />
              </div>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpandedId((cur) => (cur === t.id ? null : t.id));
              }}
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse transaction details' : 'Expand transaction details'}
              className={cn(
                'grid h-11 w-11 shrink-0 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                expanded ? 'bg-elev-3 text-primary' : 'text-low hover:bg-elev-3 hover:text-hi'
              )}
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
          </div>

          {/* Flags (narrow screens — under the flow, full width) */}
          <div className="order-5 w-full pl-10 lg:hidden">
            <FlagSelector tx={t} derivedFlags={derivedFlags} />
          </div>
        </div>

        {/* Inline warning strip — missing market price (mockup frame 06) */}
        {needsPrice && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-warn/20 bg-warn/10 px-5 py-2 text-xs font-semibold text-mid sm:pl-[4.5rem]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
            <span>
              No market price found for <span className="font-bold text-hi">{assetLabel}</span> on{' '}
              {formatGroupDateLabel(new Date(t.timestamp).toISOString().slice(0, 10))} — value stays unset until priced.
            </span>
            <button
              type="button"
              onClick={() => startEditFiat(t.id, t.fiatValue)}
              className="rounded font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              Add market value
            </button>
          </div>
        )}

        {missingCostBasis && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-warn/20 bg-warn/10 px-5 py-2 text-xs font-semibold text-mid sm:pl-[4.5rem]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
            <span>
              Acquisition history is missing for part or all of this disposal. Import the source account&rsquo;s earlier acquisition history; no basis was inferred from this transaction&rsquo;s market value.
            </span>
            <button
              type="button"
              onClick={() => {
                setExpandedId(t.id);
                setDetailTabByTxId((current) => ({ ...current, [t.id]: 'cost' }));
                window.requestAnimationFrame(() => {
                  const row = Array.from(document.querySelectorAll<HTMLElement>('[data-transaction-id]'))
                    .find((element) => element.dataset.transactionId === t.id);
                  const costTab = row?.querySelector<HTMLButtonElement>('[role="tab"][aria-controls="transaction-panel-cost"]');
                  costTab?.focus();
                  costTab?.scrollIntoView?.({ block: 'center' });
                });
              }}
              className="rounded font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              Review Cost Analysis
            </button>
          </div>
        )}

        {invalidTransactionData && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-warn/20 bg-warn/10 px-5 py-2 text-xs font-semibold text-mid sm:pl-[4.5rem]">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warn" aria-hidden="true" />
            <span>
              This transaction has an invalid or incomplete amount. Correct this row&apos;s quantity or trade counter-leg details; importing older acquisition history will not repair it.
            </span>
          </div>
        )}

        {/* Expanded Details panel — plain-English summary, facts grid, lots */}
        {expanded && (
          <TransactionDetailPanel
            scope={scope}
            coverage={selectedCoverage}
            authorityGeneration={selectedAuthority?.selectedSnapshot?.generation}
            postings={eventPostings}
            runningBalances={postingSnapshot.index.runningBalanceByPostingId}
            costAnalysis={costAnalysis!}
            transaction={t}
            presentation={sourcePresentation}
            taxPolicy={taxPolicy!}
            activeTab={detailTabByTxId[t.id] ?? 'details'}
            onActiveTabChange={(activeTab) => setDetailTabByTxId((current) => ({ ...current, [t.id]: activeTab }))}
            details={<>
            <p className="text-[0.875rem] leading-relaxed text-mid" data-testid="tx-summary">
              {summary.lead}
              {summary.tail ? (
                <>
                  {' — a '}
                  <span className={cn('font-bold', summary.tail.kind === 'gain' ? 'text-gain' : 'text-loss')}>
                    {summary.tail.kind} of {summary.tail.formatted}
                  </span>
                  .
                </>
              ) : (
                '.'
              )}
            </p>

            {/* Facts grid */}
            <div className="mt-4 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
              <DetailRow label="Date">
                {dateUtc} · {timeUtc} UTC
              </DetailRow>
              <DetailRow label={hashFactLabel}>
                {hash ? (
                  <>
                    <span className="rounded-md border border-hi/10 bg-elev-3/60 px-2 py-0.5 font-mono text-[11px]" title={hash}>
                      {truncateAddress(hash)}
                    </span>
                    <CopyButton text={hash} label={`Copy ${hashFactLabel === 'Tx hash' ? 'transaction hash' : 'order id'}`} />
                    {hashUrl && (
                      <a
                        href={hashUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      >
                        Explorer ↗
                      </a>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </DetailRow>
              <DetailRow label="Source">
                <SourceIcon iconId={sourcePresentation.iconId} label={sourcePresentation.primaryLabel} size={18} />
                {sourcePresentation.primaryLabel} · {sourcePresentation.subtitle}
              </DetailRow>
              <DetailRow label="From">{endpointFact(fromAddr, ownSide === 'from' || ownSide === 'both')}</DetailRow>
              <DetailRow label="To">{endpointFact(toAddr, ownSide === 'to' || ownSide === 'both')}</DetailRow>
              <DetailRow label="Value">
                {isEditing ? (
                  <span className="flex items-center gap-1">
                    <input
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      inputMode="decimal"
                      className="h-9 w-28 rounded-md border border-primary/60 bg-elev-1 px-2 text-right text-xs tabular-figures text-hi focus:outline-none focus:ring-2 focus-visible:ring-primary/30"
                      placeholder="0.00"
                    aria-label="Total transaction market value"
                    />
                    <button
                      onClick={() => saveFiat(t)}
                      className="grid h-9 w-9 place-items-center rounded-md text-gain transition-colors hover:bg-gain/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      aria-label="Save"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setEditingFiat(null)}
                      className="grid h-9 w-9 place-items-center rounded-md text-low transition-colors hover:bg-elev-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                      aria-label="Cancel"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => startEditFiat(t.id, t.fiatValue)}
                    className="group inline-flex items-center gap-1 rounded text-xs tabular-figures text-mid transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                    title="Click to enter the total transaction market value manually"
                  >
                    {t.fiatValue != null ? `≈ ${formatCurrency(t.fiatValue, t.fiatCurrency)}` : 'Add market value'}
                    <Pencil className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-70" />
                  </button>
                )}
              </DetailRow>
              {t.feeAmount != null && t.feeAsset && (
                <DetailRow label="Fee">
                  {formatCompactAmount(t.feeAmount)} {t.feeAsset}
                </DetailRow>
              )}
              {pricedDisposal && (
                <DetailRow label="Cost basis">
                  {costAnalysis?.matchedRows.some((row) => row.status === 'missing_cost_basis') ? '—' : formatCurrency(pricedDisposal.costBasis, t.fiatCurrency)}
                </DetailRow>
              )}
              {pricedDisposal && (
                <DetailRow label="Gain">
                  <span
                    className={cn(
                      'whitespace-nowrap font-bold tabular-figures',
                      pricedDisposal.gain >= 0 ? 'text-gain' : 'text-loss'
                    )}
                  >
                    {`${pricedDisposal.gain >= 0 ? '+' : '−'}${formatCurrency(Math.abs(pricedDisposal.gain), t.fiatCurrency)}`}
                  </span>
                </DetailRow>
              )}
              {t.notes && <DetailRow label="Notes">{t.notes}</DetailRow>}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {pricedDisposal && <Badge tone="primary">Cost basis · {pricedDisposal.method}</Badge>}
              {t.isInternalTransfer && <Badge tone="neutral">Internal · not taxable</Badge>}
              {t.internalTransferDecision === 'suggested' && <Badge tone="neutral">Internal transfer suggested</Badge>}
              {t.internalTransferDecision === 'confirmed' && <Badge tone="neutral">Internal transfer confirmed</Badge>}
              {t.category && <Badge tone="neutral">Classification · {t.category.replace(/_/g, ' ')}</Badge>}
              {t.categoryOrigin === 'suggestion' && <Badge tone="neutral">Classification suggested</Badge>}
              {linkedCounterpart && (
                <button
                  type="button"
                  onClick={openLinkedCounterpart}
                  className="inline-flex min-h-[44px] items-center rounded-lg px-2 text-xs font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  Open linked counterpart
                </button>
              )}
              {canEditSpecificId && (
                <button
                  type="button"
                  className="rounded text-xs font-bold text-primary underline decoration-dotted hover:text-primary-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                  onClick={() => setOpenLotPicker((current) => current === t.id ? null : t.id)}
                >
                  {openLotPicker === t.id ? 'Hide lot picker' : 'Match lots (Specific ID)'}
                </button>
              )}
            </div>
            {openLotPicker === t.id && (
              <div className="mt-4" data-testid="details-lot-picker">
                <LotPicker txId={t.id} candidates={candidates} currentHint={hints[t.id]} currency={t.fiatCurrency} onSaved={() => setOpenLotPicker(null)} />
              </div>
            )}
            </>}
          />
        )}
      </div>
    );
  };

  if (navigationError) {
    return (
      <div className="space-y-5">
        {onNavigationBack && <Button variant="secondary" size="sm" onClick={onNavigationBack}><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Data Health</Button>}
        <h2 className="page-title">Transactions</h2>
        <div role="alert" className="rounded-xl border border-warn/30 bg-warn/10 px-4 py-4 text-sm text-warn">{navigationError}</div>
      </div>
    );
  }

  if (navigationIntent?.transactionId && transactionsLive === undefined) {
    return (
      <div className="space-y-5" aria-busy="true">
        {onNavigationBack && <Button variant="secondary" size="sm" onClick={onNavigationBack}><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Data Health</Button>}
        <h2 className="page-title">Transactions</h2>
        <div role="status" className="rounded-xl border border-hi/10 bg-elev-2 px-4 py-4 text-sm text-mid">Locating the exact transaction…</div>
      </div>
    );
  }

  if (transactions.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="page-title">Transactions</h2>
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
    <div className={`space-y-5 ${selected.size > 0 ? 'pb-64 lg:pb-28' : 'pb-28'}`}>
      {/* Page head — mockup frame 06: title + count pill + on-device footnote.
          The pill counts the default (non-spam) view; spam rows are reachable
          via the Spam chip and counted there. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {onNavigationBack && <Button variant="secondary" size="sm" onClick={onNavigationBack}><ArrowLeft className="h-4 w-4" aria-hidden="true" /> Data Health</Button>}
        <h2 className="page-title">Transactions</h2>
        <span className="inline-flex h-[26px] items-center rounded-full border border-hi/10 bg-elev-3 px-2.5 text-xs font-bold tabular-figures text-mid">
          {(transactions.length - spamTxCount).toLocaleString('en-IN')}
        </span>
        <p className="text-sm text-low">Review, label &amp; reconcile — all on-device.</p>
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-low xl:inline">Export: CSV/JSON recommended for detailed CA review</span>
          <Button variant="secondary" size="sm" onClick={exportFilteredCsv}>CSV</Button>
          <Button variant="secondary" size="sm" onClick={exportFilteredJson}>JSON</Button>
          <Button variant="secondary" size="sm" onClick={() => setPdfConfirmOpen(true)}>PDF</Button>
        </div>
      </div>
      {/* Token-name resolution — local/BYOK only; hosted resolves automatically. */}
      {showTokenResolveBanner(hosted, unresolvedSymbolTxs.length) && (
        <div className="flex flex-col gap-3 rounded-xl border border-hi/10 bg-elev-2 px-5 py-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-hi">
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

      {/* DCA / Recurring order banner — local/BYOK only; hosted classifies automatically. */}
      {showDcaBanner(hosted, dcaGroups.length) && (
        <div className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-hi">
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
              Recommended approach: mark the deposit as internal (non-taxable escrow), classify each fill as a buy.
              Fetch prices after classifying.
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={applyingDca}
            onClick={async () => {
              setApplyingDca(true);
              setDcaMsg(null);
              try {
                const r = await applyDcaClassification(
                  dcaGroups,
                  settings?.alchemyApiKey ?? (isSaasMode() ? SAAS_PROXY_KEY : undefined)
                );
                if (r.applied > 0) {
                  setDcaMsg(
                    `Classified ${r.applied} recurring order${r.applied === 1 ? '' : 's'} — ` +
                      `deposit${r.applied === 1 ? '' : 's'} marked non-taxable, fills became trades.` +
                      (r.estimated > 0
                        ? ` ${r.estimated} fill${r.estimated === 1 ? '' : 's'} use estimated amounts — flagged needs review.`
                        : '')
                  );
                } else if (r.skipReasons.length > 0) {
                  setDcaMsg(r.skipReasons.join(' '));
                }
              } catch {
                setDcaMsg('Classification failed — please try again in a moment.');
              } finally {
                setApplyingDca(false);
              }
            }}
            className="shrink-0 border-primary/40 text-primary"
          >
            {applyingDca ? 'Classifying…' : 'Classify DCA fills'}
          </Button>
        </div>
      )}

      {dcaMsg && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-mid">
          {dcaMsg}
        </div>
      )}

      {potentialSwapPairs > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-primary/40 bg-primary/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-hi">
              {potentialSwapPairs} possible DEX swap{potentialSwapPairs === 1 ? '' : 's'} waiting to be merged
            </p>
            <p className="text-xs text-low">
              Wallet imports show as transfer_in/out until merged into trades. Swaps are detected automatically
              and prices are fetched automatically — Capital Gains will show matched buy/sell rows.
            </p>
          </div>
        </div>
      )}

      {/* DefiLlama reward-income suggestions — local/BYOK only; hosted auto-runs. */}
      {showLlamaBanner(hosted, solanaTransferInCount) && (
        <div className="flex flex-col gap-3 rounded-xl border border-hi/10 bg-elev-2 px-5 py-4 shadow-xs sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-hi">
                {solanaTransferInCount} unclassified Solana transfer{solanaTransferInCount === 1 ? '' : 's'}-in
              </p>
              <p className="mt-1 text-xs text-low">
                Check them against DefiLlama&rsquo;s reward-token data (free, no API key). Matches become
                income flagged <span className="text-warn">needs review</span> so you can confirm each one.
                {llamaBannerHint(priceLookupEnabled === true)}
              </p>
            </div>
          </div>
          <Button
            variant="secondary"
            disabled={llamaSuggesting}
            onClick={() => void suggestRewardIncome()}
            className="shrink-0"
          >
            {llamaSuggesting ? 'Checking DefiLlama…' : 'Suggest reward income (DefiLlama)'}
          </Button>
        </div>
      )}

      {/* Result line: in hosted mode only shown when rows were actually flagged,
          so the user can tell why transactions entered the Needs-review queue. */}
      {showLlamaResultMessage(hosted, llamaMsg, llamaSuggested) && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${llamaMsg!.startsWith('DefiLlama:') ? 'border-primary/30 bg-primary/10 text-gain' : 'border-loss/30 bg-loss/10 text-loss'}`}>
          {llamaMsg}
        </div>
      )}

      {missingPriceTxs.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-warn/30 bg-warn/15 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-warn/20 text-warn">
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-hi">{needsPriceLine(missingPriceTxs.length)}</p>
              <p className="text-xs text-low">
                {hosted
                  ? 'Automatic historical pricing was attempted. Retry any market values that are still missing; pricing does not create acquisition history or repair cost basis.'
                  : priceLookupEnabled
                  ? rpcTransferCount > 0
                    ? 'Wallet imports are included — click the button to fetch historical prices. Swaps auto-detected as trades will feed cost basis after prices are filled.'
                    : 'Automatic historical-price lookup is enabled; use the button to retry anything still missing.'
                  : 'Turn on "Live price lookup" in Settings, or open any row below and type the value in yourself.'}
              </p>
            </div>
          </div>
          {priceLookupEnabled && (
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
      {hosted && missingCostBasisTxIds.size > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-warn/30 bg-warn/15 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-hi">{missingCostBasisTxIds.size} transactions are missing cost basis</p>
            <p className="mt-1 text-xs text-low">
              Import the source account&rsquo;s acquisition history from before these disposals, or add the acquisition cost manually in the source history. A transaction market value is not a replacement for lot basis.
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              setFlagFilter('missing_cost_basis');
              setShowNeedsPrice(false);
              setShowNeedsReview(false);
              setShowSpam(false);
            }}
            className="shrink-0"
          >
            Missing cost basis
          </Button>
        </div>
      )}
      {priceErrors.length > 0 && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${priceErrors[0]?.startsWith('Finished') ? 'border-primary/30 bg-primary/10 text-gain' : 'border-loss/30 bg-loss/10 text-loss'}`}>
          {priceErrors.slice(0, 5).join(' · ')}
          {priceErrors.length > 5 ? ` · +${priceErrors.length - 5} more` : ''}
        </div>
      )}

      {swapDetectMsg && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs text-gain">
          {swapDetectMsg}
        </div>
      )}

      {/* Filter bar — one baseline of pill chips (mockup frame 06) */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden="true" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search transactions…"
            aria-label="Search transactions"
            className="h-11 w-52 rounded-full border border-hi/10 bg-elev-1 pl-10 pr-4 text-sm text-hi shadow-xs transition-colors placeholder:text-faint hover:border-hi/20 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        {/* Source filter — with the brand mark of the active source */}
        <ChipSelect
          value={sourceFilter}
          onChange={setSourceFilter}
          ariaLabel="Source filter"
          active={sourceFilter !== 'all'}
          icon={
            sourceFilter === 'all' ? (
              <Link2 className="h-3.5 w-3.5" />
            ) : (
              <SourceIcon
                iconId={availableSources.find((source) => source.key === sourceFilter)?.iconId}
                label={availableSources.find((source) => source.key === sourceFilter)?.label ?? 'Source'}
                size={18}
              />
            )
          }
        >
          <option value="all">All sources</option>
          {availableSources.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </ChipSelect>

        {/* Asset filter */}
        <ChipSelect value={assetFilter} onChange={setAssetFilter} ariaLabel="Asset filter" active={assetFilter !== 'all'}>
          <option value="all">All assets</option>
          {assets.map((a) => (<option key={a} value={a}>{a}</option>))}
        </ChipSelect>

        {/* Type filter */}
        <ChipSelect value={typeFilter} onChange={(v) => setTypeFilter(v as TxType | 'all')} ariaLabel="Type filter" active={typeFilter !== 'all'}>
          <option value="all">All types</option>
          {ALL_TYPES.map((t) => (
            <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
          ))}
        </ChipSelect>

        {/* Flags filter */}
        <div className="relative">
          <Flag className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
          <select
            value={flagFilter}
            onChange={(e) => setFlagFilter(e.target.value as FlagReason | 'all' | 'spam' | 'internal')}
            aria-label="Flags filter"
            className={cn(
              'h-11 appearance-none rounded-full border bg-elev-1 pl-9 pr-8 text-[0.8125rem] font-semibold shadow-xs transition-colors',
              'hover:border-hi/20 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30',
              flagFilter !== 'all' ? 'border-primary/50 bg-primary/[0.06] text-primary' : 'border-hi/10 text-mid'
            )}
          >
            <option value="all">All flags</option>
            {ALL_FLAGS.map((f) => (
              <option key={f} value={f}>{FLAG_LABELS[f]}</option>
            ))}
            <option value="spam">Spam</option>
            <option value="internal">Internal</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
        </div>

        {/* Wallet filter */}
        {availableWallets.length > 1 && (
          <ChipSelect value={walletFilter} onChange={setWalletFilter} ariaLabel="Wallet filter" active={walletFilter !== 'all'} className="max-w-[180px]">
            <option value="all">All wallets</option>
            {availableWallets.map((wallet) => (
              <option key={wallet.key} value={wallet.key}>
                {walletLabels.get(wallet.key) ?? `${wallet.address.slice(0, 8)}…`}
              </option>
            ))}
          </ChipSelect>
        )}

        {/* FY filter */}
        <ChipSelect
          value={fyFilter == null ? '' : String(fyFilter)}
          onChange={(v) => setFyFilter(v ? Number(v) : null)}
          ariaLabel="Financial year filter"
          active={fyFilter != null}
        >
          <option value="">All periods</option>
          {availableFys.map((fy) => (
            <option key={fy} value={fy}>{getFyLabel(fy, jurisdiction)}</option>
          ))}
        </ChipSelect>

        {/* Quick-filter toggles (the mockup's "Warnings" vocabulary) */}
        <button
          type="button"
          aria-pressed={showNeedsPrice}
          onClick={() => { setShowNeedsPrice((v) => !v); setShowSpam(false); setShowNeedsReview(false); }}
          className={cn(
            'h-11 rounded-full border px-4 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
            showNeedsPrice ? 'border-warn/40 bg-warn/15 text-warn' : 'border-hi/10 bg-elev-1 text-low shadow-xs hover:text-mid'
          )}
        >
          {showNeedsPrice ? `Needs price (${missingPriceTxs.length}) ✕` : `Needs price: ${missingPriceTxs.length}`}
        </button>
        {needsReviewCount > 0 && (
          <button
            type="button"
            aria-pressed={showNeedsReview}
            onClick={() => { setShowNeedsReview((v) => !v); setShowSpam(false); setShowNeedsPrice(false); }}
            className={cn(
              'h-11 rounded-full border px-4 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
              showNeedsReview ? 'border-warn/40 bg-warn/15 text-warn' : 'border-hi/10 bg-elev-1 text-low shadow-xs hover:text-mid'
            )}
          >
            {showNeedsReview ? `Needs review (${needsReviewCount}) ✕` : `Needs review: ${needsReviewCount}`}
          </button>
        )}
        {spamTxCount > 0 && (
          <button
            type="button"
            aria-pressed={showSpam}
            onClick={() => { setShowSpam((v) => !v); setShowNeedsPrice(false); setShowNeedsReview(false); }}
            className={cn(
              'h-11 rounded-full border px-4 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
              showSpam ? 'border-loss/40 bg-loss/15 text-loss' : 'border-hi/10 bg-elev-1 text-low shadow-xs hover:text-mid'
            )}
          >
            {showSpam ? `Spam (${spamTxCount}) ✕` : `Spam (${spamTxCount})`}
          </button>
        )}

        {navigationScopeFilter && (
          <button
            type="button"
            aria-label={`Remove exact navigation scope ${navigationScopeFilter.accountClass ?? 'any class'} ${navigationScopeFilter.scopeId ?? ''}`.trim()}
            onClick={() => setNavigationScopeFilter(null)}
            className="flex min-h-[44px] items-center rounded-full border border-primary/30 bg-primary/10 px-4 text-xs font-bold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            Exact scope · {navigationScopeFilter.accountClass ?? 'any class'} · {navigationScopeFilter.scopeId ?? 'source'} · Remove
          </button>
        )}

        {anyFilterActive && (
          <button
            type="button"
            onClick={clearFilters}
            className="rounded px-1 text-xs font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            Clear filters
          </button>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Instrument segmented control */}
          <div className="flex rounded-full border border-hi/10 bg-elev-1 p-1 text-xs shadow-xs" role="group" aria-label="Instrument filter">
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
                aria-pressed={instrumentFilter === id}
                onClick={() => setInstrumentFilter(id)}
                className={cn(
                  'min-h-[36px] rounded-full px-3.5 font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                  instrumentFilter === id ? 'bg-primary-solid text-white shadow-sm' : 'text-low hover:text-mid'
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Sort selector */}
          <div className="relative">
            <ArrowUpDown className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              aria-label="Sort transactions"
              className="h-11 appearance-none rounded-full border border-hi/10 bg-elev-1 pl-9 pr-8 text-[0.8125rem] font-semibold text-mid shadow-xs transition-colors hover:border-hi/20 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="date_desc">Date ↓ (newest)</option>
              <option value="date_asc">Date ↑ (oldest)</option>
              <option value="wallet">By wallet</option>
              <option value="asset">By asset</option>
              <option value="type">By type</option>
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" aria-hidden="true" />
          </div>

          <span className="text-xs tabular-figures text-low">{filtered.length} shown</span>

          {missingPriceTxs.length > 0 && priceLookupEnabled && (
            <Button size="sm" disabled={fetchingPrices} onClick={fetchMissingPrices} className="shrink-0">
              {fetchingPrices
                ? `Fetching ${priceProgress?.done ?? 0}/${priceProgress?.total ?? missingPriceTxs.length}…`
                : `Fetch ${missingPriceTxs.length} price${missingPriceTxs.length === 1 ? '' : 's'}`}
            </Button>
          )}
        </div>
      </div>

      {/* Select-page control + top pagination */}
      {pageRows.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label className="flex min-h-[40px] cursor-pointer items-center gap-2 rounded-md px-1 text-xs font-semibold text-low">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              title="Select all shown rows"
              aria-label="Select all shown rows"
              className="h-4 w-4 rounded accent-primary"
            />
            Select page
          </label>
          <div className="ml-auto">{renderPagination('')}</div>
        </div>
      )}

      {/* Date-grouped ledger (mockup frame 06) */}
      {pageRows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-hi/15 bg-elev-2 px-6 py-10 text-center shadow-xs">
          <p className="text-sm font-semibold text-mid">No transactions match these filters.</p>
          {!showSpam && !anyFilterActive && spamTxCount > 0 && (
            <p className="mt-2 text-xs text-low">
              Everything in the ledger is flagged spam — open the Spam ({spamTxCount}) chip above to review it.
            </p>
          )}
          {anyFilterActive && (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-2 rounded text-xs font-bold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.key} aria-label={g.key === 'all' ? 'Transactions' : `Transactions on ${formatGroupDateLabel(g.key)}`}>
              {g.key !== 'all' && (
                <div className="mb-2.5 flex items-baseline gap-2.5 px-1">
                  <h3 className="text-[0.8125rem] font-bold text-hi">{formatGroupDateLabel(g.key)}</h3>
                  <span className="text-xs tabular-figures text-low">
                    {g.rows.length} transaction{g.rows.length === 1 ? '' : 's'}
                  </span>
                </div>
              )}
              <div className="rounded-2xl border border-hi/10 bg-elev-2 shadow-card">{g.rows.map((t, i) => renderRow(t, i))}</div>
            </section>
          ))}
        </div>
      )}

      {renderPagination('pt-1', { utcNote: true })}

      {/* Floating bulk action bar (mockup frame 08) — menus open upward. */}
      {selected.size > 0 && (
        <div data-testid="bulk-action-bar" className="fixed bottom-20 left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-2xl border border-hi/15 bg-elev-2 px-3 py-2 shadow-pop lg:bottom-5">
          <span className="px-2 text-[0.8125rem] font-extrabold tabular-figures text-hi">{selected.size} selected</span>
          <span className="mx-1 hidden h-6 w-px bg-hi/10 sm:block" aria-hidden="true" />
          {/* Bulk: Set type (dropdown → impact-summary confirm) */}
          <div className="relative">
            <Button
              variant="secondary"
              size="sm"
              disabled={applyingBulk}
              aria-expanded={bulkTypeMenuOpen}
              aria-haspopup="menu"
              onClick={() => {
                setBulkFlagsMenuOpen(false);
                setBulkTypeMenuOpen((o) => !o);
              }}
            >
              <Tags className="h-3.5 w-3.5" />
              Set type ({selected.size})
            </Button>
            {bulkTypeMenuOpen && (
              <div className="absolute bottom-full right-0 mb-2 max-h-80 min-w-[11rem] overflow-y-auto rounded-xl border border-hi/10 bg-elev-2 py-1 shadow-pop">
                <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-low">
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
                    className="flex min-h-[36px] w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-elev-3"
                  >
                    <Badge tone={TYPE_TONE[t]} className="pointer-events-none text-[10px]">{t}</Badge>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setBulkTypeMenuOpen(false)}
                  className="flex min-h-[36px] w-full items-center gap-1 border-t border-hi/10 px-3 py-1.5 text-[10px] text-low hover:text-mid"
                >
                  <X className="h-3 w-3" /> Cancel
                </button>
              </div>
            )}
          </div>

          <div className="relative">
            <Button variant="secondary" size="sm" disabled={applyingBulk || bulkCompatibleCategories.length === 0}
              aria-expanded={bulkCategoryMenuOpen} aria-haspopup="menu"
              onClick={() => { setBulkTypeMenuOpen(false); setBulkFlagsMenuOpen(false); setBulkCategoryMenuOpen((open) => !open); }}>
              <Tags className="h-3.5 w-3.5" /> Set category ({selected.size})
            </Button>
            {bulkCategoryMenuOpen && (
              <div className="absolute bottom-full right-0 mb-2 max-h-80 min-w-[13rem] overflow-y-auto rounded-xl border border-hi/10 bg-elev-2 py-1 shadow-pop">
                <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-low">Compatible with every selected type</p>
                {bulkCompatibleCategories.map((category) => (
                  <button key={category} type="button" onClick={() => { setBulkCategoryMenuOpen(false); setPendingBulkCategory(category); }}
                    className="flex min-h-[36px] w-full px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-3">
                    {categoryLabel(category)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Bulk: Set flags (checkbox list → Apply) */}
          <div className="relative">
            <Button variant="secondary" size="sm" disabled={applyingBulk} aria-expanded={bulkFlagsMenuOpen} aria-haspopup="menu" onClick={openBulkFlags}>
              <Flag className="h-3.5 w-3.5" />
              Set flags ({selected.size})
            </Button>
            {bulkFlagsMenuOpen && bulkFlagsSel && (
              <div className="absolute bottom-full right-0 mb-2 min-w-[16rem] rounded-xl border border-hi/10 bg-elev-2 py-1 shadow-pop">
                <p className="px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-low">
                  Apply to {selected.size} selected
                </p>
                <p className="px-3 pb-1 text-[10px] text-low">
                  Checked = set on all · unchecked = remove from all
                </p>
                {BULK_FLAG_CHECKBOXES.map((flag) => (
                  <label
                    key={flag}
                    className="flex min-h-[40px] w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-3"
                  >
                    {flag === 'possible_internal_transfer' ? (
                      <input
                        type="checkbox"
                        checked={bulkFlagsSel.hint === 'checked'}
                        ref={(el) => {
                          // Native dash for a mixed selection: 'mixed' is not
                          // expressible via the `checked` prop, so set the
                          // DOM-only `indeterminate` property.
                          if (el) el.indeterminate = bulkFlagsSel.hint === 'mixed';
                        }}
                        onChange={(e) =>
                          // First click from the dash CHECKS (set on all);
                          // the next click unchecks (remove from all).
                          // 'mixed' itself is an initial state only.
                          patchBulkFlagsSel({ hint: e.target.checked ? 'checked' : 'unchecked' })
                        }
                        className="accent-primary"
                      />
                    ) : (
                      <input
                        type="checkbox"
                        checked={bulkFlagsSel.flags.get(flag) ?? false}
                        onChange={(e) => setBulkFlag(flag, e.target.checked)}
                        className="accent-primary"
                      />
                    )}
                    {FLAG_LABELS[flag]}
                  </label>
                ))}
                <p className="px-3 pb-1 text-[10px] text-low">
                  “Missing cost basis” also appears automatically while a row has no fiat value.
                </p>
                <p className="px-3 pb-1 text-[10px] text-low">
                  A dash on “Possible internal transfer” means only some selected rows have it — those rows are left as-is unless you check or uncheck the box.
                </p>
                <div className="my-1 border-t border-hi/10" />
                <label className="flex min-h-[40px] w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-3">
                  <input
                    type="checkbox"
                    checked={bulkFlagsSel.internal}
                    disabled={bulkPairManagedCount > 0}
                    onChange={(e) => patchBulkFlagsSel({ internal: e.target.checked })}
                    className="accent-primary"
                  />
                  Internal transfer (non-taxable)
                </label>
                {bulkPairManagedCount > 0 && (
                  <p className="px-3 pb-2 text-[10px] text-warn">
                    Internal transfer is disabled because {bulkPairManagedCount} selected row{bulkPairManagedCount === 1 ? '' : 's'} belong to a B4 pair. Confirm, reject, or unlink the reciprocal pair instead.
                  </p>
                )}
                <label className="flex min-h-[40px] w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-mid hover:bg-elev-3">
                  <input
                    type="checkbox"
                    checked={bulkFlagsSel.spam}
                    onChange={(e) => patchBulkFlagsSel({ spam: e.target.checked })}
                    className="accent-primary"
                  />
                  Spam (excluded everywhere)
                </label>
                <p className="px-3 pb-1 text-[10px] text-low">
                  Confirming “Internal transfer” clears the “Possible internal transfer” hint.
                </p>
                <div className="mt-1 flex justify-end gap-2 border-t border-hi/10 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => {
                      setBulkFlagsMenuOpen(false);
                      setBulkFlagsSel(null);
                    }}
                    className="min-h-[36px] rounded-full px-3 py-1 text-xs text-low hover:text-mid"
                  >
                    Cancel
                  </button>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={applyingBulk}
                    onClick={() => void applyBulkFlags()}
                  >
                    {applyingBulk ? 'Applying…' : `Apply to ${selected.size}`}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDeleteConfirmOpen(true)}
            className="border-loss/40 text-loss hover:bg-loss/10"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete {selected.size}
          </Button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            aria-label="Clear selection"
            className="grid h-9 w-9 place-items-center rounded-lg text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

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
        open={pendingBulkType != null}
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
      <ConfirmDialog
        open={pendingBulkCategory != null}
        title={pendingBulkCategory
          ? `Set ${selectedTxs.length} transaction${selectedTxs.length === 1 ? '' : 's'} to category “${categoryLabel(pendingBulkCategory)}”?`
          : ''}
        body="Category is semantic tax meaning and does not change structural transaction type. This can affect reports."
        confirmLabel={applyingBulk ? 'Applying…' : `Apply to ${selectedTxs.length}`}
        onConfirm={() => void applyBulkCategory()}
        onCancel={() => setPendingBulkCategory(null)}
      />
    </div>
  );
}
