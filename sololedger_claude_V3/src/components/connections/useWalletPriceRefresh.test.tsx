import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/storage/db';
import { refreshCurrentHoldingPrices } from '@/lib/pricing/currentPrices';
import { useWalletPriceRefresh } from './useWalletPriceRefresh';

const mocks = vi.hoisted(() => ({ contracts: vi.fn(), settings: vi.fn() }));
vi.mock('@/lib/pricing/coingecko', () => ({
  fetchCurrentPrices: vi.fn(async () => []),
  fetchCurrentContractPrices: mocks.contracts
}));
vi.mock('@/lib/saas/effectiveSettings', () => ({ getEffectiveSettings: mocks.settings }));
vi.mock('@/lib/pricing/currentPrices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pricing/currentPrices')>();
  return { ...actual, refreshCurrentHoldingPrices: vi.fn(actual.refreshCurrentHoldingPrices) };
});

const holdings = Array.from({ length: 61 }, (_, index) => ({
  asset: `TOK${index}`, chain: 'ethereum', contractAddress: `0x${(index + 1).toString(16).padStart(40, '0')}`,
  amount: 2, quantity: 2, costBasis: 0, safetyState: 'unverified' as const
}));

/** Real Dexie publication recreates Home evidence / Detail snapshot inputs. */
function ReactiveWallet({ surface, currency = 'INR', settingsKey = 'enabled' }: {
  surface: 'home' | 'detail'; currency?: string; settingsKey?: string;
}) {
  const prices = useLiveQuery(() => db.priceCache.toArray(), []);
  const [tick, setTick] = useState(0);
  const recreated = (prices ? holdings : []).map((holding) => ({ ...holding, valueNow: prices?.length ?? 0 }));
  // Reversing models UI valuation sorting after a newly priced token appears.
  const inputs = surface === 'home' && prices?.length ? recreated.reverse() : recreated;
  const message = useWalletPriceRefresh(inputs, currency, settingsKey, tick);
  return <div><span data-testid="cached">{prices?.length ?? -1}</span><span>{message}</span>
    <button onClick={() => setTick((value) => value + 1)}>Retry</button></div>;
}

beforeEach(async () => {
  await db.priceCache.clear();
  vi.mocked(refreshCurrentHoldingPrices).mockClear();
  mocks.contracts.mockReset();
  mocks.settings.mockResolvedValue({ priceApiEnabled: true });
});

describe('wallet refresh lifecycle with actual reactive price cache', () => {
  it.each(['home', 'detail'] as const)('%s does not reset the budget when partial marks are published', async (surface) => {
    mocks.contracts.mockImplementation(async (requests: Array<{ platform: string; contractAddress: string }>, currency: string) =>
      requests.map((request, index) => ({
        asset: request.contractAddress, platform: request.platform, currency,
        price: index < 30 ? 83 : null,
        ...(index < 30 ? {} : { failure: { category: 'batch_limit', message: 'Budget reached.' } })
      }))
    );
    render(<ReactiveWallet surface={surface} />);
    await waitFor(() => expect(screen.getByTestId('cached')).toHaveTextContent('30'));
    await waitFor(() => expect(screen.getByText(/Price coverage: 30 of 61/)).toBeInTheDocument());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(refreshCurrentHoldingPrices).toHaveBeenCalledTimes(1);
    expect(mocks.contracts).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(refreshCurrentHoldingPrices).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('cached')).toHaveTextContent('60'));
    expect(mocks.contracts).toHaveBeenCalledTimes(2);
  });

  it.each(['home', 'detail'] as const)('%s retains the 429 outcome without immediate retries after partial success', async (surface) => {
    mocks.contracts.mockImplementation(async (requests: Array<{ platform: string; contractAddress: string }>, currency: string) =>
      requests.map((request, index) => ({
        asset: request.contractAddress, platform: request.platform, currency,
        price: index === 0 ? 83 : null,
        ...(index === 0 ? {} : { failure: { category: 'rate_limit', httpStatus: 429, message: 'Rate limited.' } })
      }))
    );
    const view = render(<ReactiveWallet surface={surface} />);
    await waitFor(() => expect(screen.getByTestId('cached')).toHaveTextContent('1'));
    await waitFor(() => expect(screen.getByText(/Price provider rate limited/)).toBeInTheDocument());
    // An independent cache publication is also not a retry trigger.
    await act(async () => { await db.priceCache.put({ key: 'spot:sym:BTC:USD', price: 100, fetchedAt: Date.now() }); });
    await waitFor(() => expect(screen.getByTestId('cached')).toHaveTextContent('2'));
    expect(refreshCurrentHoldingPrices).toHaveBeenCalledTimes(1);
    expect(mocks.contracts).toHaveBeenCalledTimes(1);
    view.rerender(<ReactiveWallet surface={surface} currency="USD" />);
    await waitFor(() => expect(refreshCurrentHoldingPrices).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('cached')).toHaveTextContent('3'));
    view.unmount();
  });
});
