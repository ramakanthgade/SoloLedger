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

async function applyPricingPatches(patches: PricingPatch[]): Promise<void> {
  if (patches.length === 0) return;
  await db.transaction('rw', db.transactions, async () => {
    const current = await db.transactions.bulkGet(patches.map((patch) => patch.id));
    const merged: Transaction[] = [];
    for (let index = 0; index < patches.length; index++) {
      const row = current[index];
      if (!row) continue;
      const patch = patches[index];
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

  if (needsPrice.length === 0 && needsConversion.length === 0) {
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
    const items = buildPriceRequestsForTransactions(needs, settings);
    const results = await fetchHistoricalPricesBatch(
      items.map((p) => p.request),
      onProgress
    );

    const pricedRows: PricingPatch[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const { tx, useCounterAmount } = items[i];
      if (r.price != null) {
        const qty = useCounterAmount ? (tx.counterAmount ?? tx.amount) : tx.amount;
        pricedRows.push({
          id: tx.id,
          fiatValue: r.price * qty,
          fiatCurrency: r.currency,
          removeMissingMarketValue: true,
          // A stored basis flag on an unpriced row came from legacy importers;
          // genuine lot shortfalls are runtime-derived and are never cleared here.
          removeLegacyPriceMarker: true,
          onlyIfUnpriced: true
        });
        updated++;
      } else {
        failed++;
      }
    }
    await applyPricingPatches(pricedRows);
  }

  return { updated, failed, total: needsPrice.length + needsConversion.length };
}
