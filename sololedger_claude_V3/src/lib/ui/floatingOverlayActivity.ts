let bulkActionsActive = false;
const listeners = new Set<() => void>();

export function setBulkActionsActive(active: boolean): void {
  if (bulkActionsActive === active) return;
  bulkActionsActive = active;
  for (const listener of listeners) listener();
}

export function getBulkActionsActive(): boolean { return bulkActionsActive; }
export function subscribeBulkActionsActive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
