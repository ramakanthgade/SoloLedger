/**
 * Multi-sheet Excel (.xlsx / .xls) reader → per-sheet string matrices.
 * Uses SheetJS (xlsx). CSV files are handled separately as a single "sheet".
 */
import { cleanCell } from './tableExtract';

export interface WorkbookSheet {
  sheetName: string;
  sheetIndex: number;
  /** Dense string matrix (rows × cols), cells trimmed. */
  matrix: string[][];
}

export function isSpreadsheetFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return (
    name.endsWith('.xlsx') ||
    name.endsWith('.xls') ||
    name.endsWith('.xlsm') ||
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    file.type === 'application/vnd.ms-excel'
  );
}

export function isCsvLikeFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.csv') || name.endsWith('.txt') || file.type === 'text/csv' || file.type === 'text/plain';
}

/** Read all sheets from an Excel workbook into string matrices. */
export async function readWorkbookSheets(file: File): Promise<WorkbookSheet[]> {
  // Lazy-load the heavy SheetJS bundle only when a spreadsheet is imported.
  const XLSX = await import('xlsx');
  const buf = await file.arrayBuffer();
  const workbook = XLSX.read(buf, {
    type: 'array',
    cellDates: false,
    cellNF: false,
    cellText: true,
    raw: false
  });

  const sheets: WorkbookSheet[] = [];
  workbook.SheetNames.forEach((sheetName, sheetIndex) => {
    const ws = workbook.Sheets[sheetName];
    if (!ws) return;
    // defval: '' keeps empty cells so column indices stay aligned
    const aoa = XLSX.utils.sheet_to_json<string[]>(ws, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false
    });
    const matrix = aoa.map((row) => {
      const arr = Array.isArray(row) ? row : [];
      return arr.map((c) => cleanCell(c == null ? '' : String(c)));
    });
    sheets.push({ sheetName, sheetIndex, matrix });
  });

  return sheets;
}
