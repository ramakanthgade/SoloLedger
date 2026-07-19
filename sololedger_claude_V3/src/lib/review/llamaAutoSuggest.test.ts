import { describe, it, expect } from 'vitest';
import {
  LLAMA_AUTO_RUN_SESSION_KEY,
  llamaBannerHint,
  markLlamaAutoRun,
  shouldAutoRunLlamaSuggestions,
  type LlamaAutoRunState
} from '@/lib/review/llamaAutoSuggest';

/** Minimal Storage double — the helpers only read/write the session key. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v)
  };
}

const READY: LlamaAutoRunState = {
  priceLookupEnabled: true,
  candidateCount: 3,
  inFlight: false
};

describe('shouldAutoRunLlamaSuggestions', () => {
  it('fires when price lookup is effectively enabled, candidates exist, none in flight, not yet run', () => {
    expect(shouldAutoRunLlamaSuggestions(READY, fakeStorage())).toBe(true);
  });

  it('does not fire when price lookup is effectively disabled', () => {
    expect(
      shouldAutoRunLlamaSuggestions({ ...READY, priceLookupEnabled: false }, fakeStorage())
    ).toBe(false);
  });

  it('does not fire while the effective flag is still resolving (null counts as OFF)', () => {
    expect(
      shouldAutoRunLlamaSuggestions({ ...READY, priceLookupEnabled: null }, fakeStorage())
    ).toBe(false);
  });

  it('does not fire when there are no unclassified Solana transfer-in candidates', () => {
    expect(
      shouldAutoRunLlamaSuggestions({ ...READY, candidateCount: 0 }, fakeStorage())
    ).toBe(false);
  });

  it('does not fire while a suggestion pass is already in flight', () => {
    expect(
      shouldAutoRunLlamaSuggestions({ ...READY, inFlight: true }, fakeStorage())
    ).toBe(false);
  });

  it('fires exactly once per session — the session mark blocks every later evaluation (no loop/re-fire)', () => {
    const storage = fakeStorage();
    expect(shouldAutoRunLlamaSuggestions(READY, storage)).toBe(true);
    markLlamaAutoRun(storage);
    // Inputs churn as the pass runs (in-flight toggles, candidates shrink as
    // rows are reclassified to income) — the guard never passes again.
    expect(shouldAutoRunLlamaSuggestions(READY, storage)).toBe(false);
    expect(shouldAutoRunLlamaSuggestions({ ...READY, inFlight: true }, storage)).toBe(false);
    expect(shouldAutoRunLlamaSuggestions({ ...READY, candidateCount: 0 }, storage)).toBe(false);
    expect(shouldAutoRunLlamaSuggestions({ ...READY, candidateCount: 9 }, storage)).toBe(false);
  });

  it('does not fire when the session key is already set (e.g. earlier in the session)', () => {
    const storage = fakeStorage({ [LLAMA_AUTO_RUN_SESSION_KEY]: '1' });
    expect(shouldAutoRunLlamaSuggestions(READY, storage)).toBe(false);
  });

  it('a fresh session (empty storage) allows the pass again', () => {
    const storage = fakeStorage();
    markLlamaAutoRun(storage);
    expect(shouldAutoRunLlamaSuggestions(READY, fakeStorage())).toBe(true);
  });

  it('marks the documented session key', () => {
    const storage = fakeStorage();
    markLlamaAutoRun(storage);
    expect(storage.map.get(LLAMA_AUTO_RUN_SESSION_KEY)).toBe('1');
  });
});

describe('llamaBannerHint — banner variant selection', () => {
  it('points at the automatic run when price lookup is effectively on', () => {
    expect(llamaBannerHint(true)).toContain('runs automatically');
    expect(llamaBannerHint(true)).not.toContain('Turn on Live price lookup');
  });

  it('points at Settings when price lookup is effectively off', () => {
    expect(llamaBannerHint(false)).toContain('Turn on Live price lookup in Settings');
  });
});
