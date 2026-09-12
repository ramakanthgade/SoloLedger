import { createRoot } from 'react-dom/client';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/button';

export function FxPermissionDialog({ requests, currency, onDecision }: {
  requests: string[]; currency: string; onDecision: (allowed: boolean) => void;
}) {
  return <Dialog open onClose={() => onDecision(false)} labelledBy="fx-permission-title" className="max-w-xl">
    <h2 id="fx-permission-title" className="font-display text-2xl font-bold text-hi">Allow historical currency lookup?</h2>
    <p className="mt-3 text-sm text-mid">For this import or recovery batch only. Frankfurter receives the currencies and dates below, directly from your browser. No SoloLedger relay is used.</p>
    <ul className="my-4 max-h-40 overflow-auto rounded-xl border border-hi/10 bg-elev-1 p-3 font-mono text-xs text-hi">
      {requests.map(request => <li key={request}>{request}</li>)}
    </ul>
    <p className="text-sm text-mid">The provider also receives connection metadata such as your IP address and browser headers. No amounts, wallet addresses or raw files are sent.</p>
    <p className="mt-3 text-sm text-low">Reference rates may use the previous business day; the actual rate date and source are saved. Cached rates are reused only with this permission. USDT is not USD; unavailable stablecoin rates require manual valuation.</p>
    <p className="mt-3 text-sm text-low">Decline or close: no lookup requests. Enter a total {currency} value in Review instead. If an allowed lookup fails, your execution quote is retained for manual recovery.</p>
    <div className="mt-6 flex flex-wrap justify-end gap-3">
      <Button variant="secondary" onClick={() => onDecision(false)}>Enter totals manually</Button>
      <Button onClick={() => onDecision(true)}>Allow for this batch</Button>
    </div>
  </Dialog>;
}

/** A short-lived modal root allows both import pipelines to await one decision. */
export function requestFxPermission(requests: string[], currency: string): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false);
  return new Promise(resolve => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let settled = false;
    const onDecision = (allowed: boolean) => {
      if (settled) return;
      settled = true;
      root.unmount();
      container.remove();
      resolve(allowed);
    };
    root.render(<FxPermissionDialog requests={requests} currency={currency} onDecision={onDecision} />);
  });
}
