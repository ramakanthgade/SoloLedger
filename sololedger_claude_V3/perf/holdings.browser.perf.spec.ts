import { expect, test, type Page } from '@playwright/test';

type Phase = 'initial' | 'live-update';
interface PerfResult {
  phase: Phase;
  elapsedMs: number;
  chartPrefixMs: number;
  transactionCount: number;
}

const MEASURED_SAMPLE_COUNT = 5;
const CHART_PREFIX_SAMPLE_COUNT = 20;
const INITIAL_BUDGET_MS = 1_500;
const LIVE_UPDATE_BUDGET_MS = 300;
const CHART_PREFIX_BUDGET_MS = 50;

async function takeResult(page: Page, phase: Phase): Promise<PerfResult> {
  await page.waitForFunction(() => Boolean(window.__SOLOLEDGER_HOLDINGS_PERF__), null, {
    timeout: 10_000
  });
  return page.evaluate(({ requestedPhase, eventName }) => new Promise<PerfResult>((resolve, reject) => {
    const protocol = window.__SOLOLEDGER_HOLDINGS_PERF__;
    if (!protocol) {
      reject(new Error('Holdings performance protocol was not installed'));
      return;
    }
    const take = () => {
      const result = protocol.take(requestedPhase);
      if (!result) return false;
      resolve(result);
      return true;
    };
    if (take()) return;
    const timeout = window.setTimeout(() => {
      window.removeEventListener(eventName, listener);
      reject(new Error(`Timed out waiting for ${requestedPhase} performance completion`));
    }, 10_000);
    const listener = () => {
      if (!take()) return;
      window.clearTimeout(timeout);
      window.removeEventListener(eventName, listener);
    };
    window.addEventListener(eventName, listener);
  }), { requestedPhase: phase, eventName: 'sololedger:holdings-perf-result' });
}

function sorted(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right);
}

function nearestRankPercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) throw new Error('Cannot calculate a percentile without samples');
  return sortedValues[Math.ceil(sortedValues.length * percentile) - 1];
}

async function numericAttribute(page: Page, testId: string, attribute: string): Promise<number> {
  const value = await page.getByTestId(testId).getAttribute(attribute);
  if (value == null || !Number.isFinite(Number(value))) {
    throw new Error(`${testId} is missing numeric ${attribute}: ${String(value)}`);
  }
  return Number(value);
}

test('real Dashboard holdings stays within the Chromium performance budgets', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === 'http://127.0.0.1:4183' || url.protocol === 'data:' || url.protocol === 'blob:') {
      await route.continue();
      return;
    }
    await route.abort('blockedbyclient');
  });

  const initialSamples: number[] = [];
  const liveUpdateSamples: number[] = [];
  const chartPrefixSamples: number[] = [];

  for (let iteration = 0; iteration <= CHART_PREFIX_SAMPLE_COUNT; iteration += 1) {
    await page.goto(`/holdings-perf.html?mode=seed&iteration=${iteration}`);
    const seedReady = page.getByTestId('holdings-perf-seed-ready');
    await expect(seedReady).toHaveAttribute('data-transaction-count', '30000', { timeout: 30_000 });

    await page.goto('/holdings-perf.html?mode=run');
    const initial = await takeResult(page, 'initial');
    expect(initial.transactionCount).toBe(30_000);
    const holdingsGeneration = page.getByTestId('dashboard-holdings-generation');
    const deferredGeneration = page.getByTestId('dashboard-deferred-generation');
    await expect(holdingsGeneration).toHaveAttribute('data-transaction-count', '30000');
    await expect(holdingsGeneration).toHaveAttribute('data-btc-quantity', '15000');
    await expect(deferredGeneration).toHaveAttribute('data-transaction-count', '30000', {
      timeout: 10_000
    });
    await expect(page.getByTestId('dashboard-holdings')).toBeVisible();
    await expect(page.getByTestId('net-worth-chart')).toBeVisible();
    const initialChartRevision = await deferredGeneration.getAttribute('data-chart-revision');
    const initialChartPointCount = await numericAttribute(
      page, 'dashboard-deferred-generation', 'data-chart-point-count'
    );
    const initialChartEnd = await numericAttribute(
      page, 'dashboard-deferred-generation', 'data-chart-end-t'
    );
    const initialChartCost = await numericAttribute(
      page, 'dashboard-deferred-generation', 'data-chart-end-cost'
    );
    expect(initialChartRevision).toBeTruthy();
    expect(initialChartPointCount).toBeGreaterThan(0);

    await page.evaluate((sampleId) => {
      if (!window.appendLiveUpdate) throw new Error('appendLiveUpdate hook is missing');
      return window.appendLiveUpdate(sampleId);
    }, iteration);
    const liveUpdate = await takeResult(page, 'live-update');
    expect(liveUpdate.transactionCount).toBe(30_001);
    await expect(holdingsGeneration).toHaveAttribute('data-transaction-count', '30001');
    await expect(holdingsGeneration).toHaveAttribute('data-btc-quantity', '15001');
    // Historical chart/FIFO/tax work is intentionally outside the urgent
    // budget, but it must commit a new series-derived endpoint within a
    // separate generous correctness timeout; stale chart DOM cannot pass.
    await expect(deferredGeneration).toHaveAttribute('data-transaction-count', '30001', {
      timeout: 10_000
    });
    await expect(deferredGeneration).not.toHaveAttribute(
      'data-chart-revision', initialChartRevision!, { timeout: 10_000 }
    );
    expect(await numericAttribute(page, 'dashboard-deferred-generation', 'data-chart-point-count'))
      .toBe(initialChartPointCount);
    expect(await numericAttribute(page, 'dashboard-deferred-generation', 'data-chart-end-t'))
      .toBe(initialChartEnd);
    expect(await numericAttribute(page, 'dashboard-deferred-generation', 'data-chart-end-cost'))
      .toBe(initialChartCost + 5_000_000);
    await expect(page.getByTestId('net-worth-chart')).toBeVisible();

    const chartPrefix = await page.evaluate(() => {
      const protocol = window.__SOLOLEDGER_HOLDINGS_PERF__;
      if (!protocol) throw new Error('Holdings performance protocol was not installed');
      return Math.max(protocol.chartPrefix('initial'), protocol.chartPrefix('live-update'));
    });

    if (iteration === 0) continue;
    if (iteration <= MEASURED_SAMPLE_COUNT) {
      initialSamples.push(initial.elapsedMs);
      liveUpdateSamples.push(liveUpdate.elapsedMs);
    }
    chartPrefixSamples.push(chartPrefix);
  }

  expect(initialSamples).toHaveLength(MEASURED_SAMPLE_COUNT);
  expect(liveUpdateSamples).toHaveLength(MEASURED_SAMPLE_COUNT);
  expect(chartPrefixSamples).toHaveLength(CHART_PREFIX_SAMPLE_COUNT);

  const initialReport = sorted(initialSamples);
  const liveUpdateReport = sorted(liveUpdateSamples);
  const chartPrefixReport = sorted(chartPrefixSamples);
  console.log(`Holdings initial projection/paint samples (ms): ${initialReport.join(', ')}`);
  console.log(`Holdings live-update/paint samples (ms): ${liveUpdateReport.join(', ')}`);
  console.log(`Holdings chart-prefix samples (ms): ${chartPrefixReport.join(', ')}`);

  expect(initialReport.at(-1)!, `initial samples (ms): ${initialReport.join(', ')}`)
    .toBeLessThan(INITIAL_BUDGET_MS);
  expect(liveUpdateReport.at(-1)!, `live-update samples (ms): ${liveUpdateReport.join(', ')}`)
    .toBeLessThan(LIVE_UPDATE_BUDGET_MS);
  // A five-sample nearest-rank p95 is still the maximum, so one unrelated
  // scheduler/GC pause makes that contract p100. Twenty measured samples
  // preserve the 50 ms p95 budget while allowing only the slowest sample to
  // remain diagnostic noise.
  expect(
    nearestRankPercentile(chartPrefixReport, 0.95),
    `chart-prefix samples (ms): ${chartPrefixReport.join(', ')}`
  )
    .toBeLessThan(CHART_PREFIX_BUDGET_MS);

  await context.close();
});

declare global {
  interface Window {
    __SOLOLEDGER_HOLDINGS_PERF__?: {
      take: (phase: Phase) => PerfResult | undefined;
      chartPrefix: (phase: Phase) => number;
    };
    appendLiveUpdate?: (sampleId: number) => Promise<void>;
  }
}
