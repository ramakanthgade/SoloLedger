import { useSyncExternalStore } from 'react';

/**
 * Color scheme (Light / Dark / System) — Ember & Slate dual-theme plumbing.
 *
 * The persisted CHOICE lives in localStorage under `sololedger_color_scheme`
 * ('light' | 'dark' | 'system'); the RESOLVED theme ('light' | 'dark') is
 * applied as `data-theme` on <html>, which flips every CSS token in
 * `src/index.css`. `system` follows `prefers-color-scheme` live.
 *
 * Anti-flash: index.html runs a tiny inline script before first paint that
 * applies the persisted choice, so returning users never see the wrong theme.
 * This module re-applies the same logic at app boot (idempotent) and owns
 * runtime switching + persistence.
 */

export type ColorSchemeChoice = 'light' | 'dark' | 'system';
export type ResolvedColorScheme = 'light' | 'dark';

export const COLOR_SCHEME_STORAGE_KEY = 'sololedger_color_scheme';

const listeners = new Set<() => void>();
let mediaListenerInstalled = false;
/**
 * Session-only fallback for when localStorage is blocked (private mode):
 * the choice can't persist, but it must still apply for this session instead
 * of silently bouncing back to the stored/system value on re-read.
 */
let sessionChoice: ColorSchemeChoice | null = null;

function systemPrefersDark(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

export function getColorSchemeChoice(): ColorSchemeChoice {
  if (sessionChoice) return sessionChoice;
  try {
    const raw = localStorage.getItem(COLOR_SCHEME_STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    /* private mode / storage blocked — fall through to default */
  }
  return 'system';
}

export function resolveColorScheme(choice: ColorSchemeChoice): ResolvedColorScheme {
  if (choice === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return choice;
}

/** Apply the resolved theme to <html> + the browser chrome meta. Idempotent. */
function applyResolvedTheme(resolved: ResolvedColorScheme): void {
  const root = document.documentElement;
  if (root.dataset.theme !== resolved) root.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#171310' : '#FBF7F1');
}

function applyCurrentChoice(): void {
  applyResolvedTheme(resolveColorScheme(getColorSchemeChoice()));
}

function emitChange(): void {
  listeners.forEach((l) => l());
}

export function setColorScheme(choice: ColorSchemeChoice): void {
  try {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, choice);
    sessionChoice = null; // storage is the source of truth again
  } catch {
    sessionChoice = choice; // storage blocked — keep it for this session
  }
  installMediaListener();
  applyCurrentChoice();
  emitChange();
}

/** Follow OS theme changes while the choice is 'system'. */
function installMediaListener(): void {
  if (mediaListenerInstalled || typeof window === 'undefined' || !window.matchMedia) return;
  mediaListenerInstalled = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getColorSchemeChoice() === 'system') {
      applyCurrentChoice();
      emitChange();
    }
  });
}

/**
 * Boot hook — call once from main.tsx. Re-applies the persisted choice (the
 * inline index.html script already did, pre-paint) and installs the system
 * listener. Safe to call multiple times.
 */
export function initColorScheme(): void {
  installMediaListener();
  applyCurrentChoice();
}

/** Test-only: clears the session-only fallback so suites start clean. */
export function _resetColorSchemeSessionForTests(): void {
  sessionChoice = null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ColorSchemeChoice {
  return getColorSchemeChoice();
}

/** React hook: the persisted choice + the resolved theme + a setter. */
export function useColorScheme(): {
  choice: ColorSchemeChoice;
  resolved: ResolvedColorScheme;
  setColorScheme: (choice: ColorSchemeChoice) => void;
} {
  const choice = useSyncExternalStore(subscribe, getSnapshot);
  return { choice, resolved: resolveColorScheme(choice), setColorScheme };
}
