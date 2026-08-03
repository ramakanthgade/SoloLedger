import { describe, expect, it } from 'vitest';
import { coherentWorkspaceTransition } from './useCoherentDataHealthSnapshot';

describe('coherent workspace transition', () => {
  it('forces false-to-true once and treats true-to-false as no read revision', () => {
    const opened = coherentWorkspaceTransition(false, 0, true);
    expect(opened).toEqual({ opening: true, openGeneration: 1 });

    const remainedOpen = coherentWorkspaceTransition(true, opened.openGeneration, true);
    expect(remainedOpen).toEqual({ opening: false, openGeneration: 1 });

    const closed = coherentWorkspaceTransition(true, remainedOpen.openGeneration, false);
    expect(closed).toEqual({ opening: false, openGeneration: 1 });
  });
});
