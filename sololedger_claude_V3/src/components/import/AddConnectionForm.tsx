import { useMemo, useState } from 'react';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  ExternalLink,
  Loader2,
  PlugZap,
  ShieldCheck
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  addConnection,
  testConnection,
  type ExchangeConnectionView,
  type ExchangeId
} from '@/lib/exchangeSync';
import { AUTO_SYNC_EXCHANGES, type AutoSyncExchange } from './autoSyncExchanges';

const inputCls =
  'mt-1 block w-full rounded border border-white/10 bg-elev-2 px-2 py-1.5 text-sm text-mid focus:border-violet focus:outline-none';

interface AddConnectionFormProps {
  /** Called with the redacted view right after a connection is saved — the
   *  panel uses it to kick off `runInitialSync` immediately. */
  onSaved: (connection: ExchangeConnectionView) => void;
  /** True while any sync job is running — Save is disabled because saving
   *  kicks off the first sync, and only one sync can run at a time. */
  syncRunning?: boolean;
}

/** SourceTile-style single-select tile (mirrors ConnectionWizard's picker). */
function ExchangeTile({
  exchange,
  chosen,
  onChoose
}: {
  exchange: AutoSyncExchange;
  chosen: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={chosen}
      className={cn(
        'flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-colors',
        chosen
          ? 'border-gain/50 bg-gain/[0.06]'
          : 'border-white/10 bg-elev-3/50 hover:border-white/20'
      )}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-aurora font-mono text-[11px] font-extrabold text-[#0A0B1A]">
        {exchange.monogram}
      </span>
      <span className="min-w-0">
        <span className={cn('block text-sm font-bold', chosen ? 'text-hi' : 'text-mid')}>
          {exchange.label}
        </span>
        <span className="block text-[10.5px] text-low">{exchange.formatHint}</span>
      </span>
      {chosen && <Check className="ml-auto h-4 w-4 shrink-0 text-gain" />}
    </button>
  );
}

/**
 * AddConnectionForm (Section C, task 3) — connect an exchange with a read-only
 * API key. "Save connection" stays disabled until "Test connection" succeeds
 * for the EXACT current field values (fingerprint of
 * {exchange, apiKey, secret, passphrase}); any edit invalidates it.
 */
export function AddConnectionForm({ onSaved, syncRunning = false }: AddConnectionFormProps) {
  const [exchangeId, setExchangeId] = useState<ExchangeId>('binance');
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [label, setLabel] = useState('');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Fingerprint of the field values that last PASSED "Test connection". */
  const [testedFingerprint, setTestedFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);

  const exchange = AUTO_SYNC_EXCHANGES.find((e) => e.id === exchangeId)!;
  const fingerprint = useMemo(
    () => JSON.stringify([exchangeId, apiKey.trim(), secret.trim(), passphrase.trim()]),
    [exchangeId, apiKey, secret, passphrase]
  );
  const requiredFilled =
    apiKey.trim().length > 0 &&
    secret.trim().length > 0 &&
    (!exchange.needsPassphrase || passphrase.trim().length > 0);
  /** Save unlocks only when the CURRENT values are exactly the tested ones. */
  const tested = testedFingerprint === fingerprint;
  const busy = testing || saving;

  const connectionInput = () => ({
    exchange: exchangeId,
    label: label.trim() || undefined,
    apiKey: apiKey.trim(),
    secret: secret.trim(),
    passphrase: exchange.needsPassphrase ? passphrase.trim() || undefined : undefined
  });

  const runTest = async () => {
    setTesting(true);
    setError(null);
    try {
      const result = await testConnection(connectionInput());
      if (result.ok) {
        setTestedFingerprint(fingerprint);
      } else {
        setTestedFingerprint(null);
        setError(result.error ?? 'Connection failed — check the key and try again.');
      }
    } finally {
      setTesting(false);
    }
  };

  const runSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const view = await addConnection(connectionInput());
      setApiKey('');
      setSecret('');
      setPassphrase('');
      setLabel('');
      setTestedFingerprint(null);
      onSaved(view);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the connection — try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="flex flex-col gap-6 rounded-2xl border border-violet/30 bg-elev-2 p-5 shadow-card">
      <div>
        <h3 className="text-base font-extrabold text-hi">Connect an exchange</h3>
        <p className="mt-1 text-xs text-low">
          Pick your exchange, then paste a read-only API key from its settings page.
        </p>
      </div>

      {/* Step 1 · exchange picker */}
      <div>
        <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-teal">
          Step 1 · Choose your exchange
          <span className="h-px flex-1 bg-gradient-to-r from-teal/40 to-transparent" />
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {AUTO_SYNC_EXCHANGES.map((e) => (
            <ExchangeTile
              key={e.id}
              exchange={e}
              chosen={exchangeId === e.id}
              onChoose={() => {
                setExchangeId(e.id);
                setError(null);
              }}
            />
          ))}
        </div>
      </div>

      {/* Step 2 · credentials */}
      <div>
        <div className="mb-2.5 flex items-center gap-2 font-mono text-[10px] font-bold uppercase tracking-wider text-teal">
          Step 2 · Paste your {exchange.label} credentials
          <span className="h-px flex-1 bg-gradient-to-r from-teal/40 to-transparent" />
        </div>

        <div className="flex flex-col gap-3.5 rounded-[10px] border border-white/10 bg-elev-3/30 p-3.5">
          <label className="text-xs text-low">
            API Key
            <input
              className={inputCls}
              value={apiKey}
              autoComplete="off"
              onChange={(e) => {
                setApiKey(e.target.value);
                setError(null);
              }}
            />
          </label>
          <label className="text-xs text-low">
            API Secret
            <input
              type="password"
              autoComplete="off"
              className={inputCls}
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                setError(null);
              }}
            />
          </label>
          {exchange.needsPassphrase && (
            <label className="text-xs text-low">
              Passphrase{' '}
              <span className="text-faint">
                — KuCoin and OKX keys have this extra word; you chose it when creating the key
              </span>
              <input
                type="password"
                autoComplete="off"
                className={inputCls}
                value={passphrase}
                onChange={(e) => {
                  setPassphrase(e.target.value);
                  setError(null);
                }}
              />
            </label>
          )}
          <label className="text-xs text-low">
            Label <span className="text-faint">(optional)</span>
            <input
              className={inputCls}
              value={label}
              autoComplete="off"
              placeholder="e.g. Main account"
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>

          {/* Where-to-find help: steps + breadcrumb path + the exchange's page */}
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setShowInstructions((v) => !v)}
              className="inline-flex items-center gap-1.5 self-start text-xs text-low underline underline-offset-2 hover:text-mid"
            >
              <CircleHelp className="h-3.5 w-3.5" />
              Where do I find this key?
              {showInstructions ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </button>
            {showInstructions && (
              <>
                <ol className="space-y-1.5">
                  {exchange.keyInstructions.map((step, i) => (
                    <li key={i} className="flex gap-2 text-xs text-mid">
                      <span className="mt-px grid h-4 w-4 shrink-0 place-items-center rounded-full bg-violet/15 font-mono text-[10px] font-bold text-violet">
                        {i + 1}
                      </span>
                      <span>{step}</span>
                    </li>
                  ))}
                </ol>
                <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
                  {exchange.path.map((crumb, i) => (
                    <span key={i} className="flex items-center gap-1.5">
                      <span className="rounded-md border border-white/10 bg-elev-3 px-2 py-0.5 text-mid">
                        {crumb}
                      </span>
                      {i < exchange.path.length - 1 && <span className="text-faint">›</span>}
                    </span>
                  ))}
                </div>
                <a
                  href={exchange.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 self-start text-xs text-violet underline underline-offset-2 hover:text-hi"
                >
                  Open {exchange.label}'s API page <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </div>
        </div>
      </div>

      {tested && !busy && (
        <div className="flex items-center gap-2 rounded-lg border border-violet/30 bg-violet/15 px-4 py-2.5 text-sm text-gain">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>✓ Connected — read-only access confirmed</span>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          disabled={busy || !requiredFilled}
          onClick={() => void runTest()}
        >
          {testing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Testing…
            </>
          ) : (
            <>
              <PlugZap className="h-4 w-4" /> Test connection
            </>
          )}
        </Button>
        <Button disabled={busy || !tested || syncRunning} onClick={() => void runSave()}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Saving…
            </>
          ) : (
            'Save connection'
          )}
        </Button>
      </div>

      {syncRunning && (
        <p className="mt-2 text-xs text-low">
          A sync is already running — wait for it to finish before adding a connection.
        </p>
      )}

      {/* Privacy reassurance (pinned copy, Section C-1 #2) */}
      <div className="flex items-start gap-3 rounded-lg border border-gain/20 bg-gain/[0.06] px-3 py-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gain/15 text-gain">
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div>
          <h5 className="text-xs font-bold text-hi">Your keys stay on this device</h5>
          <p className="mt-0.5 text-xs leading-relaxed text-mid">
            Your secret never leaves this device. Keys are stored only in this browser's local
            database and used right here to sign requests to your exchange — SoloLedger's relay
            can't read them. Create a <strong className="text-hi">read-only</strong> key (enable
            "read" only; disable trading and withdrawals) so the key can never move your funds.
          </p>
        </div>
      </div>
    </section>
  );
}
