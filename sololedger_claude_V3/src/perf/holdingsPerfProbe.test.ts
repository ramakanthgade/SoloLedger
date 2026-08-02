import { describe, expect, it, vi } from 'vitest';
import {
  HOLDINGS_PERF_RESULT_EVENT,
  createHoldingsPerfProtocol,
  type HoldingsPerfResult
} from './holdingsPerfProbe';

function harness() {
  let now = 0;
  const frames: FrameRequestCallback[] = [];
  const dispatchedEvents: Event[] = [];
  const dispatch = vi.fn((event: Event) => {
    dispatchedEvents.push(event);
    return true;
  });
  const mark = vi.fn();
  const protocol = createHoldingsPerfProtocol({
    now: () => now,
    requestFrame: (callback) => frames.push(callback),
    dispatch,
    mark
  });
  return {
    protocol,
    dispatch,
    dispatchedEvents,
    mark,
    advance: (duration: number) => { now += duration; },
    flushFrame: () => frames.shift()?.(now)
  };
}

describe('holdings performance protocol', () => {
  it('resets a phase and retains the slowest chart-prefix measurement', () => {
    const test = harness();
    test.protocol.begin('initial');
    test.protocol.measureChartPrefix(() => test.advance(7));
    test.protocol.measureChartPrefix(() => test.advance(12));
    test.protocol.begin('initial');
    test.protocol.measureChartPrefix(() => test.advance(5));
    test.advance(20);
    test.protocol.completeAfterPaint('initial', 30_000);
    test.flushFrame();
    test.flushFrame();

    expect(test.protocol.take('initial')).toEqual({
      phase: 'initial', elapsedMs: 25, chartPrefixMs: 5, transactionCount: 30_000
    });
    expect(test.protocol.take('initial')).toBeUndefined();
  });

  it('completes after two animation frames and dispatches the diagnostic event', () => {
    const test = harness();
    test.protocol.begin('live-update');
    test.advance(8);
    test.protocol.completeAfterPaint('live-update', 30_001);
    test.flushFrame();
    expect(test.protocol.take('live-update')).toBeUndefined();
    test.advance(2);
    test.flushFrame();
    test.protocol.measureChartPrefix(() => test.advance(4));

    const result = test.protocol.take('live-update');
    expect(result).toEqual({
      phase: 'live-update', elapsedMs: 10, chartPrefixMs: 0, transactionCount: 30_001
    });
    const event = test.dispatchedEvents[0] as CustomEvent<HoldingsPerfResult>;
    expect(event.type).toBe(HOLDINGS_PERF_RESULT_EVENT);
    expect(event.detail).toEqual(result);
    expect(test.protocol.chartPrefix('live-update')).toBe(4);
    expect(test.mark).toHaveBeenCalledWith('sololedger-holdings-live-update-complete');
  });

  it('ignores a stale completion scheduled before a phase reset', () => {
    const test = harness();
    test.protocol.begin('initial');
    test.protocol.completeAfterPaint('initial', 30_000);
    test.protocol.begin('initial');
    test.flushFrame();
    test.flushFrame();
    expect(test.protocol.take('initial')).toBeUndefined();
    expect(test.protocol.isPending('initial')).toBe(true);
  });
});
