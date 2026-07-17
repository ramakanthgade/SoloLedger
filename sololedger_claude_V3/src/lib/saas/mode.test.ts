import { describe, it, expect, beforeEach } from 'vitest';
import {
  APP_MODE_KEY,
  APP_MODE_SELECTED_KEY,
  getMode,
  setMode,
  initMode,
  hasSelectedMode
} from './mode';
import { initialPhase } from './modeContext';
import { setAuthToken } from './api';

describe('runtime mode store (mode.ts)', () => {
  beforeEach(() => {
    localStorage.clear();
    // Re-derive the singleton from the now-empty storage (seeds to 'local').
    initMode();
  });

  it('seeds to local when nothing is stored', () => {
    expect(getMode()).toBe('local');
    expect(hasSelectedMode()).toBe(false);
  });

  it('setMode persists the mode and marks it as an explicit selection', () => {
    setMode('byok');
    expect(getMode()).toBe('byok');
    expect(localStorage.getItem(APP_MODE_KEY)).toBe('byok');
    expect(localStorage.getItem(APP_MODE_SELECTED_KEY)).toBe('1');
    expect(hasSelectedMode()).toBe(true);
  });

  it('initMode restores a persisted explicit selection', () => {
    setMode('hosted');
    initMode();
    expect(getMode()).toBe('hosted');
    expect(hasSelectedMode()).toBe(true);
  });
});

describe('initialPhase (reload resume, test-plan case 17)', () => {
  beforeEach(() => {
    localStorage.clear();
    initMode();
  });

  it('a first-time visitor (no explicit selection) starts on landing', () => {
    expect(initialPhase('local')).toBe('landing');
  });

  it('a returning local user resumes straight into the app', () => {
    setMode('local');
    expect(initialPhase(getMode())).toBe('app');
  });

  it('a returning byok user resumes straight into the app', () => {
    setMode('byok');
    expect(initialPhase(getMode())).toBe('app');
  });

  it('a returning hosted user WITHOUT a token resumes into auth', () => {
    setMode('hosted');
    // No auth token present.
    expect(initialPhase(getMode())).toBe('auth');
  });

  it('a returning hosted user WITH a valid token resumes into the app', () => {
    setMode('hosted');
    setAuthToken('fake-token');
    expect(initialPhase(getMode())).toBe('app');
    setAuthToken(null);
  });

  it('back-compat: a legacy hosted user (token, no selection marker) resumes into the app', () => {
    // Simulate a user from the pre-migration hosted build: an auth token exists
    // but the new APP_MODE_SELECTED_KEY marker was never written.
    localStorage.setItem(APP_MODE_KEY, 'hosted');
    localStorage.removeItem(APP_MODE_SELECTED_KEY);
    initMode();
    setAuthToken('legacy-token');
    expect(hasSelectedMode()).toBe(false);
    expect(initialPhase(getMode())).toBe('app');
    setAuthToken(null);
  });

  it('corrupt storage: invalid mode + stale selection marker falls back to landing', () => {
    // A corrupt APP_MODE_KEY must not be treated as an explicit selection even
    // if the marker is set — initMode() falls back to the seed, and the seeded
    // default must route to landing, not app.
    localStorage.setItem(APP_MODE_KEY, 'bad-value');
    localStorage.setItem(APP_MODE_SELECTED_KEY, '1');
    initMode();
    expect(hasSelectedMode()).toBe(false);
    expect(initialPhase(getMode())).toBe('landing');
  });
});
