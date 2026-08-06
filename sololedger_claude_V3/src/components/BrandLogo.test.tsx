import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandLogo } from '@/components/BrandLogo';

describe('BrandLogo', () => {
  it('renders the variant-B on-glass mark: aurora gradient stroke + white ledger + tagline', () => {
    const { container } = render(<BrandLogo variant="on-glass" />);

    // Wordmark: "Solo" + gradient "Ledger".
    expect(screen.getByText('Solo')).toBeInTheDocument();
    expect(screen.getByText('Ledger')).toBeInTheDocument();

    // The gradient "Ledger" uses the aurora background clipped to text.
    const ledger = screen.getByText('Ledger');
    expect(ledger.className).toContain('bg-aurora');
    expect(ledger.className).toContain('bg-clip-text');

    // Tagline.
    expect(screen.getByText('Private. Precise. Yours.')).toBeInTheDocument();

    // Variant-B shield stroke uses a gradient stroke whose id is generated
    // per-instance (useId) so multiple logos on one page don't collide.
    const gradient = container.querySelector('linearGradient');
    expect(gradient).not.toBeNull();
    const gradientId = gradient?.getAttribute('id');
    expect(gradientId).toBeTruthy();
    const shield = container.querySelector(`path[stroke="url(#${gradientId})"]`);
    expect(shield).not.toBeNull();

    // Theme-ink ledger lines + gain verification tick (Ember & Slate).
    expect(container.querySelector('path[stroke="var(--text-hi)"]')).not.toBeNull();
    expect(container.querySelector('path[stroke="var(--gain)"]')).not.toBeNull();
  });

  it('renders the variant-C filled chip in mark mode (no wordmark/tagline)', () => {
    const { container } = render(<BrandLogo mode="mark" />);

    // Filled aurora chip: a <rect> filled with the variant-C gradient, whose
    // id is generated per-instance (useId).
    const gradient = container.querySelector('linearGradient');
    expect(gradient).not.toBeNull();
    const gradientId = gradient?.getAttribute('id');
    expect(gradientId).toBeTruthy();
    const chip = container.querySelector(`rect[fill="url(#${gradientId})"]`);
    expect(chip).not.toBeNull();

    // On-aurora mark drawn on the aurora fill (white in light, charcoal in dark).
    expect(container.querySelector('path[stroke="var(--on-aurora)"]')).not.toBeNull();

    // Mark mode omits the wordmark + tagline.
    expect(screen.queryByText('Solo')).not.toBeInTheDocument();
    expect(screen.queryByText('Private. Precise. Yours.')).not.toBeInTheDocument();
  });

  it('hides the tagline when showTagline is false', () => {
    render(<BrandLogo variant="on-glass" showTagline={false} />);
    expect(screen.getByText('Solo')).toBeInTheDocument();
    expect(screen.queryByText('Private. Precise. Yours.')).not.toBeInTheDocument();
  });

  it('gives each instance unique SVG ids so multiple logos on one page do not collide', () => {
    const { container } = render(
      <>
        <BrandLogo variant="on-glass" />
        <BrandLogo variant="on-glass" />
      </>
    );
    const ids = Array.from(container.querySelectorAll('linearGradient')).map((g) =>
      g.getAttribute('id')
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    // Distinct ids — the duplicate-id collision that dropped the stroke is gone.
    expect(ids[0]).not.toBe(ids[1]);
    // Each shield stroke references its own gradient.
    ids.forEach((id) => {
      expect(container.querySelector(`path[stroke="url(#${id})"]`)).not.toBeNull();
    });

    const allIds = Array.from(container.querySelectorAll('[id]')).map((element) => element.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    container.querySelectorAll('svg').forEach((svg) => {
      const titleId = svg.getAttribute('aria-labelledby');
      expect(titleId).toBeTruthy();
      expect(svg.querySelector(`title[id="${titleId}"]`)).not.toBeNull();
    });
  });
});
