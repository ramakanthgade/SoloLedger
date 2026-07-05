import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Compact amount for table columns — avoids 16-digit strings blowing layout. */
export function formatCompactAmount(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1000) return amount.toFixed(2);
  if (abs >= 1) return amount.toFixed(4);
  if (abs >= 0.0001) return amount.toFixed(6);
  return amount.toPrecision(4);
}

export function formatDateTime(timestampMs: number): string {
  const d = new Date(timestampMs);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
