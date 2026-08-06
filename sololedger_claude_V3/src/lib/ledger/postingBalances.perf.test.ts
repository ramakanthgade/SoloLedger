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
    // Twenty samples make nearest-rank p95 distinct from the single slowest
    // sample, so an unrelated scheduler/GC pause does not turn this into a p100 gate.
    const measures = Array.from({ length: 20 }, run).sort((a, b) => a - b);
    const p95 = measures[Math.ceil(measures.length * 0.95) - 1];
    expect(p95).toBeLessThan(250);
  });
});
