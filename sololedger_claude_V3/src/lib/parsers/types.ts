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

export function safeTimestamp(v: string | undefined): number {
  if (!v) return NaN;
  const t = Date.parse(v);
  return t;
}
