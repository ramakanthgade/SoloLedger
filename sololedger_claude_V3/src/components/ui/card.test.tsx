import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from '@/components/ui/card';

describe('Badge (semantic Ember & Slate tones)', () => {
  it('defaults to the neutral pill', () => {
    render(<Badge data-testid="b">draft</Badge>);
    const el = screen.getByTestId('b');
    expect(el.className).toContain('rounded-full');
    expect(el.className).toContain('bg-elev-3');
  });

  it('maps every tone to its semantic theme token', () => {
    const tones = {
      gain: 'text-gain',
      warn: 'text-warn',
      loss: 'text-loss',
      primary: 'text-primary',
      accent: 'text-accent',
      neutral: 'text-mid'
    } as const;
    for (const [tone, cls] of Object.entries(tones)) {
      const { unmount } = render(
        <Badge data-testid="b" tone={tone as keyof typeof tones}>
          x
        </Badge>
      );
      expect(screen.getByTestId('b').className).toContain(cls);
      unmount();
    }
  });
});
