import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '@/components/ErrorBoundary';

function Boom(): never {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // Suppress the expected React error log noise for the throwing render.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <div>healthy content</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('healthy content')).toBeInTheDocument();
  });

  it('renders the friendly fallback when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload app/i })).toBeInTheDocument();
    // The raw error message must not leak to the user.
    expect(screen.queryByText(/kaboom/)).not.toBeInTheDocument();
  });
});
