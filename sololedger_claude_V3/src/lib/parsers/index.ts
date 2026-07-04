import Papa from 'papaparse';
import { coinbaseParser } from './coinbase';
import { binanceParser } from './binance';
import type { ExchangeParser, ParseResult } from './types';

export const PARSERS: ExchangeParser[] = [coinbaseParser, binanceParser];

export interface FileParseOutcome extends ParseResult {
  detectedParser: string | null; // parser id, or null if manual mapping needed
  headers: string[];
  rows: Record<string, string>[]; // raw rows, kept so UI can offer manual mapping on miss
}

/** Reads a File in the browser (no upload — FileReader is entirely local) and
 * attempts to auto-detect + parse it against known exchange formats. */
export async function parseCsvFile(file: File): Promise<FileParseOutcome> {
  const text = await file.text();
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true
  });

  const headers = parsed.meta.fields ?? [];
  const rows = parsed.data;

  const matched = PARSERS.find((p) => p.detect(headers));
  if (!matched) {
    return {
      transactions: [],
      skippedRows: 0,
      warnings: ['Could not auto-detect this file\u2019s format. Map the columns manually below.'],
      detectedParser: null,
      headers,
      rows
    };
  }

  const result = matched.parse(rows);
  return { ...result, detectedParser: matched.id, headers, rows };
}

export { coinbaseParser, binanceParser };
export * from './types';
export * from './generic';
