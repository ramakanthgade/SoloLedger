/**
 * Shared table extraction from a 2D string matrix (CSV rows or Excel sheet cells).
 * Finds the best header row via scoring, then builds Record rows for parsers.
 */

export interface ExtractedTable {
  headers: string[];
  rows: Record<string, string>[];
  headerRowIndex: number;
  /** Heuristic score of the chosen header row (-1 if none). */
  headerScore: number;
}

export function cleanCell(value: string | undefined | null): string {
  return (value ?? '').trim();
}

export function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function makeUniqueHeaders(values: string[]): string[] {
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

export function isLikelyDataRow(cells: string[]): boolean {
  const nonEmpty = cells.filter((c) => c !== '');
  if (nonEmpty.length < 2) return false;
  const numericLike = nonEmpty.filter((c) => /[-+$€£₹]?\d/.test(c)).length;
  return numericLike >= 1;
}

/** Known crypto/exchange column name fragments — higher score ⇒ likelier header row. */
const KNOWN_HEADER_HINTS = [
  'date',
  'time',
  'timestamp',
  'type',
  'tradetype',
  'transactiontype',
  'transaction',
  'operation',
  'asset',
  'coin',
  'symbol',
  'pair',
  'market',
  'amount',
  'quantity',
  'qty',
  'volume',
  'price',
  'subtotal',
  'total',
  'fee',
  'feeamount',
  'feepaidin',
  'currency',
  'notes',
  'remarks',
  'reason',
  'income',
  'expense',
  'balance',
  'deposit',
  'withdraw',
  'senderaddress',
  'recipientaddress',
  'walletaddress',
  'blockchainhash',
  'id',
  'tds',
  // Hyperliquid abbreviated export headers
  'coin',
  'dir',
  'px',
  'sz',
  'ntl',
  'closedpnl',
  'action',
  'accountvaluechange',
  'source',
  'destination'
];

export function scoreHeaderCandidate(cells: string[]): number {
  const nonEmpty = cells.filter((c) => c !== '');
  if (nonEmpty.length < 3) return -1;

  const normalized = nonEmpty.map(normalizeHeader);
  let score = 0;
  for (const h of normalized) {
    if (KNOWN_HEADER_HINTS.some((k) => h.includes(k) || k.includes(h))) score += 3;
    if (/^[a-z_][a-z0-9_ ]{1,40}$/i.test(h)) score += 1;
    if (/\d{4}-\d{2}-\d{2}/.test(h) || /^-?\d+([.,]\d+)?$/.test(h)) score -= 2;
  }
  return score;
}

/**
 * Extract a tabular dataset from a raw matrix.
 * Scans the first `scanLimit` rows for the best header candidate.
 */
export function extractTableFromMatrix(
  matrix: string[][],
  options?: { scanLimit?: number; minHeaderScore?: number }
): ExtractedTable {
  const scanLimit = options?.scanLimit ?? 40;
  if (matrix.length === 0) {
    return { headers: [], rows: [], headerRowIndex: 0, headerScore: -1 };
  }

  let bestIdx = 0;
  let bestScore = -1;
  const limit = Math.min(matrix.length, scanLimit);
  for (let i = 0; i < limit; i++) {
    const score = scoreHeaderCandidate(matrix[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  const minScore = options?.minHeaderScore ?? 0;
  if (bestScore < minScore) {
    return { headers: [], rows: [], headerRowIndex: bestIdx, headerScore: bestScore };
  }

  // Trim trailing empty header cells so sparse Excel sheets don't create junk columns
  const headerCellsRaw = matrix[bestIdx].map((c) => cleanCell(c));
  let width = headerCellsRaw.length;
  while (width > 0 && headerCellsRaw[width - 1] === '') width -= 1;
  if (width === 0) {
    return { headers: [], rows: [], headerRowIndex: bestIdx, headerScore: bestScore };
  }

  const headerCells = headerCellsRaw.slice(0, width);
  const headers = makeUniqueHeaders(headerCells);

  const rows: Record<string, string>[] = [];
  for (let i = bestIdx + 1; i < matrix.length; i++) {
    const row = matrix[i];
    const trimmed = Array.from({ length: width }, (_, col) => cleanCell(row[col]));
    if (trimmed.every((c) => c === '')) continue;
    if (!isLikelyDataRow(trimmed)) continue;
    const obj: Record<string, string> = {};
    for (let col = 0; col < width; col++) {
      obj[headers[col]] = trimmed[col] ?? '';
    }
    rows.push(obj);
  }

  return { headers, rows, headerRowIndex: bestIdx, headerScore: bestScore };
}

/** Whether an extracted table looks like importable transaction data (not a profile/menu sheet). */
export function isUsefulTransactionTable(table: ExtractedTable, sheetName?: string): boolean {
  if (table.headers.length < 3 || table.rows.length === 0) return false;
  if (table.headerScore < 8) return false;

  const norms = table.headers.map(normalizeHeader);
  const hasDate = norms.some((h) => h.includes('date') || h.includes('time') || h.includes('timestamp'));
  const hasAmountish = norms.some((h) =>
    ['amount', 'quantity', 'qty', 'volume', 'income', 'expense', 'change', 'total', 'price', 'sz', 'ntl', 'px', 'fee', 'closedpnl'].some(
      (k) => h.includes(k)
    )
  );
  const hasAssetish = norms.some((h) =>
    ['asset', 'coin', 'symbol', 'pair', 'market', 'currency', 'token'].some((k) => h.includes(k))
  );
  const hasTypeish = norms.some((h) =>
    ['type', 'operation', 'transaction', 'side', 'reason', 'status', 'dir', 'direction', 'action'].some((k) =>
      h.includes(k)
    )
  );

  // Need a date + (amount or asset) + preferably a type column
  if (!hasDate) return false;
  if (!hasAmountish && !hasAssetish) return false;
  // Profile/menu sheets sometimes score moderately — require type OR strong amount+asset
  if (!hasTypeish && !(hasAmountish && hasAssetish)) return false;

  const name = (sheetName ?? '').toLowerCase();
  const skipNameHints = ['cover', 'profile', 'summary', 'readme', 'instructions', 'index', 'toc'];
  if (skipNameHints.some((h) => name === h || name.startsWith(h + ' '))) {
    // Still allow if the table is clearly transactional
    if (table.headerScore < 15 || table.rows.length < 3) return false;
  }

  return true;
}
