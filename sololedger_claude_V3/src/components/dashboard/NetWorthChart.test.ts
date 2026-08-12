import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { chartTimelineTicks } from './dashboardChartTimeline';
import { NetWorthChart } from './NetWorthChart';

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

describe('NetWorthChart privacy and point evidence', () => {
  const points = [
    { t: Date.UTC(2026, 7, 11, 18, 30), market: 300, cost: 100, unpricedCount: 0 },
    { t: Date.UTC(2026, 7, 11, 19, 30), market: 400, cost: 200, unpricedCount: 0 }
  ];

  it('uses jurisdiction-local point dates and the point-specific cost in its tooltip', () => {
    render(createElement(NetWorthChart, { points, mode: 'market', currency: 'INR', jurisdiction: 'IN' }));
    const svg = screen.getByRole('img');
    expect(svg).toHaveAttribute('aria-label', expect.not.stringMatching(/Aug|2026|–/));
    const hoverSurface = svg.parentElement as HTMLElement;
    hoverSurface.getBoundingClientRect = () => ({
      x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 240, width: 100, height: 240,
      toJSON: () => ({})
    });
    fireEvent.mouseMove(hoverSurface, { clientX: 100 });
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent('Aug 12, 2026');
    expect(screen.getByTestId('chart-tooltip')).toHaveTextContent('Cost basis ₹200.00');
  });

  it('removes value-derived paths and tooltips in privacy mode', () => {
    render(createElement(NetWorthChart, { points, mode: 'market', currency: 'INR', jurisdiction: 'IN', mask: true }));
    const chart = screen.getByTestId('net-worth-chart');
    expect(chart.querySelectorAll('svg path')).toHaveLength(0);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'Net worth history chart hidden for privacy.');
    expect(screen.queryByTestId('chart-tooltip')).not.toBeInTheDocument();
  });
});
