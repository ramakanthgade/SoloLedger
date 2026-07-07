/**
 * Convert imported fiat values (e.g. USDT/USD from Binance) into the user's
 * reporting currency (INR, CAD, AED, USD) using historical FX rates — same
 * approach as wallet price fetch (CoinGecko USDT rate on transaction date).
 */
import type { Transaction, TaxSettings } from '@/types/transaction';
import { usdToCurrencyRate } from './coingecko';

const USD_EQUIVALENT = new Set(['USD', 'USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'FDUSD', 'DAI']);

const frankfurterCache = new Map<string, number>();

/** Free historical fiat FX fallback when CoinGecko is unavailable (no API key). */
async function usdToCurrencyRateFrankfurter(
  timestampMs: number,
  currency: string
): Promise<number | null> {
  const to = currency.toUpperCase();
  if (to === 'USD') return 1;

  const d = new Date(timestampMs);
  const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  const key = `${date}:${to}`;
  if (frankfurterCache.has(key)) return frankfurterCache.get(key)!;

  try {
    const res = await fetch(`https://api.frankfurter.app/${date}?from=USD&to=${to}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { rates?: Record<string, number> };
    const rate = data.rates?.[to];
    if (rate == null || !Number.isFinite(rate)) return null;
    frankfurterCache.set(key, rate);
    return rate;
  } catch {
    return null;
  }
}

async function resolveUsdToReportingRate(
  timestampMs: number,
  reportingCurrency: string,
  coingeckoApiKey?: string
): Promise<number | null> {
  const to = reportingCurrency.toUpperCase();
  if (to === 'USD') return 1;
  const cg = await usdToCurrencyRate(timestampMs, to, coingeckoApiKey);
  if (cg != null) return cg;
  return usdToCurrencyRateFrankfurter(timestampMs, to);
}

/** Treat stablecoins as USD for FX conversion. */
export function normalizeFiatCurrency(code: string): string {
  const c = code.trim().toUpperCase();
  if (USD_EQUIVALENT.has(c)) return 'USD';
  return c;
}

export function needsFiatConversion(fiatCurrency: string, reportingCurrency: string): boolean {
  return normalizeFiatCurrency(fiatCurrency) !== reportingCurrency.toUpperCase();
}

/**
 * Convert a fiat amount from import currency to reporting currency on a given date.
 * Returns null if the historical rate could not be fetched.
 */
export async function convertFiatAmount(
  amount: number,
  fromCurrency: string,
  reportingCurrency: string,
  timestampMs: number,
  coingeckoApiKey?: string
): Promise<{ amount: number; currency: string } | null> {
  const from = normalizeFiatCurrency(fromCurrency);
  const to = reportingCurrency.toUpperCase();
  if (from === to) return { amount, currency: to };

  // Source is USD-equivalent (Binance USDT totals, Coinbase USD, etc.)
  if (from === 'USD') {
    const rate = await resolveUsdToReportingRate(timestampMs, to, coingeckoApiKey);
    if (rate == null) return null;
    return { amount: amount * rate, currency: to };
  }

  // EUR/GBP in file — convert via USD bridge
  if (from === 'EUR' || from === 'GBP') {
    const toTarget = await resolveUsdToReportingRate(timestampMs, to, coingeckoApiKey);
    const fromUsd = await resolveUsdToReportingRate(timestampMs, from, coingeckoApiKey);
    if (toTarget == null || fromUsd == null || fromUsd === 0) return null;
    const usdAmount = amount / fromUsd;
    return { amount: usdAmount * toTarget, currency: to };
  }

  return null;
}

export interface FiatConvertResult {
  transactions: Transaction[];
  converted: number;
  failed: number;
}

/**
 * Rewrite fiatValue/fiatCurrency on transactions whose values are not yet in
 * the user's reporting currency (e.g. Binance USDT → INR for India jurisdiction).
 */
export async function convertTransactionsToReportingCurrency(
  transactions: Transaction[],
  settings: Pick<TaxSettings, 'reportingCurrency' | 'coingeckoApiKey'>
): Promise<FiatConvertResult> {
  const reporting = settings.reportingCurrency.toUpperCase();
  let converted = 0;
  let failed = 0;

  const out: Transaction[] = [];
  for (const t of transactions) {
    if (t.fiatValue == null || t.fiatValue <= 0) {
      out.push(t);
      continue;
    }
    if (!needsFiatConversion(t.fiatCurrency, reporting)) {
      out.push({ ...t, fiatCurrency: reporting });
      continue;
    }

    const result = await convertFiatAmount(
      t.fiatValue,
      t.fiatCurrency,
      reporting,
      t.timestamp,
      settings.coingeckoApiKey
    );

    if (result == null) {
      failed++;
      out.push(t);
      continue;
    }

    converted++;
    out.push({
      ...t,
      fiatValue: result.amount,
      fiatCurrency: result.currency,
      flags: (t.flags ?? []).filter((f) => f !== 'missing_cost_basis')
    });
  }

  return { transactions: out, converted, failed };
}
