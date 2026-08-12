import { describe, expect, it, vi } from 'vitest';
import { coherentWorkspaceTransition, scheduleWhenIdle } from './useCoherentDataHealthSnapshot';

describe('coherent workspace transition', () => {
  it('forces false-to-true once and treats true-to-false as no read revision', () => {
    const opened = coherentWorkspaceTransition(false, 0, true);
    expect(opened).toEqual({ opening: true, openGeneration: 1 });

    const remainedOpen = coherentWorkspaceTransition(true, opened.openGeneration, true);
    expect(remainedOpen).toEqual({ opening: false, openGeneration: 1 });

    const closed = coherentWorkspaceTransition(true, remainedOpen.openGeneration, false);
    expect(closed).toEqual({ opening: false, openGeneration: 1 });
  });
});

describe('idle coherent scheduling', () => {
  it('uses cancelable requestIdleCallback rather than animation frames', () => {
    const originalRequestIdleCallback = window.requestIdleCallback;
    const originalCancelIdleCallback = window.cancelIdleCallback;
    const callback = vi.fn();
    const requestIdleCallback = vi.fn(() => 73);
    const cancelIdleCallback = vi.fn();
    window.requestIdleCallback = requestIdleCallback;
    window.cancelIdleCallback = cancelIdleCallback;
    try {
      const cancel = scheduleWhenIdle(callback);
      expect(requestIdleCallback).toHaveBeenCalledWith(callback, { timeout: 2_500 });
      expect(callback).not.toHaveBeenCalled();
      cancel();
      expect(cancelIdleCallback).toHaveBeenCalledWith(73);
    } finally {
      window.requestIdleCallback = originalRequestIdleCallback;
      window.cancelIdleCallback = originalCancelIdleCallback;
    }
  });

  it('has a bounded cancelable timeout fallback', () => {
    const originalRequestIdleCallback = window.requestIdleCallback;
    window.requestIdleCallback = undefined as unknown as typeof window.requestIdleCallback;
    vi.useFakeTimers();
    try {
      const callback = vi.fn();
      const cancel = scheduleWhenIdle(callback);
      vi.advanceTimersByTime(999);
      expect(callback).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(callback).toHaveBeenCalledOnce();
      cancel();
    } finally {
      vi.useRealTimers();
      window.requestIdleCallback = originalRequestIdleCallback;
    }
  });
});
