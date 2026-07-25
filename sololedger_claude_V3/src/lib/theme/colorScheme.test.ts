import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  COLOR_SCHEME_STORAGE_KEY,
  getColorSchemeChoice,
  resolveColorScheme,
  setColorScheme,
  initColorScheme,
  _resetColorSchemeSessionForTests
} from './colorScheme';

/**
 * Ember & Slate dual-theme plumbing contract: the persisted Light/Dark/System
 * choice resolves to a `data-theme` attribute on <html> (which flips every
 * CSS token) and the browser-chrome meta. jsdom has no `matchMedia`, which
 * doubles as the "system reports light" case.
 */

function stubMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: prefersDark && query === '(prefers-color-scheme: dark)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: vi.fn()
    })
  });
}

beforeEach(() => {
  localStorage.clear();
  _resetColorSchemeSessionForTests();
  delete document.documentElement.dataset.theme;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  _resetColorSchemeSessionForTests();
  delete document.documentElement.dataset.theme;
});

describe('colorScheme (Ember & Slate Light/Dark/System)', () => {
  it('defaults to system when nothing is persisted', () => {
    expect(getColorSchemeChoice()).toBe('system');
  });

  it('ignores garbage values in storage', () => {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, 'purple');
    expect(getColorSchemeChoice()).toBe('system');
  });

  it('reads back a persisted valid choice', () => {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, 'dark');
    expect(getColorSchemeChoice()).toBe('dark');
  });

  it('resolves explicit choices directly', () => {
    expect(resolveColorScheme('light')).toBe('light');
    expect(resolveColorScheme('dark')).toBe('dark');
  });

  it('resolves system from prefers-color-scheme (dark)', () => {
    stubMatchMedia(true);
    expect(resolveColorScheme('system')).toBe('dark');
  });

  it('resolves system to light when matchMedia reports light or is unavailable', () => {
    stubMatchMedia(false);
    expect(resolveColorScheme('system')).toBe('light');
    // jsdom default: matchMedia undefined → light
    // @ts-expect-error intentionally removing for the fallback path
    delete window.matchMedia;
    expect(resolveColorScheme('system')).toBe('light');
  });

  it('setColorScheme persists and applies data-theme + theme-color meta', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);

    setColorScheme('dark');
    expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(meta.getAttribute('content')).toBe('#171310');

    setColorScheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(meta.getAttribute('content')).toBe('#FBF7F1');

    meta.remove();
  });

  it('still applies the theme when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    setColorScheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('initColorScheme applies the persisted choice and is idempotent', () => {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, 'dark');
    initColorScheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
    initColorScheme();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});
