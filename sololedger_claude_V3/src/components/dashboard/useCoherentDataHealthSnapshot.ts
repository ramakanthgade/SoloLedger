import { useEffect, useMemo, useRef, useState } from 'react';
import { readDataHealthSnapshot, type DataHealthSnapshot } from './dataHealthSnapshot';
import {
  CoherentSnapshotLoader,
  type CoherentSnapshotCompletion,
  type ScheduleCoherentRead
} from './coherentSnapshotLoader';

export function scheduleAfterPaint(callback: () => void): () => void {
  let secondFrame = 0;
  let timer = 0;
  const firstFrame = requestAnimationFrame(() => {
    secondFrame = requestAnimationFrame(() => {
      timer = window.setTimeout(callback, 0);
    });
  });
  return () => {
    cancelAnimationFrame(firstFrame);
    if (secondFrame) cancelAnimationFrame(secondFrame);
    if (timer) window.clearTimeout(timer);
  };
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
  } = {}
): { snapshot?: DataHealthSnapshot; updating: boolean } {
  const previousOpen = useRef(false);
  const openToken = useMemo(() => ({}), [workspaceOpen]);
  const requiredRevision = useMemo(() => ({
    signal: invalidationSignal,
    openToken: workspaceOpen ? openToken : undefined
  }), [invalidationSignal, openToken]);
  const [completion, setCompletion] = useState<CoherentSnapshotCompletion<typeof requiredRevision, DataHealthSnapshot>>();
  const loaderRef = useRef<CoherentSnapshotLoader<typeof requiredRevision, DataHealthSnapshot>>();
  const read = dependencies.read ?? readDataHealthSnapshot;
  const schedule = dependencies.schedule ?? scheduleAfterPaint;
  const onCompletion = dependencies.onCompletion;

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
      loader.invalidate(requiredRevision, workspaceOpen);
    }
  }, [completion, invalidationSignal, requiredRevision, workspaceOpen]);

  return {
    snapshot: completion?.snapshot,
    updating: completion == null || completion.revision.signal !== invalidationSignal ||
      (workspaceOpen && completion.revision.openToken !== requiredRevision.openToken)
  };
}
