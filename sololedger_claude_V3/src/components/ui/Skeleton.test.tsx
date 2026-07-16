import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Skeleton, SkeletonTable, SkeletonCards } from '@/components/ui/Skeleton';

describe('Skeleton', () => {
  it('renders a shimmer block with the aurora skeleton class', () => {
    const { container } = render(<Skeleton className="h-4 w-20" data-testid="sk" />);
    const el = screen.getByTestId('sk');
    expect(el.className).toContain('sl-skeleton');
    // Decorative — hidden from the a11y tree.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('SkeletonTable announces a pending state via aria-busy', () => {
    render(<SkeletonTable rows={3} columns={4} data-testid="tbl" />);
    const el = screen.getByTestId('tbl');
    expect(el).toHaveAttribute('aria-busy', 'true');
    // header bar + 3 rows × 4 columns of shimmer blocks.
    expect(el.querySelectorAll('.sl-skeleton').length).toBe(1 + 3 * 4);
  });

  it('SkeletonCards renders the requested number of card placeholders', () => {
    const { container } = render(<SkeletonCards count={5} />);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    // Each card has 2 shimmer blocks.
    expect(container.querySelectorAll('.sl-skeleton').length).toBe(5 * 2);
  });
});
