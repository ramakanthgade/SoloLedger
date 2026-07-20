import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * Item 1 — OnboardingFlow must thread `onSkip` into the ConnectionWizard
 * phase. `App.tsx` passes onSkip (activate Import tab + dismiss onboarding),
 * but it previously stopped at OnboardingFlow: the wizard rendered with only
 * onComplete/onExit, so none of the four wizard steps had a skip link.
 *
 * Both child screens are stubbed: Onboarding exposes a button that advances
 * to the import phase; ConnectionWizard exposes the props it received so the
 * wiring itself is what is under test.
 */

vi.mock('./Onboarding', () => ({
  Onboarding: ({ onStartImport }: { onStartImport: () => void }) => (
    <button type="button" onClick={onStartImport}>
      start import
    </button>
  )
}));

const wizardProps = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('@/components/import/ConnectionWizard', () => ({
  ConnectionWizard: (props: { onSkip?: () => void; onComplete?: () => void }) => {
    wizardProps.current = props;
    return (
      <button type="button" onClick={props.onSkip}>
        wizard skip link
      </button>
    );
  }
}));

import { OnboardingFlow } from './OnboardingFlow';

describe('OnboardingFlow — onSkip threading (Item 1)', () => {
  it('passes onSkip through to the ConnectionWizard phase', () => {
    const onSkip = vi.fn();
    render(<OnboardingFlow onSkip={onSkip} />);

    // Advance past the intro into the guided-import phase.
    fireEvent.click(screen.getByRole('button', { name: /start import/i }));

    // The wizard received a working onSkip — clicking its skip link calls it.
    expect(wizardProps.current.onSkip).toBe(onSkip);
    fireEvent.click(screen.getByRole('button', { name: /wizard skip link/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('omitting onSkip leaves the wizard prop undefined (no skip link)', () => {
    render(<OnboardingFlow />);
    fireEvent.click(screen.getByRole('button', { name: /start import/i }));
    expect(wizardProps.current.onSkip).toBeUndefined();
  });
});
