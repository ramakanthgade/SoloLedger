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
 * Export-safe amount string (PDF/CSV). Currency is shown in column headers —
 * values are plain locale-formatted numbers without a repeated symbol prefix.
 */
export function formatAmountForExport(amount: number, currency: string): string {
  const sign = amount < 0 ? '-' : '';
  return `${sign}${formatNumberLocale(amount, currency)}`;
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
//
// Timezone model (documented assumption):
//   Financial-year boundaries are civil-calendar dates, so they must be resolved
//   in the jurisdiction's civil timezone rather than in raw UTC. Bucketing a
//   timestamp by its UTC calendar date would misfile transactions that occur near
//   a boundary — e.g. a 2025-04-01 02:00 IST trade is 2025-03-31 20:30 UTC, which
//   would wrongly land in the previous FY if bucketed by UTC date.
//
//   - India (IN): a FIXED IST offset of UTC+5:30 (India observes no DST), so the
//     FY runs Apr 1 00:00 IST → Mar 31 23:59:59.999 IST. Using a fixed offset is
//     exact for India and avoids any host-timezone dependency.
//   - US/CA/AE: the runtime LOCAL calendar year (getFullYear), i.e. the tax year
//     is bucketed against the host machine's civil timezone.
//
//   ASSUMPTION: there is no per-user timezone setting; US/CA/AE bucketing uses the
//   host machine's local zone. If per-user timezones are needed later (e.g. a US
//   filer running on a non-US machine), thread an explicit IANA zone through these
//   helpers instead of relying on the host's local zone.

/** Fixed India Standard Time offset (UTC+5:30). India observes no DST. */
export const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** IST civil calendar day key (YYYY-MM-DD) for a UTC-epoch timestamp. */
export function istDateKey(timestampMs: number): string {
  return new Date(timestampMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Trigger a client-side file download for the given text content.
 * Pure DOM side-effect; used by every CSV/JSON export path.
 */
export function downloadBlob(content: string, mime: string, filename: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Escape a single CSV field: wrap in quotes and double any embedded quotes
 * only when the value contains a quote, comma, or newline (RFC 4180).
 */
export function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Returns the start and end timestamps (ms, UTC epoch) of a financial year.
 *
 * India:      FY N   = Apr 1 00:00 IST  →  Mar 31 23:59:59.999 IST (fixed +5:30)
 * US/CA/AE:  Year N = Jan 1 00:00 local →  Dec 31 23:59:59.999 local
 */
export function getFyBoundaries(
  fy: number,
  jurisdiction: Jurisdiction
): { start: number; end: number } {
  if (jurisdiction === 'IN') {
    // Apr 1 00:00 IST / Apr 1 00:00 IST (next FY) expressed as UTC instants.
    const start = Date.UTC(fy, 3, 1) - IST_OFFSET_MS;
    const end   = Date.UTC(fy + 1, 3, 1) - IST_OFFSET_MS - 1;
    return { start, end };
  }
  // Local civil calendar year (host machine timezone).
  const start = new Date(fy, 0, 1).getTime();
  const end   = new Date(fy + 1, 0, 1).getTime() - 1;
  return { start, end };
}

/**
 * Returns the "FY number" for a given timestamp, bucketed in the jurisdiction's
 * civil timezone.
 * India:  a timestamp in Apr 2025 – Mar 2026 (IST) → 2025
 * Others: a timestamp in local-calendar 2025       → 2025
 */
export function getFyForTimestamp(
  timestampMs: number,
  jurisdiction: Jurisdiction
): number {
  if (jurisdiction === 'IN') {
    // Shift into IST civil time, then read the IST calendar month/year.
    // FY starts in April (month 3, 0-indexed).
    const ist = new Date(timestampMs + IST_OFFSET_MS);
    return ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  }
  return new Date(timestampMs).getFullYear();
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
