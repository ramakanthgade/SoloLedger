import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from '@/components/ui/input';

describe('Input', () => {
  it('renders with the shared .sl-input foundation class', () => {
    render(<Input data-testid="in" placeholder="Wallet address" />);
    const el = screen.getByTestId('in');
    expect(el.className).toContain('sl-input');
    expect(el).toHaveAttribute('placeholder', 'Wallet address');
    expect(el).not.toHaveAttribute('aria-invalid');
  });

  it('error state sets aria-invalid for screen readers', () => {
    render(<Input data-testid="in" error />);
    expect(screen.getByTestId('in')).toHaveAttribute('aria-invalid', 'true');
  });

  it('ok state adds the gain border class', () => {
    render(<Input data-testid="in" ok />);
    expect(screen.getByTestId('in').className).toContain('border-gain/60');
  });
});
