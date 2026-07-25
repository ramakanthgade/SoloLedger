import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toggle } from './Toggle';

/**
 * The Ember & Slate switch stays a NATIVE checkbox underneath (existing
 * settings tests and screen readers rely on `role="checkbox"` + checked
 * semantics); these tests pin that contract and the switch styling hooks.
 */
describe('Toggle (switch-styled native checkbox)', () => {
  it('renders a checkbox that toggles checked state on click', () => {
    render(<Toggle aria-label="Feature" />);
    const box = screen.getByRole('checkbox', { name: 'Feature' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(box).toBeChecked();
  });

  it('carries the switch track/knob classes (46×27 track, sliding knob)', () => {
    render(<Toggle aria-label="Feature" />);
    const box = screen.getByRole('checkbox', { name: 'Feature' });
    expect(box.className).toContain('appearance-none');
    expect(box.className).toContain('rounded-full');
    expect(box.className).toContain('checked:bg-primary-solid');
    expect(box.className).toContain('checked:after:translate-x-[19px]');
  });

  it('merges a caller className and honors disabled', () => {
    render(<Toggle aria-label="Feature" className="mt-0.5" disabled />);
    const box = screen.getByRole('checkbox', { name: 'Feature' });
    expect(box.className).toContain('mt-0.5');
    expect(box).toBeDisabled();
  });
});
