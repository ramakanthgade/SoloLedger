import { describe, expect, it } from 'vitest';
import { chartTimelineTicks } from './dashboardChartTimeline';

describe('chartTimelineTicks', () => {
  it('keeps every month in a Jan–Dec custom-range domain without transaction anchors', () => {
    const ticks = chartTimelineTicks(
      Date.UTC(2025, 0, 1) - (5.5 * 60 * 60_000),
      Date.UTC(2026, 0, 1) - (5.5 * 60 * 60_000) - 1,
      'IN'
    );

    expect(ticks.map((tick) => tick.label)).toEqual([
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ]);
    expect(ticks[8].frac).toBeGreaterThan(ticks[7].frac);
    expect(ticks[11].frac).toBeGreaterThan(ticks[10].frac);
  });

  it('uses local civil month boundaries outside India, including negative UTC offsets', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const ticks = chartTimelineTicks(
        new Date(2025, 0, 1).getTime(),
        new Date(2026, 0, 1).getTime() - 1,
        'US'
      );
      expect(ticks.map((tick) => tick.label)).toEqual([
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
      ]);
    } finally {
      process.env.TZ = previous;
    }
  });

  it('formats short-range weekly ticks in the local civil calendar', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'America/Los_Angeles';
    try {
      const ticks = chartTimelineTicks(
        new Date(2025, 0, 1).getTime(),
        new Date(2025, 0, 31, 23, 59, 59, 999).getTime(),
        'US'
      );
      for (const tick of ticks) {
        const instant = new Date(
          new Date(2025, 0, 1).getTime() + tick.frac * (
            new Date(2025, 0, 31, 23, 59, 59, 999).getTime() - new Date(2025, 0, 1).getTime()
          )
        );
        expect(tick.label).toBe(`Jan ${instant.getDate()}`);
      }
    } finally {
      process.env.TZ = previous;
    }
  });
});
