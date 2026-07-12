import Papa from 'papaparse';
import { coinbaseParser } from './coinbase';
import { binanceParser } from './binance';
import { binanceSpotParser } from './binanceSpot';
import type { ExchangeParser, ParseResult } from './types';

export const PARSERS: ExchangeParser[] = [binanceSpotParser, coinbaseParser, binanceParser];

export interface FileParseOutcome extends ParseResult {
  detectedParser: string | null; // parser id, or null if manual mapping needed
  headers: string[];
  rows: Record<string, string>[]; // raw rows, kept so UI can offer manual mapping on miss
}

interface ExtractedTable {
  headers: string[];
  rows: Record<string, string>[];
  headerRowIndex: number;
}

function cleanCell(value: string | undefined): string {
  return (value ?? '').trim();
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function makeUniqueHeaders(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < values.length; i++) {
    const raw = cleanCell(values[i]);
    const base = raw || `column_${i + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    out.push(count === 0 ? base : `${base}_${count + 1}`);
  }
  return out;
}

function isLikelyDataRow(cells: string[]): boolean {
  const nonEmpty = cells.filter((c) => c !== '');
  if (nonEmpty.length < 2) return false;
  const numericLike = nonEmpty.filter((c) => /[-+$€£₹]?\d/.test(c)).length;
  return numericLike >= 1;
}

function scoreHeaderCandidate(cells: string[]): number {
  const nonEmpty = cells.filter((c) => c !== '');
  if (nonEmpty.length < 3) return -1;

  const normalized = nonEmpty.map(normalizeHeader);
  const knownHints = [
    'date',
    'time',
    'timestamp',
    'type',
    'transactiontype',
    'operation',
    'asset',
    'coin',
    'symbol',
    'pair',
    'amount',
    'quantity',
    'qty',
    'price',
    'subtotal',
    'total',
    'fee',
    'currency',
    'notes',
    'senderaddress',
    'recipientaddress',
    'id'
  ];

  let score = 0;
  for (const h of normalized) {
    if (knownHints.some((k) => h.includes(k))) score += 3;
    if (/^[a-z_][a-z0-9_ ]{1,40}$/i.test(h)) score += 1;
    if (/\d{4}-\d{2}-\d{2}/.test(h) || /^-?\d+([.,]\d+)?$/.test(h)) score -= 2;
  }
  return score;
}

function extractRelevantCsvTable(text: string): ExtractedTable {
  const parsed = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: 'greedy'
  });
  const matrix = parsed.data.map((row) => row.map((c) => cleanCell(String(c ?? ''))));
  if (matrix.length === 0) return { headers: [], rows: [], headerRowIndex: 0 };

  let bestIdx = 0;
  let bestScore = -1;
  const scanLimit = Math.min(matrix.length, 40);
  for (let i = 0; i < scanLimit; i++) {
    const score = scoreHeaderCandidate(matrix[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const headerCells = matrix[bestIdx];
  const width = headerCells.length;
  const headers = makeUniqueHeaders(headerCells);

  const rows: Record<string, string>[] = [];
  for (let i = bestIdx + 1; i < matrix.length; i++) {
    const row = matrix[i];
    const trimmed = row.slice(0, width).map((c) => cleanCell(c));
    if (trimmed.every((c) => c === '')) continue;
    if (!isLikelyDataRow(trimmed)) continue;
    const obj: Record<string, string> = {};
    for (let col = 0; col < width; col++) {
      obj[headers[col]] = trimmed[col] ?? '';
    }
    rows.push(obj);
  }

  return { headers, rows, headerRowIndex: bestIdx };
}

/** Reads a File in the browser (no upload — FileReader is entirely local) and
 * attempts to auto-detect + parse it against known exchange formats. */
export async function parseCsvFile(file: File): Promise<FileParseOutcome> {
  const text = await file.text();
  const extracted = extractRelevantCsvTable(text);
  const headers = extracted.headers;
  const rows = extracted.rows;
  const preambleWarning =
    extracted.headerRowIndex > 0
      ? `Ignored ${extracted.headerRowIndex} non-transaction row(s) before the detected header row.`
      : null;

  if (headers.length === 0 || rows.length === 0) {
    return {
      transactions: [],
      skippedRows: 0,
      warnings: [
        'Could not find a usable transactions table in this CSV. Try a different export or map columns manually.'
      ],
      detectedParser: null,
      headers,
      rows
    };
  }

  const matched = PARSERS.find((p) => p.detect(headers));
  if (!matched) {
    return {
      transactions: [],
      skippedRows: 0,
      warnings: [
        ...(preambleWarning ? [preambleWarning] : []),
        'Could not auto-detect this file’s format. Map the columns manually below.'
      ],
      detectedParser: null,
      headers,
      rows
    };
  }

  const result = matched.parse(rows);
  return {
    ...result,
    warnings: [...(preambleWarning ? [preambleWarning] : []), ...result.warnings],
    detectedParser: matched.id,
    headers,
    rows
  };
}

export { coinbaseParser, binanceParser, binanceSpotParser };
export * from './types';
export * from './generic';
