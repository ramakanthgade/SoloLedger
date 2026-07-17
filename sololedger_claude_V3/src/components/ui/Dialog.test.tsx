import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Dialog } from '@/components/ui/Dialog';

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button data-testid="outside">outside</button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        label="Test dialog"
      >
        <button data-testid="first">first</button>
        <button data-testid="last">last</button>
      </Dialog>
    </>
  );
}

describe('Dialog', () => {
  it('renders with role="dialog" and aria-modal', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-label', 'Test dialog');
  });

  it('moves focus into the dialog on open', () => {
    render(<Harness />);
    expect(screen.getByTestId('first')).toHaveFocus();
  });

  it('traps focus: Tab from last wraps to first', () => {
    render(<Harness />);
    const first = screen.getByTestId('first');
    const last = screen.getByTestId('last');
    last.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(first).toHaveFocus();
  });

  it('traps focus: Shift+Tab from first wraps to last', () => {
    render(<Harness />);
    const first = screen.getByTestId('first');
    const last = screen.getByTestId('last');
    first.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('Escape closes the dialog', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('restores focus to the previously-focused element on close', () => {
    function ToggleHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-testid="trigger" onClick={() => setOpen(true)}>
            open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} label="Restore test">
            <button data-testid="inner">inner</button>
          </Dialog>
        </>
      );
    }
    render(<ToggleHarness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    // Focus moved into the dialog.
    expect(screen.getByTestId('inner')).toHaveFocus();
    // Close via Escape → focus restored to the trigger.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });
});
