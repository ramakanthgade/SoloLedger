import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a monetary amount in the user's reporting currency.
 * Uses Indian locale (en-IN) for INR to produce the correct lakh/crore grouping:
 *   42,36,073.33 instead of 4,236,073.33
 * All other currencies use en-US grouping.
 */
export function formatCurrency(amount: number, currency: string): string {
  try {
    const locale = currency.toUpperCase() === 'INR' ? 'en-IN' : 'en-US';
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/**
 * Compact number label for table columns (avoids 16-digit strings breaking layout).
 * For INR, uses Indian compact suffixes: L = lakh, Cr = crore.
 */
export function formatCompactAmount(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1000) return amount.toFixed(2);
  if (abs >= 1) return amount.toFixed(4);
  if (abs >= 0.0001) return amount.toFixed(6);
  return amount.toPrecision(4);
}

/**
 * Indian-style compact currency label: ₹1.2Cr, ₹42.3L, ₹1,23,456.
 * Use this for large totals where you want short labels (charts, summary cards).
 */
export function formatCompactCurrency(amount: number, currency: string): string {
  if (currency.toUpperCase() !== 'INR') return formatCurrency(amount, currency);
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-' : '';
  if (abs >= 1_00_00_000) return `${sign}₹${(abs / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `${sign}₹${(abs / 1_00_000).toFixed(2)}L`;
  return formatCurrency(amount, currency);
}

export function formatDateTime(timestampMs: number): string {
  const d = new Date(timestampMs);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
