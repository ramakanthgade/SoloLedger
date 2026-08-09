/**
 * Shared price-fetch utility used both by WalletLookupPanel (after import)
 * and ReviewTab (manual button). Extracts the price-request building logic
 * so it isn't duplicated.
 */
import { db } from '@/lib/storage/db';
import { isTransactionExcluded, transactionsUnderCurrentSafetyPolicy } from '@/lib/safety/assetSafety';
import { fetchHistoricalPricesBatch } from './coingecko';
import { convertTransactionsToReportingCurrency, normalizeFiatCurrency } from './fiatConvert';
import { resolvePriceAsset } from '@/lib/assets/resolvePriceAsset';
import { COINGECKO_PLATFORM, CHAINS, type ChainId } from '@/lib/rpc/providers';
import type { Transaction, TaxSettings, FlagReason } from '@/types/transaction';
import type { PriceRequest } from './coingecko';
import { requiresMarketValue } from '@/lib/transactions/requiresMarketValue';

interface PriceRequestWithMeta {
  tx: Transaction;
  request: PriceRequest;
  useCounterAmount: boolean;
}

type PricingSettings = Pick<
  TaxSettings,
  'reportingCurrency' | 'coingeckoApiKey' | 'alchemyApiKey' | 'birdeyeApiKey'
>;

export function buildPriceRequestsForTransactions(
  transactions: Transaction[],
  settings: PricingSettings
): PriceRequestWithMeta[] {
  return transactions.map((t) => {
    const priceAsset = resolvePriceAsset(t.asset, t.contractAddress, t.chain, t.safetyState);
    const stableCounter =
      t.type === 'trade' &&
      !!t.counterAsset &&
      ['USDC', 'USDT', 'DAI'].includes(
        resolvePriceAsset(t.counterAsset, undefined, t.chain).toUpperCase()
      ) &&
      !!t.counterAmount;

    const asset = stableCounter
      ? resolvePriceAsset(t.counterAsset!, undefined, t.chain)
      : priceAsset;
    const isStable = ['USDC', 'USDT', 'DAI'].includes(asset.toUpperCase());
    const contractAddress = stableCounter || isStable ? undefined : t.contractAddress;
    const platform =
      stableCounter || isStable
        ? undefined
        : t.chain
          ? COINGECKO_PLATFORM[t.chain as ChainId]
          : undefined;

    return {
      tx: t,
      request: {
        asset,
        timestampMs: t.timestamp,
        fiatCurrency: settings.reportingCurrency,
        contractAddress,
        platform,
        chain: t.chain,
        source: t.source,
        coingeckoApiKey: settings.coingeckoApiKey,
        alchemyApiKey: settings.alchemyApiKey,
        birdeyeApiKey: settings.birdeyeApiKey,
        alchemyNetwork: t.chain ? CHAINS.find((c) => c.id === t.chain)?.alchemyNetwork : undefined
      } satisfies PriceRequest,
      useCounterAmount: stableCounter
    };
  });
}

export interface AutoFetchResult {
  updated: number;
  failed: number;
  total: number;
}

interface PricingPatch {
  id: string;
  fiatValue: number | undefined;
  fiatCurrency: string;
  removeMissingMarketValue?: boolean;
  removeLegacyPriceMarker?: boolean;
  onlyIfUnpriced?: boolean;
  expectedFiatValue?: number;
  expectedFiatCurrency?: string;
}

interface LinkedPricingPatch {
  rows: Array<{
    id: string;
    expectedFiatValue: number | undefined;
    expectedFiatCurrency: string;
  }>;
  fiatValue: number;
  fiatCurrency: string;
}

function linkedSpotFill(row: Transaction): { groupKey: string; leg: 'sell' | 'buy' } | null {
  const linkId = row.raw?.spotFillLinkId;
  const leg = row.raw?.spotFillLeg;
  return typeof linkId === 'string' && linkId.length > 0 && (leg === 'sell' || leg === 'buy')
    // Native fill IDs are account-local. JSON tuple encoding is explicit and
    // collision-safe even when a source, connection ID, or link ID contains a
    // delimiter that a hand-built joined string could misinterpret.
    ? { groupKey: JSON.stringify([row.source, row.importBatchId ?? 'unscoped', linkId]), leg }
    : null;
}

function linkedSpotFillPairs(rows: Transaction[]): Array<{ sell: Transaction; buy: Transaction }> {
  const groups = new Map<string, Partial<Record<'sell' | 'buy', Transaction>>>();
  for (const row of rows) {
    const linked = linkedSpotFill(row);
    if (!linked) continue;
    const group = groups.get(linked.groupKey) ?? {};
    group[linked.leg] = row;
    groups.set(linked.groupKey, group);
  }
  return [...groups.values()].flatMap((group) => group.sell && group.buy
    ? [{ sell: group.sell, buy: group.buy }]
    : []);
}

async function applyPricingPatches(
  patches: PricingPatch[],
  linkedPatches: LinkedPricingPatch[] = []
): Promise<void> {
  if (patches.length === 0 && linkedPatches.length === 0) return;
  await db.transaction('rw', db.transactions, async () => {
    const ids = [...patches.map((patch) => patch.id), ...linkedPatches.flatMap((patch) => patch.rows.map((row) => row.id))];
    const current = await db.transactions.bulkGet(ids);
    const currentById = new Map(current.flatMap((row) => row ? [[row.id, row] as const] : []));
    const merged: Transaction[] = [];
    for (const patch of patches) {
      const row = currentById.get(patch.id);
      if (!row) continue;
      if (patch.onlyIfUnpriced && row.fiatValue != null) continue;
      if (
        patch.expectedFiatCurrency != null &&
        (row.fiatValue !== patch.expectedFiatValue || row.fiatCurrency !== patch.expectedFiatCurrency)
      ) continue;
      merged.push({
        ...row,
        fiatValue: patch.fiatValue,
        fiatCurrency: patch.fiatCurrency,
        flags: patch.removeMissingMarketValue
          ? (row.flags ?? []).filter((flag) =>
              flag !== 'missing_market_value' &&
              !(patch.removeLegacyPriceMarker && flag === 'missing_cost_basis')
            ) as FlagReason[]
          : row.flags
      });
    }
    for (const patch of linkedPatches) {
      const rows = patch.rows.map((expected) => ({ expected, row: currentById.get(expected.id) }));
      // Linked execution FMV is an atomic invariant. If either row disappeared
      // or was manually repriced while network work was in flight, write
      // neither leg rather than retaining a half-updated/divergent event.
      if (rows.some(({ expected, row }) => !row ||
        row.fiatValue !== expected.expectedFiatValue || row.fiatCurrency !== expected.expectedFiatCurrency)) continue;
      for (const { row } of rows) {
        merged.push({
          ...row!, fiatValue: patch.fiatValue, fiatCurrency: patch.fiatCurrency,
          flags: (row!.flags ?? []).filter((flag) =>
            flag !== 'missing_market_value' && flag !== 'missing_cost_basis') as FlagReason[]
        });
      }
    }
    if (merged.length > 0) await db.transactions.bulkPut(merged);
  });
}

/**
 * Fetch prices for all transactions in the DB that are missing a fiat value.
 * Skips spam, internal custody movements, and anything already priced.
 * Internal transfers do not need historical tax cost basis.
 * Uses the persistent IndexedDB price cache — the same asset+date pair is only
 * ever fetched once from CoinGecko/Alchemy/Birdeye, across all time.
 */
export async function fetchMissingPricesForAllTransactions(
  settings: PricingSettings,
  onProgress?: (done: number, total: number) => void
): Promise<AutoFetchResult> {
  const all = transactionsUnderCurrentSafetyPolicy(
    await db.transactions.toArray(), await db.safetyDecisions.toArray()
  );
  const needsPrice = all.filter((t) =>
    t.fiatValue == null && !isTransactionExcluded(t) && !t.isInternalTransfer && requiresMarketValue(t)
  );
  const needsConversion = all.filter(
    (t) =>
      t.fiatValue != null &&
      Math.abs(t.fiatValue) > 1e-12 &&
      !isTransactionExcluded(t) &&
      t.fiatCurrency.toUpperCase() !== settings.reportingCurrency.toUpperCase() &&
      normalizeFiatCurrency(t.fiatCurrency) !== settings.reportingCurrency.toUpperCase()
  );
  const linkedPairs = linkedSpotFillPairs(all);
  const needsLinkedReconciliation = linkedPairs.some(({ sell, buy }) =>
    sell.fiatValue != null && buy.fiatValue != null &&
    (sell.fiatValue !== buy.fiatValue || sell.fiatCurrency !== buy.fiatCurrency));

  if (needsPrice.length === 0 && needsConversion.length === 0 && !needsLinkedReconciliation) {
    return { updated: 0, failed: 0, total: 0 };
  }

  // Network activity is recorded at the price/FX transports (coingecko, birdeye,
  // alchemyPrices, fiatConvert), so no ad-hoc call is needed here.
  let updated = 0;
  let failed = 0;

  if (needsConversion.length > 0) {
    const { transactions: converted, converted: nConv, failed: nFail } =
      await convertTransactionsToReportingCurrency(needsConversion, settings);
    const convertedRows = converted.filter(
      (t) => t.fiatCurrency.toUpperCase() === settings.reportingCurrency.toUpperCase()
    );
    const conversionOriginalById = new Map(needsConversion.map((row) => [row.id, row]));
    // One IndexedDB commit avoids invalidating every live query once per row.
    // On large Binance imports those repeated full-ledger renders made even
    // scrolling stall while optional prices were being saved.
    await applyPricingPatches(convertedRows.map((row) => {
      const original = conversionOriginalById.get(row.id)!;
      return {
        id: row.id,
        fiatValue: row.fiatValue,
        fiatCurrency: row.fiatCurrency,
        removeMissingMarketValue:
          original.flags.includes('missing_market_value') && !row.flags.includes('missing_market_value'),
        expectedFiatValue: original.fiatValue,
        expectedFiatCurrency: original.fiatCurrency
      };
    }));
    updated += nConv;
    failed += nFail;
  }

  const needs = needsPrice;

  if (needs.length > 0) {
    const linkedIds = new Set(linkedPairs.flatMap(({ sell, buy }) => [sell.id, buy.id]));
    // Capture immutable CAS evidence after operation-owned FX conversion but
    // before any historical-price provider request. A user edit made while
    // that request is in flight must invalidate the whole linked event rather
    // than becoming the new "expected" state and then being overwritten.
    const linkedBeforeProvider = await db.transactions.bulkGet([...linkedIds]);
    const linkedSnapshotById = new Map(linkedBeforeProvider.flatMap((row) => row
      ? [[row.id, {
          id: row.id,
          fiatValue: row.fiatValue,
          fiatCurrency: row.fiatCurrency
        }] as const]
      : []));
    const items = buildPriceRequestsForTransactions(needs, settings);
    const results = await fetchHistoricalPricesBatch(
      items.map((p) => p.request),
      onProgress
    );

    const priceById = new Map<string, { fiatValue: number; fiatCurrency: string }>();
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const { tx, useCounterAmount } = items[i];
      if (r.price != null) {
        const qty = useCounterAmount ? (tx.counterAmount ?? tx.amount) : tx.amount;
        priceById.set(tx.id, { fiatValue: r.price * qty, fiatCurrency: r.currency });
      }
    }

    const pricedRows: PricingPatch[] = needs.filter((tx) => !linkedIds.has(tx.id)).flatMap((tx) => {
      const price = priceById.get(tx.id);
      if (!price) {
        failed += 1;
        return [];
      }
      updated += 1;
      return [{
        id: tx.id, ...price, removeMissingMarketValue: true,
        // A stored basis flag on an unpriced row came from legacy importers;
        // genuine lot shortfalls are runtime-derived and are never cleared here.
        removeLegacyPriceMarker: true, onlyIfUnpriced: true
      }];
    });

    const linkedPatches: LinkedPricingPatch[] = [];
    for (const pair of linkedPairs) {
      const sell = linkedSnapshotById.get(pair.sell.id);
      const buy = linkedSnapshotById.get(pair.buy.id);
      if (!sell || !buy) continue;
      const sellCandidate = sell.fiatValue == null ? priceById.get(sell.id) : undefined;
      const buyCandidate = buy.fiatValue == null ? priceById.get(buy.id) : undefined;
      // Disposal-first preserves the prior one-trade valuation semantics. If
      // it cannot price, either already-valued or newly-priced partner is the
      // execution FMV authority. Both rows always receive that exact pair.
      const canonical = sellCandidate ?? (sell.fiatValue != null
        ? { fiatValue: sell.fiatValue, fiatCurrency: sell.fiatCurrency }
        : buyCandidate ?? (buy.fiatValue != null
          ? { fiatValue: buy.fiatValue, fiatCurrency: buy.fiatCurrency }
          : undefined));
      const missingCount = Number(pair.sell.fiatValue == null) + Number(pair.buy.fiatValue == null);
      if (!canonical) {
        failed += missingCount;
        continue;
      }
      updated += missingCount;
      linkedPatches.push({
        rows: [sell, buy].map((row) => ({
          id: row.id,
          expectedFiatValue: row.fiatValue,
          expectedFiatCurrency: row.fiatCurrency
        })),
        ...canonical
      });
    }
    await applyPricingPatches(pricedRows, linkedPatches);
  } else if (needsLinkedReconciliation) {
    // FX conversion above may already have rewritten these rows. Reconcile
    // from the post-conversion snapshot so the compare-and-swap remains valid.
    const ids = linkedPairs.flatMap(({ sell, buy }) => [sell.id, buy.id]);
    const current = await db.transactions.bulkGet(ids);
    const currentById = new Map(current.flatMap((row) => row ? [[row.id, row] as const] : []));
    const linkedPatches: LinkedPricingPatch[] = linkedPairs.flatMap((pair) => {
      const sell = currentById.get(pair.sell.id);
      const buy = currentById.get(pair.buy.id);
      return sell?.fiatValue != null && buy
        ? [{
            rows: [sell, buy].map((row) => ({
              id: row.id, expectedFiatValue: row.fiatValue, expectedFiatCurrency: row.fiatCurrency
            })),
            fiatValue: sell.fiatValue, fiatCurrency: sell.fiatCurrency
          }]
        : [];
    });
    await applyPricingPatches([], linkedPatches);
  }

  return { updated, failed, total: needsPrice.length + needsConversion.length };
}
