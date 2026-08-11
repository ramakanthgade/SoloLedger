import { useEffect, useMemo, useRef, useState } from 'react';
import { readDataHealthSnapshot, type DataHealthSnapshot } from './dataHealthSnapshot';
import {
  CoherentSnapshotLoader,
  type CoherentSnapshotCompletion,
  type ScheduleCoherentRead
} from './coherentSnapshotLoader';

const IDLE_TIMEOUT_MS = 2_500;
const IDLE_FALLBACK_MS = 1_000;

export function scheduleWhenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(id);
  }
  const timer = window.setTimeout(callback, IDLE_FALLBACK_MS);
  return () => window.clearTimeout(timer);
}

export function coherentWorkspaceTransition(
  previousOpen: boolean,
  openGeneration: number,
  workspaceOpen: boolean
): { opening: boolean; openGeneration: number } {
  const opening = workspaceOpen && !previousOpen;
  return { opening, openGeneration: opening ? openGeneration + 1 : openGeneration };
}

export function useCoherentDataHealthSnapshot(
  invalidationSignal: unknown,
  workspaceOpen: boolean,
  dependencies: {
    read?: () => Promise<DataHealthSnapshot>;
    schedule?: ScheduleCoherentRead;
    onCompletion?: (completion: CoherentSnapshotCompletion<unknown, DataHealthSnapshot>) => void;
    closedReadReady?: boolean;
  } = {}
): { snapshot?: DataHealthSnapshot; updating: boolean } {
  const previousOpen = useRef(false);
  const openToken = useMemo(() => workspaceOpen ? {} : undefined, [workspaceOpen]);
  const requiredRevision = useMemo(() => ({
    signal: invalidationSignal,
    openToken
  }), [invalidationSignal, openToken]);
  const [completion, setCompletion] = useState<CoherentSnapshotCompletion<typeof requiredRevision, DataHealthSnapshot>>();
  const loaderRef = useRef<CoherentSnapshotLoader<typeof requiredRevision, DataHealthSnapshot>>();
  const read = dependencies.read ?? readDataHealthSnapshot;
  const schedule = dependencies.schedule ?? scheduleWhenIdle;
  const onCompletion = dependencies.onCompletion;
  const closedReadReady = dependencies.closedReadReady ?? true;

  // Loader ownership follows the effect lifecycle rather than render memo
  // lifetime. React StrictMode's setup→cleanup→setup cycle therefore creates
  // a fresh live loader after disposing the first instance.
  useEffect(() => {
    const loader = new CoherentSnapshotLoader<typeof requiredRevision, DataHealthSnapshot>(
      read,
      schedule,
      (next) => {
        onCompletion?.(next);
        setCompletion(next);
      }
    );
    loaderRef.current = loader;
    return () => {
      loader.dispose();
      if (loaderRef.current === loader) loaderRef.current = undefined;
      previousOpen.current = false;
    };
  }, [onCompletion, read, schedule]);

  useEffect(() => {
    const loader = loaderRef.current;
    if (!loader) return;
    const wasOpen = previousOpen.current;
    const transition = coherentWorkspaceTransition(wasOpen, 0, workspaceOpen);
    previousOpen.current = workspaceOpen;
    const signalChanged = completion?.revision.signal !== invalidationSignal;
    if (wasOpen && !workspaceOpen && !signalChanged) {
      // Closing retains the last completed coherent snapshot and schedules no read.
      return;
    }
    const opening = transition.opening;
    if (opening || signalChanged || completion == null) {
      if (!workspaceOpen && !closedReadReady) return;
      loader.invalidate(requiredRevision, workspaceOpen);
    }
  }, [closedReadReady, completion, invalidationSignal, requiredRevision, workspaceOpen]);

  return {
    snapshot: completion?.snapshot,
    updating: completion == null || completion.revision.signal !== invalidationSignal ||
      (workspaceOpen && completion.revision.openToken !== requiredRevision.openToken)
  };
}
