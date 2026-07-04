import { db } from '@/lib/storage/db';
import { fetchHistoricalPricesBatch, type PriceRequest, type PriceLookupResult, usdToCurrencyRate } from '@/lib/pricing/coingecko';
import { COINGECKO_PLATFORM, CHAINS, type ChainId } from '@/lib/rpc/providers';
import type { TaxSettings, Transaction } from '@/types/transaction';

/** Transactions that still need a fiat value filled in. */
export function transactionsMissingPrices(transactions: Transaction[]): Transaction[] {
  return transactions.filter((t) => t.fiatValue == null && !t.isInternalTransfer);
}

function priceCacheKey(request: PriceRequest): string {
  const day = new Date(request.timestampMs).toISOString().slice(0, 10);
  return [request.asset, day, request.contractAddress ?? '', request.platform ?? '', request.fiatCurrency].join('|');
}

export interface ApplyMissingPricesResult {
  priced: number;
  errors: string[];
}

/**
 * Fetches historical prices for the given transactions and writes fiatValue
 * back to IndexedDB. Shared by Review and Wallet lookup.
 */
export async function applyMissingPrices(
  txs: Transaction[],
  settings: TaxSettings,
  onProgress?: (done: number, total: number) => void
): Promise<ApplyMissingPricesResult> {
  if (!settings.priceApiEnabled || txs.length === 0) {
    return { priced: 0, errors: [] };
  }

  if (settings.reportingCurrency.toUpperCase() !== 'USD' && txs.length > 0) {
    await usdToCurrencyRate(txs[0].timestamp, settings.reportingCurrency);
  }

  const indexedRequests = txs.map((t, index) => ({
    index,
    request: {
      asset: t.asset,
      timestampMs: t.timestamp,
      fiatCurrency: settings.reportingCurrency,
      contractAddress: t.contractAddress,
      platform: t.chain ? COINGECKO_PLATFORM[t.chain as ChainId] : undefined,
      alchemyApiKey: settings.alchemyApiKey,
      alchemyNetwork: t.chain ? CHAINS.find((c) => c.id === t.chain)?.alchemyNetwork : undefined
    } satisfies PriceRequest
  }));

  const uniqueByKey = new Map<string, { request: PriceRequest; indices: number[] }>();
  for (const item of indexedRequests) {
    const key = priceCacheKey(item.request);
    const existing = uniqueByKey.get(key);
    if (existing) existing.indices.push(item.index);
    else uniqueByKey.set(key, { request: item.request, indices: [item.index] });
  }

  const uniqueEntries = [...uniqueByKey.values()];
  const uniqueResults = await fetchHistoricalPricesBatch(
    uniqueEntries.map((entry) => entry.request),
    (done, total) => onProgress?.(done, total)
  );

  const resultsByTxIndex: PriceLookupResult[] = new Array(txs.length);
  uniqueEntries.forEach((entry, i) => {
    for (const txIndex of entry.indices) resultsByTxIndex[txIndex] = uniqueResults[i];
  });

  const errors: string[] = [];
  const seenErrors = new Set<string>();
  let priced = 0;

  await Promise.all(
    resultsByTxIndex.map(async (r, i) => {
      const tx = txs[i];
      if (r.price != null) {
        await db.transactions.update(tx.id, {
          fiatValue: r.price * tx.amount,
          fiatCurrency: r.currency,
          flags: tx.flags.filter((f) => f !== 'missing_cost_basis')
        });
        priced += 1;
      } else if (r.error) {
        const message = `${tx.asset} on ${r.date}: ${r.error}`;
        if (!seenErrors.has(message)) {
          seenErrors.add(message);
          errors.push(message);
        }
      }
    })
  );

  return { priced, errors };
}
