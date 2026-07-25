import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ThemeToggle } from '@/components/ThemeToggle';
import {
  COLOR_SCHEME_STORAGE_KEY,
  _resetColorSchemeSessionForTests
} from '@/lib/theme/colorScheme';

describe('ThemeToggle (header theme control)', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetColorSchemeSessionForTests();
    delete document.documentElement.dataset.theme;
  });

  it('offers the dark theme when the resolved theme is light (jsdom default)', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument();
  });

  it('clicking pins the dark choice, flips <html> and persists it', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));

    expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    // The button now previews the reverse action.
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });

  it('toggles back to light on a second click', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));

    expect(localStorage.getItem(COLOR_SCHEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument();
  });

  it('from a persisted dark choice it offers the light theme', () => {
    localStorage.setItem(COLOR_SCHEME_STORAGE_KEY, 'dark');
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: 'Switch to light theme' })).toBeInTheDocument();
  });
});
