import { requestFxPermission } from '@/components/import/FxPermissionDialog';
/** Historical execution-quote conversion. Fiat USD is not a stablecoin peg. */
import type { Transaction, TaxSettings } from '@/types/transaction';
import { normalizeFiatMagnitude } from '@/lib/parsers/types';
import { isSaasMode } from '@/lib/saas/config';
import { recordNetworkActivity, resolveMode } from '@/lib/networkActivity';

const FIAT = new Set(['USD', 'INR', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'SGD', 'HKD', 'CNY']);
type Rate = { rate: number; date: string };
const cache = new Map<string, Rate>();
export const normalizeFiatCurrency = (code: string): string => code.trim().toUpperCase();
export const needsFiatConversion = (from: string, to: string): boolean => normalizeFiatCurrency(from) !== normalizeFiatCurrency(to);
const day = (timestamp: number) => new Date(timestamp).toISOString().slice(0, 10);

async function historicalRate(from: string, to: string, timestamp: number): Promise<Rate | null> {
  if (!FIAT.has(from) || !FIAT.has(to) || !Number.isFinite(timestamp)) return null;
  const date = day(timestamp);
  const key = `${from}:${to}:${date}`;
  if (cache.has(key)) return cache.get(key)!;
  try {
    recordNetworkActivity(resolveMode(false));
    const response = await fetch(`https://api.frankfurter.dev/v1/${date}?from=${from}&to=${to}`, {
      credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) return null;
    const data = await response.json() as { base?: string; date?: string; rates?: Record<string, number> };
    const rate = data.rates?.[to];
    // Reference rates may use the previous business day, never a future/latest fallback.
    const actual = Date.parse(data.date ?? '');
    const age = Date.parse(date) - actual;
    if (data.base !== from || !data.date || !Number.isFinite(actual) || age < 0 || age > 7 * 86400000 || typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null;
    const result = { rate, date: data.date };
    cache.set(key, result);
    return result;
  } catch { return null; }
}

export async function convertFiatAmount(amount: number, fromCurrency: string, reportingCurrency: string, timestampMs: number, _key?: string): Promise<{ amount: number; currency: string } | null> {
  const from = normalizeFiatCurrency(fromCurrency), to = normalizeFiatCurrency(reportingCurrency);
  if (from === to || amount === 0) return { amount, currency: to };
  // This lower-level legacy API must not become a local consent bypass.
  if (!isSaasMode()) return null;
  const rate = await historicalRate(from, to, timestampMs);
  return rate ? { amount: amount * rate.rate, currency: to } : null;
}

export interface FiatConvertResult { transactions: Transaction[]; converted: number; failed: number }
function clearFlags(t: Transaction) { return (t.flags ?? []).filter(f => f !== 'missing_market_value' && f !== 'missing_cost_basis'); }
export function sourceQuote(t: Transaction) {
  if (t.executionQuote) return t.executionQuote;
  const amount = normalizeFiatMagnitude(t.fiatValue);
  if (amount != null) return { amount, currency: normalizeFiatCurrency(t.fiatCurrency), timestamp: t.timestamp };
  // Recover old local imports whose reporting value was cleared but execution
  // consideration survived. Never reinterpret an already priced INR row.
  const counter = normalizeFiatMagnitude(t.counterAmount);
  if (counter != null && t.counterAsset && ['buy', 'sell', 'trade'].includes(t.type)) {
    return { amount: counter, currency: normalizeFiatCurrency(t.counterAsset), timestamp: t.timestamp };
  }
  return undefined;
}
export function normalizeFiatToReportingCurrencyLocal(transactions: Transaction[], reportingCurrency: string): Transaction[] {
  const to = normalizeFiatCurrency(reportingCurrency);
  return transactions.map(t => {
    const amount = normalizeFiatMagnitude(t.fiatValue);
    if (amount == null) {
      const quote = sourceQuote(t);
      return { ...t, executionQuote: quote, fiatCurrency: to,
        ...(quote?.currency === to ? { fiatValue: quote.amount, flags: clearFlags(t) } : {}) };
    }
    if (!needsFiatConversion(t.fiatCurrency, to) || amount === 0) return { ...t, fiatValue: amount, fiatCurrency: to, flags: clearFlags(t) };
    return { ...t, executionQuote: sourceQuote(t), fiatValue: undefined, fiatCurrency: to };
  });
}

async function convertBatch(transactions: Transaction[], reportingCurrency: string): Promise<FiatConvertResult> {
  const to = normalizeFiatCurrency(reportingCurrency);
  let converted = 0, failed = 0;
  const out: Transaction[] = [];
  for (const t of transactions) {
    // Existing reporting totals (including zero) are authoritative.
    if (t.fiatValue != null && (!needsFiatConversion(t.fiatCurrency, to) || t.fiatValue === 0)) {
      out.push(...normalizeFiatToReportingCurrencyLocal([t], to)); continue;
    }
    const quote = sourceQuote(t);
    if (!quote) { out.push(t); continue; }
    const rate = await historicalRate(quote.currency, to, quote.timestamp);
    if (!rate || !Number.isFinite(quote.amount * rate.rate)) { failed++; out.push(...normalizeFiatToReportingCurrencyLocal([t], to)); continue; }
    converted++;
    out.push({ ...t, executionQuote: quote, fiatValue: quote.amount * rate.rate, fiatCurrency: to, flags: clearFlags(t),
      fxProvenance: { provider: 'Frankfurter', rate: rate.rate, requestedDate: day(quote.timestamp), rateDate: rate.date, from: quote.currency, to } });
  }
  return { transactions: out, converted, failed };
}
export async function convertTransactionsToReportingCurrency(transactions: Transaction[], settings: Pick<TaxSettings, 'reportingCurrency' | 'coingeckoApiKey'>): Promise<FiatConvertResult> {
  if (!isSaasMode()) return { transactions: normalizeFiatToReportingCurrencyLocal(transactions, settings.reportingCurrency), converted: 0, failed: 0 };
  return convertBatch(transactions, settings.reportingCurrency);
}

/** Permission is fresh per batch, before even consulting the rate cache. Cancel/Escape is denial. */
export async function convertOrNormalizeForImport(transactions: Transaction[], settings: Pick<TaxSettings, 'reportingCurrency' | 'coingeckoApiKey'>, priceApiEnabled: boolean): Promise<FiatConvertResult> {
  if (isSaasMode()) return priceApiEnabled ? convertBatch(transactions, settings.reportingCurrency) : { transactions: normalizeFiatToReportingCurrencyLocal(transactions, settings.reportingCurrency), converted: 0, failed: 0 };
  const quotes = transactions.filter(t => t.fiatValue == null || needsFiatConversion(t.fiatCurrency, settings.reportingCurrency)).map(sourceQuote).filter(q => q && q.amount !== 0);
  const requests = [...new Set(quotes.filter(q => q && q.currency !== settings.reportingCurrency.toUpperCase() && FIAT.has(q.currency) && Number.isFinite(q.timestamp)).map(q => `${q!.currency} → ${settings.reportingCurrency}: ${day(q!.timestamp)}`))];
  if (requests.length && await requestFxPermission(requests, settings.reportingCurrency)) {
    return convertBatch(transactions, settings.reportingCurrency);
  }
  return { transactions: normalizeFiatToReportingCurrencyLocal(transactions, settings.reportingCurrency), converted: 0, failed: quotes.length };
}
