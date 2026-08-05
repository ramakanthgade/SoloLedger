import { describe, expect, it, vi } from 'vitest';
import { collectSequentialCursor } from './pagination';

describe('collectSequentialCursor', () => {
  it('collects sequential pages through exhaustion and deduplicates item identity', async () => {
    const fetchPage = vi.fn(async (cursor?: string) => cursor == null
      ? { items: [{ id: 'a' }, { id: 'b' }], nextCursor: 'next' }
      : { items: [{ id: 'b' }, { id: 'c' }] });

    const result = await collectSequentialCursor({ fetchPage, itemKey: (item) => item.id });

    expect(fetchPage.mock.calls).toEqual([[undefined, 1], ['next', 2]]);
    expect(result.items.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(result.evidence).toEqual({
      status: 'complete', paginationRequired: true, paginationExhausted: true,
      pages: 2, termination: 'exhausted'
    });
  });

  it('retains validated pages and records a later-page failure as partial', async () => {
    const result = await collectSequentialCursor({
      fetchPage: async (cursor?: string) => {
        if (cursor) throw new Error('upstream unavailable');
        return { items: [1], nextCursor: 'next' };
      }
    });

    expect(result.items).toEqual([1]);
    expect(result.evidence).toMatchObject({
      status: 'partial', paginationExhausted: false, pages: 1,
      termination: 'partial_error', warning: 'upstream unavailable'
    });
  });

  it('throws a first-page failure', async () => {
    await expect(collectSequentialCursor({
      fetchPage: async () => { throw new Error('first page failed'); }
    })).rejects.toThrow('first page failed');
  });

  it('stops repeated cursors with loop evidence', async () => {
    const result = await collectSequentialCursor({
      fetchPage: async () => ({ items: [1], nextCursor: 'same' })
    });

    expect(result.items).toEqual([1, 1]);
    expect(result.evidence).toMatchObject({
      status: 'partial', pages: 2, termination: 'cursor_loop', paginationExhausted: false
    });
  });

  it('stops before requesting beyond the page budget', async () => {
    const fetchPage = vi.fn(async (_cursor?: number, page?: number) => ({
      items: [page], nextCursor: page
    }));
    const result = await collectSequentialCursor({ fetchPage, maxPages: 2 });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(result.items).toEqual([1, 2]);
    expect(result.evidence).toMatchObject({
      status: 'partial', pages: 2, termination: 'page_budget', paginationExhausted: false
    });
  });
});
