/** Tracks whether this browser session has used price lookup or wallet import (not settings toggles). */

type Listener = () => void;
const listeners = new Set<Listener>();
let networkUsedThisSession = false;

function notify(): void {
  listeners.forEach((l) => l());
}

export function recordNetworkActivity(): void {
  if (networkUsedThisSession) return;
  networkUsedThisSession = true;
  notify();
}

export function hasUsedNetworkThisSession(): boolean {
  return networkUsedThisSession;
}

export function subscribeNetworkActivity(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
