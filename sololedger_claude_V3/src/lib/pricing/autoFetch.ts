/**
 * Shared price-fetch utility used both by WalletLookupPanel (after import)
 * and ReviewTab (manual button). Extracts the price-request building logic
 * so it isn't duplicated.
 */
import { db } from '@/lib/storage/db';
import { fetchHistoricalPricesBatch } from './coingecko';
import { convertTransactionsToReportingCurrency, normalizeFiatCurrency } from './fiatConvert';
import { resolvePriceAsset } from '@/lib/assets/resolvePriceAsset';
import { COINGECKO_PLATFORM, CHAINS, type ChainId } from '@/lib/rpc/providers';
import type { Transaction, TaxSettings, FlagReason } from '@/types/transaction';
import type { PriceRequest } from './coingecko';

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
    const priceAsset = resolvePriceAsset(t.asset, t.contractAddress, t.chain);
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

/**
 * Fetch prices for all transactions in the DB that are missing a fiat value.
 * Skips spam, skips anything that already has a price.
 * Internal transfers are included so Review can show fiat values for display.
 * Uses the persistent IndexedDB price cache — the same asset+date pair is only
 * ever fetched once from CoinGecko/Alchemy/Birdeye, across all time.
 */
export async function fetchMissingPricesForAllTransactions(
  settings: PricingSettings,
  onProgress?: (done: number, total: number) => void
): Promise<AutoFetchResult> {
  const all = await db.transactions.toArray();
  const needsPrice = all.filter((t) => t.fiatValue == null && !t.isSpam);
  const needsConversion = all.filter(
    (t) =>
      t.fiatValue != null &&
      Math.abs(t.fiatValue) > 1e-12 &&
      !t.isSpam &&
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
    for (const t of converted) {
      if (t.fiatCurrency.toUpperCase() === settings.reportingCurrency.toUpperCase()) {
        // eslint-disable-next-line no-await-in-loop
        await db.transactions.update(t.id, {
          fiatValue: t.fiatValue,
          fiatCurrency: t.fiatCurrency,
          flags: t.flags
        });
      }
    }
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

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const { tx, useCounterAmount } = items[i];
      if (r.price != null) {
        const qty = useCounterAmount ? (tx.counterAmount ?? tx.amount) : tx.amount;
        // eslint-disable-next-line no-await-in-loop
        await db.transactions.update(tx.id, {
          fiatValue: r.price * qty,
          fiatCurrency: r.currency,
          flags: (tx.flags ?? []).filter((f) => f !== 'missing_cost_basis') as FlagReason[]
        });
        updated++;
      } else {
        failed++;
      }
    }
  }

  return { updated, failed, total: needsPrice.length + needsConversion.length };
}
