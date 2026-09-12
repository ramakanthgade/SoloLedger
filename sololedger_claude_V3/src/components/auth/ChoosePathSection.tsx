import type { AppMode } from '@/lib/saas/mode';

export function ChoosePathSection({ onSelectMode }: { onSelectMode: (mode: AppMode) => void }) {
  return (
    <section id="choose" className="border-y border-hi/10 bg-elev-1 py-16">
      <div className="mx-auto max-w-2xl px-6 text-center">
        <h2 className="font-display text-4xl font-extrabold text-hi">Start your crypto tax review</h2>
        <p className="mt-4 text-mid">Create an account for managed connections and pricing. Your ledger stays in this browser. An account is not a backup or cross-device sync.</p>
        <button type="button" onClick={() => onSelectMode('hosted')} className="mt-6 rounded-lg bg-primary-solid px-8 py-3 font-bold text-white">Create account</button>
        <div className="mt-6 border-t border-hi/10 pt-6">
          <button type="button" onClick={() => onSelectMode('local')} className="font-semibold text-primary underline">Continue without an account</button>
          <p className="mt-2 text-sm text-low">Import files and calculate locally. Historical currency lookups are optional, with permission for each import batch. Decline to enter totals manually.</p>
        </div>
        <p className="mt-5 text-xs text-low">Signing in or out keeps this same-origin local ledger visible in this browser. Use a trusted device. Export a backup before changing browser or device; existing backup files are sensitive and not encrypted.</p>
      </div>
    </section>
  );
}
