import type { CurrentPriceRefreshOutcome } from '@/lib/pricing/currentPrices';

export function walletPricingMessage(outcome: CurrentPriceRefreshOutcome | undefined): string | null {
  if (!outcome) return null;
  const known = outcome.priced + outcome.cached;
  const total = outcome.attempted + outcome.cached;
  if (total === 0) return 'Price coverage unavailable for these asset identities.';
  const coverage = `Price coverage: ${known} of ${total} eligible assets.`;
  const categories = new Set(outcome.errors.map((error) => error.category));
  const reason = categories.has('authentication') || categories.has('forbidden')
    ? 'Price provider access unavailable.'
    : categories.has('rate_limit') ? 'Price provider rate limited.'
      : categories.has('network') ? 'Price provider could not be reached.'
        : outcome.errors.length > 0 ? 'Price provider unavailable for some assets.'
          : outcome.unpriced > 0 ? 'Some assets have no current price.' : '';
  return `${coverage}${reason ? ` ${reason}` : ''}`;
}

export function WalletPricingStatus({ message, onRetry }: { message: string | null; onRetry: () => void }) {
  if (!message) return null;
  return <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-hi/10 bg-elev-2 px-4 py-3 text-xs text-low" role="status" data-testid="wallet-pricing-status">
    <span>{message}</span>
    <button type="button" className="font-semibold text-primary hover:underline" onClick={onRetry}>Retry prices</button>
  </div>;
}
