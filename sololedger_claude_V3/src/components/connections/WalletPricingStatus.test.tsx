import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WalletPricingStatus, walletPricingMessage } from './WalletPricingStatus';
import type { CurrentPriceRefreshOutcome } from '@/lib/pricing/currentPrices';

const partial: CurrentPriceRefreshOutcome = { attempted: 3, priced: 1, unpriced: 2, cached: 1, errors: [] };

describe('wallet pricing status', () => {
  it('labels price identity coverage independently of balance coverage', () => {
    expect(walletPricingMessage(partial)).toBe('Price coverage: 2 of 4 eligible assets. Some assets have no current price.');
  });

  it.each([
    ['authentication', 'Price provider access unavailable.'],
    ['forbidden', 'Price provider access unavailable.'],
    ['rate_limit', 'Price provider rate limited.'],
    ['network', 'Price provider could not be reached.'],
    ['provider', 'Price provider unavailable for some assets.']
  ] as const)('shows safe %s diagnostics and offers retry', (category, expected) => {
    const onRetry = vi.fn();
    render(<WalletPricingStatus message={walletPricingMessage({ ...partial, errors: [{ category, message: 'never render raw provider details' }] })} onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent(expected);
    expect(screen.getByRole('status')).not.toHaveTextContent('never render');
    fireEvent.click(screen.getByRole('button', { name: 'Retry prices' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
