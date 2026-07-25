import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppearanceSettings } from '@/components/settings/AppearanceSettings';
import {
  COLOR_SCHEME_STORAGE_KEY,
  _resetColorSchemeSessionForTests
} from '@/lib/theme/colorScheme';

describe('AppearanceSettings (Light / Dark / System)', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetColorSchemeSessionForTests();
    delete document.documentElement.dataset.theme;
  });

  function getRadios() {
    return screen.getAllByRole('radio');
  }

  it('renders a radiogroup with Light, Dark and System; System is the default', () => {
    render(<AppearanceSettings />);
    expect(screen.getByRole('radiogroup', { name: 'Color theme' })).toBeInTheDocument();
    const [light, dark, system] = getRadios();
    expect(light).toHaveAccessibleName('Light');
    expect(dark).toHaveAccessibleName('Dark');
    expect(system).toHaveAccessibleName('System');
    expect(system).toHaveAttribute('aria-checked', 'true');
    expect(light).toHaveAttribute('aria-checked', 'false');
  });

  it('roving tabindex: only the checked segment is tabbable', () => {
    render(<AppearanceSettings />);
    const [light, dark, system] = getRadios();
    expect(system).toHaveAttribute('tabindex', '0');
    expect(light).toHaveAttribute('tabindex', '-1');
    expect(dark).toHaveAttribute('tabindex', '-1');
  });

  it('clicking Dark persists the choice, applies data-theme and checks the segment', () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));

    expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  });

  it('ArrowRight moves the selection and focus to the next segment', () => {
    render(<AppearanceSettings />);
    const system = screen.getByRole('radio', { name: 'System' });
    system.focus();
    fireEvent.keyDown(system, { key: 'ArrowRight' });

    const light = screen.getByRole('radio', { name: 'Light' });
    expect(light).toHaveAttribute('aria-checked', 'true');
    expect(light).toHaveFocus();
    expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe('light');
  });

  it('ArrowLeft from System wraps to Dark; Home/End jump to the ends', () => {
    render(<AppearanceSettings />);
    const system = screen.getByRole('radio', { name: 'System' });
    system.focus();
    fireEvent.keyDown(system, { key: 'ArrowLeft' });
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Dark' }), { key: 'Home' });
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Light' }), { key: 'End' });
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
  });
});
