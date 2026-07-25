import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReportPeriodPills } from './ReportPeriodPills';

const OPTIONS = [
  { value: 2024, label: 'FY 2024-25' },
  { value: 2025, label: 'FY 2025-26' },
  { value: 2026, label: 'FY 2026-27' }
];

function setup(value = 2025) {
  const onChange = vi.fn();
  render(
    <ReportPeriodPills
      options={OPTIONS}
      value={value}
      onChange={onChange}
      ariaLabel="Financial year"
      data-testid="fy-pills"
    />
  );
  const group = screen.getByRole('radiogroup', { name: 'Financial year' });
  const radios = screen.getAllByRole('radio');
  return { onChange, group, radios };
}

describe('ReportPeriodPills — segmented radiogroup', () => {
  it('renders one radio per option with aria-checked on the active pill', () => {
    const { radios } = setup(2025);
    expect(radios).toHaveLength(3);
    expect(radios[0]).toHaveAttribute('aria-checked', 'false');
    expect(radios[1]).toHaveAttribute('aria-checked', 'true');
    expect(radios[2]).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps a roving tabindex: only the active pill is a Tab stop', () => {
    const { radios } = setup(2025);
    expect(radios[0]).toHaveAttribute('tabindex', '-1');
    expect(radios[1]).toHaveAttribute('tabindex', '0');
    expect(radios[2]).toHaveAttribute('tabindex', '-1');
  });

  it('selects a pill on click', () => {
    const { onChange, radios } = setup(2025);
    fireEvent.click(radios[2]);
    expect(onChange).toHaveBeenCalledWith(2026);
  });

  it('ArrowRight / ArrowLeft move the selection and focus together', () => {
    const { onChange, group, radios } = setup(2025);

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(2026);
    expect(document.activeElement).toBe(radios[2]);

    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith(2024);
    expect(document.activeElement).toBe(radios[0]);
  });

  it('wraps around at the ends and honours Home / End', () => {
    const { onChange, group, radios } = setup(2024);

    // On the first pill: ArrowLeft wraps to the last.
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith(2026);
    expect(document.activeElement).toBe(radios[2]);

    fireEvent.keyDown(group, { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith(2024);
    expect(document.activeElement).toBe(radios[0]);

    fireEvent.keyDown(group, { key: 'End' });
    expect(onChange).toHaveBeenCalledWith(2026);
    expect(document.activeElement).toBe(radios[2]);
  });

  it('ignores unrelated keys without changing the selection', () => {
    const { onChange, group } = setup(2025);
    fireEvent.keyDown(group, { key: 'x' });
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
