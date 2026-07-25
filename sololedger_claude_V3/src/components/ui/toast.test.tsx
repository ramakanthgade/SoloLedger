import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toast, ToastViewport } from '@/components/ui/toast';

describe('Toast', () => {
  it('announces itself as a status with title and description', () => {
    render(<Toast title="Import complete" description="128 transactions added" />);
    const el = screen.getByRole('status');
    expect(el).toHaveTextContent('Import complete');
    expect(el).toHaveTextContent('128 transactions added');
  });

  it('applies the tone accent on the leading border', () => {
    render(<Toast tone="loss" title="Sync failed" />);
    expect(screen.getByRole('status').className).toContain('border-l-loss');
  });

  it('renders an accessible dismiss button only when onDismiss is given', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Toast title="Heads up" />);
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).toBeNull();

    rerender(<Toast title="Heads up" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ToastViewport stacks above dialogs (z-[70]) and is polite-live', () => {
    render(
      <ToastViewport data-testid="vp">
        <Toast title="One" />
      </ToastViewport>
    );
    const vp = screen.getByTestId('vp');
    expect(vp).toHaveAttribute('aria-live', 'polite');
    expect(vp.className).toContain('z-[70]');
    expect(screen.getByRole('status')).toHaveTextContent('One');
  });
});
