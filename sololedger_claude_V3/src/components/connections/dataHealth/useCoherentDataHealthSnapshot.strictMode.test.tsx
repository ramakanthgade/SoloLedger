import { StrictMode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DataHealthSnapshot } from './dataHealthSnapshot';
import { useCoherentDataHealthSnapshot } from './useCoherentDataHealthSnapshot';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const snapshot = (id: string) => ({
  transactions: [{ id }], wallets: [], csvImports: [], exchangeConnections: [],
  authoritySnapshots: [], authorityAssets: [], sourceCoverage: [], openingBalances: []
}) as unknown as DataHealthSnapshot;

describe('useCoherentDataHealthSnapshot StrictMode lifecycle', () => {
  it('recreates after setup-cleanup-setup, updates, and ignores completion after unmount', async () => {
    const reads = Array.from({ length: 4 }, () => deferred<DataHealthSnapshot>());
    const read = vi.fn(() => reads[read.mock.calls.length - 1].promise);
    const onCompletion = vi.fn();
    const dependencies = { read, schedule: (callback: () => void) => { callback(); return vi.fn(); }, onCompletion };
    const wrapper = ({ children }: { children: React.ReactNode }) => <StrictMode>{children}</StrictMode>;
    const hook = renderHook(
      ({ signal }) => useCoherentDataHealthSnapshot(signal, true, dependencies),
      { initialProps: { signal: 'first' }, wrapper }
    );

    expect(read).toHaveBeenCalledTimes(2);
    reads[0].resolve(snapshot('disposed-first'));
    reads[1].resolve(snapshot('strict-live'));
    await act(async () => { await Promise.all([reads[0].promise, reads[1].promise]); });
    expect(onCompletion).toHaveBeenCalledTimes(1);
    expect(hook.result.current.snapshot?.transactions[0].id).toBe('strict-live');

    hook.rerender({ signal: 'updated' });
    expect(read).toHaveBeenCalledTimes(3);
    reads[2].resolve(snapshot('updated-live'));
    await act(async () => { await reads[2].promise; });
    expect(hook.result.current.snapshot?.transactions[0].id).toBe('updated-live');

    hook.rerender({ signal: 'unmount-pending' });
    expect(read).toHaveBeenCalledTimes(4);
    hook.unmount();
    reads[3].resolve(snapshot('must-be-ignored'));
    await act(async () => { await reads[3].promise; });
    expect(onCompletion).toHaveBeenCalledTimes(2);
  });
});
