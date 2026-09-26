import { useEffect, useMemo, useState } from 'react';
import { refreshCurrentHoldingPrices } from '@/lib/pricing/currentPrices';
import { getEffectiveSettings } from '@/lib/saas/effectiveSettings';
import { walletPricingMessage } from './WalletPricingStatus';
import { walletPriceHoldingsKey } from './walletPriceRefreshInputs';

type PriceHolding = Parameters<typeof refreshCurrentHoldingPrices>[0][number];

/** Cache publication updates valuations, never initiates another provider budget. */
export function useWalletPriceRefresh(
  holdings: readonly PriceHolding[],
  currency: string,
  settingsKey: string,
  refreshTick: string | number
): string | null {
  // Workspace snapshots and DeFi arrays can be recreated by priceCache live
  // queries. Retain only request inputs, in stable order, not valuation marks.
  const holdingsKey = walletPriceHoldingsKey(holdings);
  const stableHoldings = useMemo<PriceHolding[]>(() => JSON.parse(holdingsKey), [holdingsKey]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (stableHoldings.length === 0) return;
    getEffectiveSettings().then(async (effective) => {
      if (cancelled) return;
      if (!effective.priceApiEnabled) {
        setMessage('Price lookups disabled. Enable price lookups in Settings to refresh values.');
        return;
      }
      try {
        const outcome = await refreshCurrentHoldingPrices(stableHoldings, currency, effective.coingeckoApiKey);
        if (!cancelled) setMessage(walletPricingMessage(outcome));
      } catch {
        if (!cancelled) setMessage('Price provider unavailable. Cached values may be incomplete.');
      }
    }).catch(() => {
      if (!cancelled) setMessage('Price settings unavailable. Retry to check pricing.');
    });
    return () => { cancelled = true; };
  }, [stableHoldings, currency, settingsKey, refreshTick]);
  return stableHoldings.length === 0 ? null : message;
}
