import { describe, it, expect } from 'vitest';
import { groupRowsByDate, formatGroupDateLabel, pageNumberList } from './reviewListUtils';

const day = (iso: string, h = 12) => new Date(`${iso}T${String(h).padStart(2, '0')}:00:00Z`).getTime();

describe('groupRowsByDate', () => {
  it('groups adjacent rows sharing a UTC day, preserving order', () => {
    const rows = [
      { timestamp: day('2026-07-22', 14) },
      { timestamp: day('2026-07-22', 6) },
      { timestamp: day('2026-07-21', 18) },
      { timestamp: day('2026-07-20', 7) },
      { timestamp: day('2026-07-20', 1) }
    ];
    const groups = groupRowsByDate(rows);
    expect(groups.map((g) => g.key)).toEqual(['2026-07-22', '2026-07-21', '2026-07-20']);
    expect(groups.map((g) => g.rows.length)).toEqual([2, 1, 2]);
    // Order inside a group is the caller's order (newest first here).
    expect(groups[0].rows[0].timestamp).toBe(day('2026-07-22', 14));
  });

  it('does not merge non-adjacent days (ascending sort gets its own groups)', () => {
    const rows = [{ timestamp: day('2026-07-20') }, { timestamp: day('2026-07-21') }, { timestamp: day('2026-07-20') }];
    expect(groupRowsByDate(rows).map((g) => g.key)).toEqual(['2026-07-20', '2026-07-21', '2026-07-20']);
  });

  it('returns an empty list for no rows', () => {
    expect(groupRowsByDate([])).toEqual([]);
  });
});

describe('formatGroupDateLabel', () => {
  it('formats the UTC day key in the mockup style', () => {
    expect(formatGroupDateLabel('2026-07-22')).toBe('Jul 22, 2026');
  });
});

describe('pageNumberList', () => {
  it('returns [] when there are no pages', () => {
    expect(pageNumberList(1, 0)).toEqual([]);
  });

  it('expands fully when total ≤ 7', () => {
    expect(pageNumberList(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageNumberList(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('windows around the current page with ellipses for long lists', () => {
    expect(pageNumberList(5, 42)).toEqual([1, '…', 4, 5, 6, '…', 42]);
  });

  it('keeps the first pages without a leading ellipsis near the start', () => {
    expect(pageNumberList(2, 42)).toEqual([1, 2, 3, '…', 42]);
    expect(pageNumberList(1, 42)).toEqual([1, 2, '…', 42]);
  });

  it('keeps the last pages without a trailing ellipsis near the end', () => {
    expect(pageNumberList(41, 42)).toEqual([1, '…', 40, 41, 42]);
    expect(pageNumberList(42, 42)).toEqual([1, '…', 41, 42]);
  });

  it('never duplicates page numbers and never emits out-of-range pages', () => {
    for (const [current, total] of [[1, 8], [7, 8], [8, 8], [4, 9]] as const) {
      const pages = pageNumberList(current, total);
      const nums = pages.filter((p): p is number => p !== '…');
      expect(new Set(nums).size).toBe(nums.length);
      expect(nums.every((p) => p >= 1 && p <= total)).toBe(true);
    }
  });
});
