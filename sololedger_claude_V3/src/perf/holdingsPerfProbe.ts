export type HoldingsPerfPhase = 'initial' | 'live-update';

export interface HoldingsPerfResult {
  phase: HoldingsPerfPhase;
  elapsedMs: number;
  chartPrefixMs: number;
  transactionCount: number;
}

export interface HoldingsPerfProtocol {
  begin: (phase: HoldingsPerfPhase) => void;
  measureChartPrefix: <T>(callback: () => T) => T;
  completeAfterPaint: (phase: HoldingsPerfPhase, transactionCount: number) => void;
  take: (phase: HoldingsPerfPhase) => HoldingsPerfResult | undefined;
  chartPrefix: (phase: HoldingsPerfPhase) => number;
  isPending: (phase: HoldingsPerfPhase) => boolean;
}

export const HOLDINGS_PERF_RESULT_EVENT = 'sololedger:holdings-perf-result';

interface ProbeDependencies {
  now: () => number;
  requestFrame: (callback: FrameRequestCallback) => number;
  dispatch: (event: Event) => boolean;
  mark: (name: string) => void;
}

function browserDependencies(): ProbeDependencies {
  return {
    now: () => performance.now(),
    requestFrame: (callback) => requestAnimationFrame(callback),
    dispatch: (event) => window.dispatchEvent(event),
    mark: (name) => performance.mark(name)
  };
}

export function createHoldingsPerfProtocol(
  dependencies: ProbeDependencies = browserDependencies()
): HoldingsPerfProtocol {
  const starts = new Map<HoldingsPerfPhase, { at: number; generation: number }>();
  const chartMaximums = new Map<HoldingsPerfPhase, number>();
  const completing = new Set<HoldingsPerfPhase>();
  const queue: HoldingsPerfResult[] = [];
  let activePhase: HoldingsPerfPhase | undefined;
  let generation = 0;

  return {
    begin(phase) {
      generation += 1;
      starts.set(phase, { at: dependencies.now(), generation });
      chartMaximums.set(phase, 0);
      completing.delete(phase);
      activePhase = phase;
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index].phase === phase) queue.splice(index, 1);
      }
      dependencies.mark(`sololedger-holdings-${phase}-begin`);
    },

    measureChartPrefix(callback) {
      const phase = activePhase;
      if (!phase) return callback();
      const startedAt = dependencies.now();
      try {
        return callback();
      } finally {
        const elapsed = dependencies.now() - startedAt;
        chartMaximums.set(phase, Math.max(chartMaximums.get(phase) ?? 0, elapsed));
      }
    },

    completeAfterPaint(phase, transactionCount) {
      const started = starts.get(phase);
      if (!started || completing.has(phase)) return;
      completing.add(phase);
      dependencies.requestFrame(() => {
        dependencies.requestFrame(() => {
          const current = starts.get(phase);
          completing.delete(phase);
          if (!current || current.generation !== started.generation) return;
          const result: HoldingsPerfResult = {
            phase,
            elapsedMs: dependencies.now() - current.at,
            chartPrefixMs: chartMaximums.get(phase) ?? 0,
            transactionCount
          };
          starts.delete(phase);
          queue.push(result);
          dependencies.mark(`sololedger-holdings-${phase}-complete`);
          dependencies.dispatch(new CustomEvent(HOLDINGS_PERF_RESULT_EVENT, { detail: result }));
        });
      });
    },

    take(phase) {
      const index = queue.findIndex((result) => result.phase === phase);
      if (index < 0) return undefined;
      return queue.splice(index, 1)[0];
    },

    chartPrefix(phase) {
      return chartMaximums.get(phase) ?? 0;
    },

    isPending(phase) {
      return starts.has(phase);
    }
  };
}

export function installHoldingsPerfProtocol(): HoldingsPerfProtocol {
  const protocol = createHoldingsPerfProtocol();
  window.__SOLOLEDGER_HOLDINGS_PERF__ = protocol;
  return protocol;
}

export function measureHoldingsChartPrefix<T>(callback: () => T): T {
  return window.__SOLOLEDGER_HOLDINGS_PERF__?.measureChartPrefix(callback) ?? callback();
}

declare global {
  interface Window {
    __SOLOLEDGER_HOLDINGS_PERF__?: HoldingsPerfProtocol;
  }
}
