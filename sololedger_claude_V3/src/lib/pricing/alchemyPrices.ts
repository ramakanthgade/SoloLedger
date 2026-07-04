/**
 * Alchemy's Prices API, used as a *fallback* when CoinGecko has no listing
 * for a token — this is common for small, DEX-only tokens (Alchemy's
 * "by address" mode pulls straight from 100+ DEXes, including chains like
 * Solana, rather than requiring a CEX listing like CoinGecko does).
 *
 * Important limitation: as far as the published docs and examples show,
 * this endpoint returns prices in USD only — there's no fiat-currency
 * parameter. So when this is used as the price source, the caller (see
 * lib/pricing/index.ts) converts the USD figure to the reporting currency
 * using a same-day CoinGecko USDT rate, rather than trusting a second
 * currency out of Alchemy directly.
 */

const PRICES_BASE = 'https://api.g.alchemy.com/prices/v1';

export interface AlchemyPriceResult {
  priceUsd: number | null;
  error?: string;
}

interface HistoricalOpts {
  symbol?: string;
  network?: string;
  address?: string;
}

export async function fetchAlchemyHistoricalPriceUsd(
  apiKey: string,
  opts: HistoricalOpts,
  timestampMs: number
): Promise<AlchemyPriceResult> {
  const startTime = new Date(timestampMs - 2 * 86400000).toISOString();
  const endTime = new Date(timestampMs + 2 * 86400000).toISOString();

  const body: Record<string, unknown> = { startTime, endTime, interval: '1d' };
  if (opts.symbol) body.symbol = opts.symbol;
  else if (opts.network && opts.address) {
    body.network = opts.network;
    body.address = opts.address;
  } else {
    return { priceUsd: null, error: 'No symbol or contract address to look up.' };
  }

  try {
    const res = await fetch(`${PRICES_BASE}/${apiKey}/tokens/historical`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      return { priceUsd: null, error: `Alchemy Prices API returned ${res.status}` };
    }
    const data = await res.json();
    // Response shape per Alchemy's docs nests a `data` array; parsed
    // defensively since the exact field names weren't verified live.
    const series: any[] = data?.data?.prices ?? data?.prices ?? data?.data?.[0]?.prices ?? [];
    if (!Array.isArray(series) || series.length === 0) {
      return { priceUsd: null, error: 'No Alchemy price history for this token.' };
    }

    let closest = series[0];
    let closestDiff = Infinity;
    for (const point of series) {
      const t = new Date(point.timestamp ?? point.time ?? point.date ?? 0).getTime();
      const diff = Math.abs(t - timestampMs);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = point;
      }
    }
    const value = Number(closest.value ?? closest.price ?? closest.close);
    return Number.isFinite(value) ? { priceUsd: value } : { priceUsd: null, error: 'Unrecognized Alchemy price response shape.' };
  } catch (err) {
    return { priceUsd: null, error: err instanceof Error ? err.message : 'Network request failed.' };
  }
}
