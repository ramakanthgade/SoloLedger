export type PaginationTermination = 'exhausted' | 'partial_error' | 'cursor_loop' | 'page_budget';

export interface PaginationEvidence {
  status: 'complete' | 'partial';
  paginationRequired: boolean;
  paginationExhausted: boolean;
  pages: number;
  termination: PaginationTermination;
  warning?: string;
}

export interface CursorPage<Item, Cursor> {
  items: Item[];
  nextCursor?: Cursor | null;
}

export interface SequentialCursorOptions<Item, Cursor> {
  fetchPage: (cursor: Cursor | undefined, page: number) => Promise<CursorPage<Item, Cursor>>;
  maxPages?: number;
  cursorKey?: (cursor: Cursor) => string;
  itemKey?: (item: Item) => string | undefined;
}

export interface SequentialCursorResult<Item> {
  items: Item[];
  evidence: PaginationEvidence;
}

/**
 * Collect a cursor stream one page at a time. A first-page failure is fatal so
 * callers can activate provider fallback; a later failure retains validated
 * pages and returns explicit partial-history evidence.
 */
export async function collectSequentialCursor<Item, Cursor = string>(
  options: SequentialCursorOptions<Item, Cursor>
): Promise<SequentialCursorResult<Item>> {
  const maxPages = options.maxPages ?? 100;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new Error('Pagination maxPages must be a positive integer.');
  }

  const items: Item[] = [];
  const itemKeys = new Set<string>();
  const cursorKeys = new Set<string>();
  const cursorKey = options.cursorKey ?? ((cursor: Cursor) => JSON.stringify(cursor));
  let cursor: Cursor | undefined;
  let paginationRequired = false;

  for (let page = 1; page <= maxPages; page++) {
    if (cursor !== undefined) cursorKeys.add(cursorKey(cursor));

    let result: CursorPage<Item, Cursor>;
    try {
      // Deliberately sequential: the next request is defined by this response.
      // eslint-disable-next-line no-await-in-loop
      result = await options.fetchPage(cursor, page);
    } catch (error) {
      if (page === 1) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      return {
        items,
        evidence: {
          status: 'partial', paginationRequired: true, paginationExhausted: false,
          pages: page - 1, termination: 'partial_error', warning: detail
        }
      };
    }

    for (const item of result.items) {
      const key = options.itemKey?.(item);
      if (key != null) {
        if (itemKeys.has(key)) continue;
        itemKeys.add(key);
      }
      items.push(item);
    }

    const next = result.nextCursor ?? undefined;
    if (next === undefined) {
      return {
        items,
        evidence: {
          status: 'complete', paginationRequired, paginationExhausted: true,
          pages: page, termination: 'exhausted'
        }
      };
    }
    paginationRequired = true;

    const nextKey = cursorKey(next);
    if (cursorKeys.has(nextKey) || (cursor !== undefined && nextKey === cursorKey(cursor))) {
      return {
        items,
        evidence: {
          status: 'partial', paginationRequired: true, paginationExhausted: false,
          pages: page, termination: 'cursor_loop', warning: 'Provider pagination cursor repeated.'
        }
      };
    }
    if (page === maxPages) {
      return {
        items,
        evidence: {
          status: 'partial', paginationRequired: true, paginationExhausted: false,
          pages: page, termination: 'page_budget', warning: `Pagination stopped after ${maxPages} pages.`
        }
      };
    }
    cursor = next;
  }

  // The loop always returns; this keeps the function total if it is refactored.
  throw new Error('Pagination ended unexpectedly.');
}
