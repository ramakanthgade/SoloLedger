import { describe, expect, it } from 'vitest';
import { buildPostingPerformanceFixtures, runPostingPerformanceScenario } from './postingBalances.performanceFixture';

describe('posting projection isolated performance gate', () => {
  it('keeps realistic 30k projection/index/reconciliation p95 within 250 ms', () => {
    const fixtures = buildPostingPerformanceFixtures();
    const run = () => {
      const started = performance.now();
      runPostingPerformanceScenario(fixtures);
      return performance.now() - started;
    };
    run();
    const measures = Array.from({ length: 5 }, run).sort((a, b) => a - b);
    expect(measures[4]).toBeLessThan(250);
  });
});
