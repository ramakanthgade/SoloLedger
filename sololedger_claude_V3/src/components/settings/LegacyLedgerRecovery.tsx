import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { listBrowserLedgers, selectBrowserLedgerForReload, type BrowserLedger } from '@/lib/storage/db';

export function LegacyLedgerRecovery({ reload = () => window.location.reload() }: { reload?: () => void }) {
  const [ledgers, setLedgers] = useState<BrowserLedger[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <section className="mt-5 rounded-xl border border-hi/10 p-4" aria-label="Legacy browser ledger recovery">
    <h3 className="font-semibold text-hi">Find an older browser ledger</h3>
    <p className="my-2 text-sm text-low">Earlier versions stored separate local and account ledgers. Discover those still on this browser and origin. Opening one does not merge, replace or delete another. Sign-out does not hide browser data.</p>
    <Button variant="secondary" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { setLedgers(await listBrowserLedgers()); } catch { setError('Could not read browser ledgers. No data was changed.'); }
      finally { setBusy(false); }
    }}>Discover browser ledgers</Button>
    {ledgers && <ul className="mt-3 space-y-2">{ledgers.map(ledger => <li key={ledger.name} className="flex flex-wrap items-center gap-3 text-sm text-mid">
      <span className="break-all">{ledger.name} · {ledger.transactionCount} transactions {ledger.active && '· Current ledger'}</span>
      {!ledger.active && <Button variant="secondary" onClick={() => setSelected(ledger.name)}>Select ledger {ledger.name}</Button>}
    </li>)}</ul>}
    {selected && <div className="mt-3 rounded-lg border border-warn/30 p-3 text-sm text-mid">
      <p>Open {selected}? The app will reload into that ledger. Nothing is merged or replaced. You can return here to select the previous ledger.</p>
      <p className="mt-2">Then use Export full backup (JSON) above to save a sensitive, unencrypted copy before any restore. Your account is not a backup.</p>
      <div className="mt-3 flex gap-2">
        <Button disabled={busy} onClick={async () => {
          setBusy(true); setError('');
          try { await selectBrowserLedgerForReload(selected); reload(); }
          catch { setError('Could not select this browser ledger. No data was changed.'); setBusy(false); }
        }}>Open selected ledger</Button>
        <Button variant="secondary" onClick={() => setSelected(null)}>Cancel</Button>
      </div>
    </div>}
    {error && <p role="alert" className="mt-2 text-sm text-loss">{error}</p>}
  </section>;
}
