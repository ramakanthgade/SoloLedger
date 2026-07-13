import type { Transaction } from '@/types/transaction';

export interface ParseResult {
  transactions: Transaction[];
  skippedRows: number;
  warnings: string[];
}

export interface ExchangeParser {
  id: string;
  label: string;
  /** Cheap heuristic check on headers to auto-detect this format. */
  detect: (headers: string[]) => boolean;
  parse: (rows: Record<string, string>[]) => ParseResult;
}

let counter = 0;
export function makeId(prefix = 'tx'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}_${Math.random().toString(36).slice(2, 8)}`;
}

export function safeNumber(v: string | undefined): number {
  if (!v) return 0;
  const n = Number(String(v).replace(/[,$]/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

/** Fiat value magnitude — exchanges often export outflows as negative subtotals. */
export function normalizeFiatMagnitude(value: number | undefined | null): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const abs = Math.abs(value);
  return abs < 1e-12 ? undefined : abs;
}

/** Parse values like "0.34SOL", "49.2286USDT", or plain "144.79". */
export function safeQuantity(v: string | undefined): number {
  if (!v) return 0;
  const s = String(v).replace(/[,$\s]/g, '').trim();
  const m = s.match(/^(-?[\d.]+)/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/** Stable ref for deduping exchange CSV rows across import sources. */
export function exchangeSourceRef(
  source: string,
  timestamp: number,
  type: string,
  asset: string,
  amount: number
): string {
  const a = amount >= 1 ? amount.toFixed(4) : amount >= 0.0001 ? amount.toFixed(6) : amount.toFixed(9);
  return `${source}:${timestamp}:${type}:${asset.toUpperCase()}:${a}`;
}

export function safeTimestamp(v: string | undefined): number {
  if (!v) return NaN;
  const t = Date.parse(v);
  return t;
}

/**
 * Parse exchange timestamps that are documented as IST (India Standard Time, UTC+5:30)
 * when no timezone offset is present in the string.
 */
export function safeTimestampIst(v: string | undefined): number {
  if (!v) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  // Already has timezone
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  // "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DDTHH:mm:ss"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)/);
  if (m) return Date.parse(`${m[1]}T${m[2]}+05:30`);
  return Date.parse(s);
}
