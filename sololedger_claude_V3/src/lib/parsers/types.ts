import type { Transaction, TxType } from '@/types/transaction';

/** A required import field a file was missing — drives actionable fix-the-file guidance. */
export type MissingField = 'type' | 'amount' | 'asset' | 'timestamp' | 'preamble';

export interface ParseResult {
  transactions: Transaction[];
  skippedRows: number;
  warnings: string[];
  /**
   * Structured hint of which required field(s) were absent when a file could
   * not be parsed. Lets callers render specific fix-the-file guidance instead
   * of a generic dead-end error.
   */
  missingFields?: MissingField[];
  /**
   * True when the parse resolved addresses from a single ambiguous "Address"
   * column (no clearly-named To/From), so orientation is a best-effort
   * "assume To" guess. Lets a non-local caller optionally confirm/flip it.
   */
  addressColumnAmbiguous?: boolean;
}

/**
 * Optional context threaded from `parseSheetMatrix` to a parser. Lets the
 * generic parser resolve an implied transaction type from a sheet's report
 * title (e.g. Binance "Deposit History") when there is no explicit type column.
 */
export interface SheetContext {
  /** Type implied by the sheet/report title when no type column exists. */
  impliedType?: TxType;
  /** Raw sheet/report title that produced `impliedType`, for provenance. */
  sheetTitle?: string;
}

export interface ExchangeParser {
  id: string;
  label: string;
  /** Cheap heuristic check on headers to auto-detect this format. */
  detect: (headers: string[], ctx?: SheetContext) => boolean;
  parse: (rows: Record<string, string>[], ctx?: SheetContext) => ParseResult;
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

/**
 * Precision-stable string for an amount used inside dedup / content-hash keys.
 * Shared by `exchangeSourceRef`, `contentHashRef`, and `normalizeImportAmount`
 * (db.ts) so the same logical amount always rounds identically — a re-import
 * therefore produces the same key. Tiers: >=1 → 4dp, >=1e-4 → 6dp, else 9dp.
 */
export function stableAmountKey(amount: number): string {
  const a = Math.abs(amount);
  if (a >= 1) return a.toFixed(4);
  if (a >= 0.0001) return a.toFixed(6);
  return a.toFixed(9);
}

/** Stable ref for deduping exchange CSV rows across import sources. */
export function exchangeSourceRef(
  source: string,
  timestamp: number,
  type: string,
  asset: string,
  amount: number
): string {
  return `${source}:${timestamp}:${type}:${asset.toUpperCase()}:${stableAmountKey(amount)}`;
}

/** Small, fast, deterministic non-crypto string hash (FNV-1a, 32-bit). */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Content-addressed sourceRef for manual / AI-mapped imports that have no
 * exchange row id. Hashing the identifying fields (timestamp, type, asset,
 * amount, counter) makes the ref stable across re-imports of the same file,
 * so `transactionExchangeKey` dedups a re-import to the same key instead of
 * a positional `row:<i>` that shifts when rows are reordered or filtered.
 */
export function contentHashRef(parts: {
  timestamp: number;
  type: string;
  asset: string;
  amount: number;
  counterAsset?: string;
  counterAmount?: number;
}): string {
  const s = [
    parts.timestamp,
    parts.type,
    (parts.asset || '').toUpperCase(),
    stableAmountKey(parts.amount),
    (parts.counterAsset || '').toUpperCase(),
    parts.counterAmount != null ? stableAmountKey(parts.counterAmount) : ''
  ].join('|');
  return `chash:${fnv1a(s)}`;
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

/**
 * Parse exchange timestamps that are documented as UTC (e.g. a Binance Spot
 * "Date(UTC)" column) when no timezone offset is present. Without this, a
 * bare "YYYY-MM-DD HH:mm:ss" is parsed in the machine's *local* zone, which
 * shifts the timestamp on a non-UTC machine. Mirrors `safeTimestampIst` but
 * anchors to UTC (append `Z` / `+00:00`).
 */
export function safeTimestampUtc(v: string | undefined): number {
  if (!v) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  // Already has a timezone (Z or ±HH:MM) — trust it.
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) return Date.parse(s);
  // "YYYY-MM-DD HH:mm:ss" or "YYYY-MM-DDTHH:mm:ss(.sss)" → treat as UTC.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)/);
  if (m) return Date.parse(`${m[1]}T${m[2]}Z`);
  return Date.parse(s);
}
