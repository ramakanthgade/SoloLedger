import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Jurisdiction } from '@/types/transaction';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format a monetary amount in the user's reporting currency.
 * Uses Indian locale (en-IN) for INR: ₹42,36,073.33 (lakh/crore grouping).
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

/** Locale-aware number grouping without a currency symbol (for exports). */
export function formatNumberLocale(amount: number, currency: string): string {
  const locale = currency.toUpperCase() === 'INR' ? 'en-IN' : 'en-US';
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(Math.abs(amount));
}

/**
 * PDF-safe currency string. jsPDF's built-in fonts cannot render ₹ (U+20B9) or
 * other Unicode currency symbols — they appear as stray glyphs and break spacing.
 */
export function formatCurrencyForPdf(amount: number, currency: string): string {
  const num = formatNumberLocale(amount, currency);
  const sign = amount < 0 ? '-' : '';
  switch (currency.toUpperCase()) {
    case 'INR':
      return `${sign}Rs. ${num}`;
    case 'USD':
      return `${sign}$${num}`;
    case 'CAD':
      return `${sign}CA$${num}`;
    case 'AED':
      return `${sign}AED ${num}`;
    default:
      return `${sign}${num} ${currency.toUpperCase()}`;
  }
}

/** CSV column suffix for monetary fields, e.g. "proceeds (INR)". */
export function monetaryColumnLabel(base: string, currency: string): string {
  return `${base} (${currency.toUpperCase()})`;
}

/** Compact number for table columns. */
export function formatCompactAmount(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1000) return amount.toFixed(2);
  if (abs >= 1) return amount.toFixed(4);
  if (abs >= 0.0001) return amount.toFixed(6);
  return amount.toPrecision(4);
}

/** Indian-style compact currency label: ₹42.3L, ₹1.2Cr. */
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

// ─────────────────────────────────────────────────────────────────────────────
// Financial Year utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the start and end timestamps (ms) of a financial year.
 *
 * India:      FY N    = Apr 1, N  →  Mar 31, N+1  (23:59:59.999 UTC)
 * US/CA/AE:  Year N  = Jan 1, N  →  Dec 31, N
 */
export function getFyBoundaries(
  fy: number,
  jurisdiction: Jurisdiction
): { start: number; end: number } {
  if (jurisdiction === 'IN') {
    const start = Date.UTC(fy, 3, 1);        // Apr 1 00:00 UTC
    const end   = Date.UTC(fy + 1, 3, 1) - 1; // Mar 31 23:59:59.999
    return { start, end };
  }
  const start = Date.UTC(fy, 0, 1);
  const end   = Date.UTC(fy + 1, 0, 1) - 1;
  return { start, end };
}

/**
 * Returns the "FY number" for a given UTC timestamp.
 * India:  timestamp in Apr 2025 – Mar 2026  → 2025
 * Others: timestamp in 2025                  → 2025
 */
export function getFyForTimestamp(
  timestampMs: number,
  jurisdiction: Jurisdiction
): number {
  const d = new Date(timestampMs);
  if (jurisdiction === 'IN') {
    // FY starts April (month 3 in 0-indexed)
    return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  }
  return d.getUTCFullYear();
}

/**
 * Returns the current financial year number.
 * India: if today is Jul 2026 → 2026 (FY 2026-27)
 */
export function getCurrentFy(jurisdiction: Jurisdiction): number {
  return getFyForTimestamp(Date.now(), jurisdiction);
}

export function isInFy(timestampMs: number, fy: number, jurisdiction: Jurisdiction): boolean {
  const { start, end } = getFyBoundaries(fy, jurisdiction);
  return timestampMs >= start && timestampMs <= end;
}

/**
 * India:  2025 → "FY 2025-26"
 * Others: 2025 → "2025"
 */
export function getFyLabel(fy: number, jurisdiction: Jurisdiction): string {
  if (jurisdiction === 'IN') {
    const next = (fy + 1).toString().slice(-2);
    return `FY ${fy}-${next}`;
  }
  return String(fy);
}

/**
 * Returns all unique FY numbers that appear in a set of timestamps.
 * Always includes the current FY.
 */
export function getAvailableFys(
  timestampsMs: number[],
  jurisdiction: Jurisdiction
): number[] {
  const fys = new Set<number>([getCurrentFy(jurisdiction)]);
  for (const ts of timestampsMs) {
    fys.add(getFyForTimestamp(ts, jurisdiction));
  }
  return Array.from(fys).sort((a, b) => b - a);
}
