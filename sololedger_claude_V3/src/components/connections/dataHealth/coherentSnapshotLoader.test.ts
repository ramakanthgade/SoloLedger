import { describe, expect, it, vi } from 'vitest';
import { CoherentSnapshotLoader } from './coherentSnapshotLoader';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('CoherentSnapshotLoader', () => {
  it('starts closed reads only from the post-paint callback and coalesces invalidations', async () => {
    const callbacks: Array<() => void> = [];
    const cancelled = new Set<number>();
    const schedule = vi.fn((callback: () => void) => {
      const index = callbacks.length;
      callbacks.push(() => { if (!cancelled.has(index)) callback(); });
      return () => { cancelled.add(index); };
    });
    const read = vi.fn(async () => 'coherent');
    const complete = vi.fn();
    const loader = new CoherentSnapshotLoader(read, schedule, complete);

    loader.invalidate('revision-1', false);
    loader.invalidate('revision-2', false);
    expect(read).not.toHaveBeenCalled();
    expect(cancelled).toEqual(new Set([0]));

    callbacks[0]();
    expect(read).not.toHaveBeenCalled();
    callbacks[1]();
    expect(read).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(complete).toHaveBeenCalledWith({ revision: 'revision-2', snapshot: 'coherent' });
  });

  it('forces the latest read immediately on open and ignores stale async completion', async () => {
    const callbacks: Array<() => void> = [];
    const reads = [deferred<string>(), deferred<string>()];
    const read = vi.fn(() => reads[read.mock.calls.length - 1].promise);
    const complete = vi.fn();
    const loader = new CoherentSnapshotLoader(read, (callback) => {
      callbacks.push(callback);
      return vi.fn();
    }, complete);

    loader.invalidate('closed', false);
    callbacks[0]();
    expect(read).toHaveBeenCalledTimes(1);
    loader.invalidate('opened-latest', true);
    expect(read).toHaveBeenCalledTimes(1);

    reads[0].resolve('stale');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(complete).not.toHaveBeenCalled();
    reads[1].resolve('latest');
    await Promise.resolve();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith({ revision: 'opened-latest', snapshot: 'latest' });
  });

  it('serializes open invalidations into one in-flight read and one latest follow-up', async () => {
    const reads = [deferred<string>(), deferred<string>()];
    const read = vi.fn(() => reads[read.mock.calls.length - 1].promise);
    const complete = vi.fn();
    const loader = new CoherentSnapshotLoader(read, () => vi.fn(), complete);

    loader.invalidate('open-1', true);
    loader.invalidate('open-2', true);
    loader.invalidate('open-latest', true);
    expect(read).toHaveBeenCalledTimes(1);

    reads[0].resolve('superseded');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(complete).not.toHaveBeenCalled();

    reads[1].resolve('latest');
    await Promise.resolve();
    expect(complete).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledWith({ revision: 'open-latest', snapshot: 'latest' });
  });

  it('cancels a closed idle request and starts immediately when opened', async () => {
    const scheduled: Array<() => void> = [];
    const cancel = vi.fn();
    const read = vi.fn(async () => 'opened');
    const complete = vi.fn();
    const loader = new CoherentSnapshotLoader(read, (callback) => {
      scheduled.push(callback);
      return cancel;
    }, complete);

    loader.invalidate('closed', false);
    expect(read).not.toHaveBeenCalled();
    loader.invalidate('opened', true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    scheduled[0]();
    expect(read).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(complete).toHaveBeenCalledWith({ revision: 'opened', snapshot: 'opened' });
  });
});
