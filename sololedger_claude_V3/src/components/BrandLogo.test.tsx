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

    // Variant-B shield stroke uses the aurora gradient (url(#brand-au-b)).
    const shield = container.querySelector('path[stroke="url(#brand-au-b)"]');
    expect(shield).not.toBeNull();

    // White ledger lines + teal verification tick.
    expect(container.querySelector('path[stroke="#F5F6FF"]')).not.toBeNull();
    expect(container.querySelector('path[stroke="#22E1C3"]')).not.toBeNull();
  });

  it('renders the variant-C filled chip in mark mode (no wordmark/tagline)', () => {
    const { container } = render(<BrandLogo mode="mark" />);

    // Filled aurora chip: a <rect> filled with the variant-C gradient.
    const chip = container.querySelector('rect[fill="url(#brand-au-c)"]');
    expect(chip).not.toBeNull();

    // Dark mark drawn on the aurora fill.
    expect(container.querySelector('path[stroke="#0A0B1A"]')).not.toBeNull();

    // Mark mode omits the wordmark + tagline.
    expect(screen.queryByText('Solo')).not.toBeInTheDocument();
    expect(screen.queryByText('Private. Precise. Yours.')).not.toBeInTheDocument();
  });

  it('hides the tagline when showTagline is false', () => {
    render(<BrandLogo variant="on-glass" showTagline={false} />);
    expect(screen.getByText('Solo')).toBeInTheDocument();
    expect(screen.queryByText('Private. Precise. Yours.')).not.toBeInTheDocument();
  });
});
