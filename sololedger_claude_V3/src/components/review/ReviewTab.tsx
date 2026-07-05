import { Fragment, useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, getSpecIdHints } from '@/lib/storage/db';
import { Badge } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { TxType, Transaction } from '@/types/transaction';
import { formatCurrency, formatCompactAmount } from '@/lib/utils';
import { calculateCostBasis } from '@/lib/costBasis/engine';
import { fetchHistoricalPricesBatch } from '@/lib/pricing/coingecko';
import { COINGECKO_PLATFORM, CHAINS, type ChainId } from '@/lib/rpc/providers';
import { resolveAssetLabel } from '@/lib/assets/solanaMints';
import { looksLikeTruncatedMint, resolveTokenSymbolFromContract } from '@/lib/assets/tokenSymbols';
import { resolvePriceAsset } from '@/lib/assets/resolvePriceAsset';
import { reprocessSwapDetectionInDb } from '@/lib/rpc/reprocessSwaps';
import { countPotentialSwapPairs } from '@/lib/rpc/swapDetection';
import { LotPicker } from './LotPicker';
import { Check, X, Pencil, AlertTriangle } from 'lucide-react';

const DISPOSAL_TYPES = new Set(['sell', 'trade', 'gift_sent', 'nft_sell']);

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

function displayFlags(t: Transaction): string[] {
  const flags = new Set(t.flags ?? []);
  if (t.fiatValue == null && !t.isInternalTransfer) flags.add('missing_cost_basis');
  return [...flags];
}

export function ReviewTab() {
  const [query, setQuery] = useState('');
  const [assetFilter, setAssetFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
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

  const transactions = useLiveQuery(() => db.transactions.orderBy('timestamp').reverse().toArray(), []) ?? [];
  const hints = useLiveQuery(() => getSpecIdHints(), []) ?? {};

  // Resolve truncated contract addresses → tickers via CoinGecko (cached + saved to IndexedDB).
  useEffect(() => {
    let cancelled = false;
    const unresolved = transactions.filter(
      (t) => t.contractAddress && t.chain && (looksLikeTruncatedMint(t.asset) || t.asset.startsWith('0x'))
    );
    if (unresolved.length === 0) return;

    (async () => {
      for (const t of unresolved) {
        if (cancelled) break;
        const symbol = await resolveTokenSymbolFromContract(t.asset, t.contractAddress, t.chain);
        if (symbol && symbol !== t.asset) {
          await db.transactions.update(t.id, { asset: symbol });
        }
        await new Promise((r) => setTimeout(r, 350));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [transactions]);

  const engineResult = useMemo(() => {
    if (!settings) return null;
    return calculateCostBasis(transactions, { method: settings.defaultCostBasisMethod, specIdHints: hints });
  }, [transactions, settings, hints]);

  /** Any row flagged or typed as needing a fiat value — includes wallet-import transfers. */
  const missingPriceTxs = useMemo(
    () =>
      transactions.filter(
        (t) =>
          t.fiatValue == null &&
          !t.isInternalTransfer &&
          ((Array.isArray(t.flags) && t.flags.includes('missing_cost_basis')) ||
            (t.type !== 'transfer_in' && t.type !== 'transfer_out'))
      ),
    [transactions]
  );

  const rpcTransferCount = useMemo(
    () =>
      transactions.filter(
        (t) =>
          t.source.startsWith('rpc:') &&
          (t.type === 'transfer_in' || t.type === 'transfer_out') &&
          t.fiatValue == null &&
          !t.isInternalTransfer
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
    void reprocessSwapDetectionInDb().then((n) => {
      if (n > 0) {
        setSwapDetectMsg(`Auto-detected ${n} DEX swap${n === 1 ? '' : 's'}. Fetch missing prices next, then check Capital Gains.`);
      }
    });
  }, [potentialSwapPairs]);

  const fetchMissingPrices = async () => {
    if (!settings?.priceApiEnabled || missingPriceTxs.length === 0) return;
    setFetchingPrices(true);
    setPriceErrors([]);
    try {
      const priceRequests = missingPriceTxs.map((t) => {
        const priceAsset = resolvePriceAsset(t.asset, t.contractAddress, t.chain);
        const stableCounter =
          t.type === 'trade' &&
          t.counterAsset &&
          ['USDC', 'USDT'].includes(resolvePriceAsset(t.counterAsset, undefined, t.chain).toUpperCase()) &&
          t.counterAmount;
        const asset = stableCounter
          ? resolvePriceAsset(t.counterAsset!, undefined, t.chain)
          : priceAsset;
        const isStable = ['USDC', 'USDT', 'DAI'].includes(asset.toUpperCase());
        const contractAddress = stableCounter || isStable ? undefined : t.contractAddress;
        const platform = stableCounter || isStable ? undefined : t.chain ? COINGECKO_PLATFORM[t.chain as ChainId] : undefined;
        return {
          tx: t,
          request: {
            asset,
            timestampMs: t.timestamp,
            fiatCurrency: settings.reportingCurrency,
            contractAddress,
            platform,
            chain: t.chain,
            alchemyApiKey: settings.alchemyApiKey,
            alchemyNetwork: t.chain ? CHAINS.find((c) => c.id === t.chain)?.alchemyNetwork : undefined
          },
          useCounterAmount: !!stableCounter
        };
      });
      const results = await fetchHistoricalPricesBatch(
        priceRequests.map((p) => p.request),
        (done, total) => setPriceProgress({ done, total })
      );
      const errorCounts = new Map<string, number>();
      let updated = 0;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const { tx, useCounterAmount } = priceRequests[i];
        if (r.price != null) {
          const qty = useCounterAmount ? tx.counterAmount ?? tx.amount : tx.amount;
          // eslint-disable-next-line no-await-in-loop
          await db.transactions.update(tx.id, {
            fiatValue: r.price * qty,
            fiatCurrency: r.currency,
            flags: (tx.flags ?? []).filter((f) => f !== 'missing_cost_basis')
          });
          updated++;
        } else if (r.error) {
          const key = `${tx.asset} (${r.date}): ${r.error.split(';')[0]}`;
          errorCounts.set(key, (errorCounts.get(key) ?? 0) + 1);
        }
      }
      const errors = [...errorCounts.entries()].map(([msg, count]) =>
        count > 1 ? `${msg} (×${count})` : msg
      );
      const failed = results.length - updated;
      if (results.length > 0) {
        errors.unshift(
          `Finished ${results.length} price lookup${results.length === 1 ? '' : 's'}: ${updated} updated, ${failed} could not be priced.`
        );
      }
      setPriceErrors(errors);
    } catch (err) {
      setPriceErrors([err instanceof Error ? err.message : 'Price fetch failed unexpectedly.']);
    } finally {
      setFetchingPrices(false);
      setPriceProgress(null);
    }
  };

  const runSwapDetection = async () => {
    setDetectingSwaps(true);
    setSwapDetectMsg(null);
    try {
      const n = await reprocessSwapDetectionInDb();
      setSwapDetectMsg(
        n > 0
          ? `Detected ${n} DEX swap${n === 1 ? '' : 's'} — check Capital Gains after fetching prices.`
          : 'No new swap pairs found. Each swap needs one asset out + one in on the same transaction hash.'
      );
    } finally {
      setDetectingSwaps(false);
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

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      if (assetFilter !== 'all' && t.asset !== assetFilter) return false;
      if (query && !`${t.asset} ${t.type} ${t.source} ${t.notes ?? ''}`.toLowerCase().includes(query.toLowerCase()))
        return false;
      return true;
    });
  }, [transactions, assetFilter, query]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const bulkMarkInternal = async () => {
    await Promise.all(
      Array.from(selected).map((id) => db.transactions.update(id, { isInternalTransfer: true, flags: [] }))
    );
    setSelected(new Set());
  };

  if (transactions.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="font-display text-xl font-semibold text-mist">Review</h2>
          <p className="mt-1 text-sm text-mist-400">Give each transaction a quick once-over before you file.</p>
        </div>
        <div className="rounded-lg border-2 border-dashed border-ink-600 bg-ink-800 px-6 py-14 text-center text-sm text-mist-400">
          No transactions yet — import a CSV or add one manually to get started.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-display text-xl font-semibold text-mist">Review</h2>
        <p className="mt-1 text-sm text-mist-400">Give each transaction a quick once-over before you file.</p>
      </div>
      {potentialSwapPairs > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border border-violet/40 bg-violet/10 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-mist">
              {potentialSwapPairs} possible DEX swap{potentialSwapPairs === 1 ? '' : 's'} waiting to be merged
            </p>
            <p className="text-xs text-mist-400">
              Wallet imports show as transfer_in/out until merged into trades. Click Detect DEX swaps, then fetch
              prices — Capital Gains will show matched buy/sell rows.
            </p>
          </div>
          <Button variant="secondary" disabled={detectingSwaps} onClick={runSwapDetection} className="shrink-0">
            {detectingSwaps ? 'Detecting swaps…' : 'Detect DEX swaps'}
          </Button>
        </div>
      )}

      {missingPriceTxs.length > 0 && (
        <div className="flex flex-col gap-3 rounded-lg border-2 border-gold bg-gold/20 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold text-ink-950">
              <AlertTriangle className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-mist">
                {missingPriceTxs.length} transaction{missingPriceTxs.length === 1 ? '' : 's'} still need a price
              </p>
              <p className="text-xs text-mist-400">
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
        <div className={`rounded-sm border px-3 py-2 text-xs ${priceErrors[0]?.startsWith('Finished') ? 'border-emerald/30 bg-emerald/10 text-emerald-700' : 'border-loss/30 bg-loss/10 text-loss'}`}>
          {priceErrors.slice(0, 5).join(' · ')}
          {priceErrors.length > 5 ? ` · +${priceErrors.length - 5} more` : ''}
        </div>
      )}

      {swapDetectMsg && (
        <div className="rounded-sm border border-emerald/30 bg-emerald/10 px-3 py-2 text-xs text-emerald-700">
          {swapDetectMsg}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search transactions…"
          className="rounded-full border border-ink-600 bg-ink-800 px-4 py-1.5 text-sm text-mist placeholder:text-mist-400 focus:border-violet focus:outline-none"
        />
        <select
          value={assetFilter}
          onChange={(e) => setAssetFilter(e.target.value)}
          className="rounded-full border border-ink-600 bg-ink-800 px-4 py-1.5 text-sm text-mist focus:border-violet focus:outline-none"
        >
          <option value="all">All assets</option>
          {assets.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <span className="text-xs text-mist-400">{filtered.length} shown</span>
        <Button variant="secondary" disabled={detectingSwaps} onClick={runSwapDetection} className="shrink-0">
          {detectingSwaps ? 'Detecting swaps…' : 'Detect DEX swaps'}
        </Button>
        {missingPriceTxs.length > 0 && settings?.priceApiEnabled && (
          <Button
            disabled={fetchingPrices}
            onClick={fetchMissingPrices}
            className="ml-auto shrink-0"
          >
            {fetchingPrices
              ? `Fetching ${priceProgress?.done ?? 0}/${priceProgress?.total ?? missingPriceTxs.length}…`
              : `Fetch ${missingPriceTxs.length} price${missingPriceTxs.length === 1 ? '' : 's'}`}
          </Button>
        )}
        {missingPriceTxs.length > 0 && settings && !settings.priceApiEnabled && (
          <span className="ml-auto text-xs text-gold-600">
            Enable Live price lookup in Settings to fetch {missingPriceTxs.length} price
            {missingPriceTxs.length === 1 ? '' : 's'}
          </span>
        )}
        {selected.size > 0 && (
          <Button variant="secondary" onClick={bulkMarkInternal} className={missingPriceTxs.length > 0 && settings?.priceApiEnabled ? '' : 'ml-auto'}>
            Mark {selected.size} as internal transfer (non-taxable)
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-ink-700">
        <table className="w-full min-w-[920px] text-sm">
          <thead className="bg-ink-800 text-left text-xs uppercase tracking-wide text-mist-400">
            <tr>
              <th className="w-8 px-2 py-2"></th>
              <th className="px-2 py-2">Date</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Chain</th>
              <th className="px-2 py-2">Asset</th>
              <th className="px-2 py-2 text-right">Amount</th>
              <th className="px-2 py-2 text-right">Fiat</th>
              <th className="px-2 py-2">From</th>
              <th className="px-2 py-2">To</th>
              <th className="min-w-[10rem] px-2 py-2">Flags</th>
            </tr>
          </thead>
          <tbody className="font-mono tabular-figures">
            {filtered.slice(0, 200).map((t) => {
              const isDisposal = DISPOSAL_TYPES.has(t.type);
              const candidates = engineResult?.disposalCandidates[t.id] ?? [];
              const fromAddr = t.type === 'transfer_out' ? t.walletAddress : t.counterpartyAddress;
              const toAddr = t.type === 'transfer_out' ? t.counterpartyAddress : t.walletAddress;
              const chainLabel = t.chain ? CHAINS.find((c) => c.id === t.chain)?.label ?? t.chain : '—';
              const assetLabel = resolveAssetLabel(t.asset, t.contractAddress, t.chain);
              const isEditing = editingFiat === t.id;
              return (
                <Fragment key={t.id}>
                  <tr className="border-t border-ink-700/60 hover:bg-ink-700/20">
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} />
                    </td>
                    <td className="px-3 py-2 text-mist-300">{new Date(t.timestamp).toISOString().slice(0, 10)}</td>
                    <td className="px-3 py-2">
                      <Badge tone={TYPE_TONE[t.type]}>{t.type}</Badge>
                    </td>
                    <td className="px-3 py-2 text-mist-400">{chainLabel}</td>
                    <td className="px-3 py-2 text-mist" title={t.contractAddress}>
                      {assetLabel}
                      {t.type === 'trade' && t.counterAsset && (
                        <span className="ml-1 text-mist-400">
                          → {resolveAssetLabel(t.counterAsset, undefined, t.chain)}
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-2 text-right text-mist" title={String(t.amount)}>
                      {formatCompactAmount(t.amount)}
                    </td>
                    <td className="px-3 py-2 text-right text-mist-300">
                      {isEditing ? (
                        <span className="flex items-center justify-end gap-1">
                          <input
                            autoFocus
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-24 rounded border border-violet bg-white px-2 py-0.5 text-right text-xs text-mist focus:outline-none"
                            placeholder="0.00"
                          />
                          <button onClick={() => saveFiat(t)} className="text-emerald-600" aria-label="Save">
                            <Check className="h-3.5 w-3.5" />
                          </button>
                          <button onClick={() => setEditingFiat(null)} className="text-mist-400" aria-label="Cancel">
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => startEditFiat(t.id, t.fiatValue)}
                          className="group inline-flex items-center gap-1 hover:text-violet"
                          title="Click to enter a fiat value manually"
                        >
                          {t.fiatValue != null ? formatCurrency(t.fiatValue, t.fiatCurrency) : '—'}
                          <Pencil className="h-3 w-3 opacity-0 group-hover:opacity-60" />
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-2 text-mist-400" title={fromAddr}>
                      {truncateAddress(fromAddr)}
                    </td>
                    <td className="px-2 py-2 text-mist-400" title={toAddr}>
                      {truncateAddress(toAddr)}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <div className="flex max-w-[14rem] flex-wrap gap-1 whitespace-normal">
                      {t.isInternalTransfer && <Badge tone="neutral">internal</Badge>}
                      {t.category === 'nft' && <Badge tone="pink">nft</Badge>}
                      {displayFlags(t).map((f) => (
                        <Badge key={f} tone="gold" className="text-[10px]">
                          {f.replace(/_/g, ' ')}
                        </Badge>
                      ))}
                      </div>
                      {isDisposal && settings?.defaultCostBasisMethod === 'SpecID' && (
                        <button
                          className="ml-2 text-emerald-600 underline decoration-dotted"
                          onClick={() => setOpenLotPicker((cur) => (cur === t.id ? null : t.id))}
                        >
                          match lots
                        </button>
                      )}
                    </td>
                  </tr>
                  {openLotPicker === t.id && (
                    <tr>
                      <td colSpan={10} className="bg-ink-900/60 px-3 py-3">
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
      {filtered.length > 200 && (
        <p className="text-xs text-mist-400">Showing first 200 of {filtered.length} — refine filters to narrow down.</p>
      )}
    </div>
  );
}
