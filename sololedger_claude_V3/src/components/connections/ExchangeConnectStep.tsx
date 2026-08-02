import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Lock,
  PlugZap,
  ShieldCheck
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useAppMode } from '@/lib/saas/modeContext';
import { isExchangeSyncEnabled } from '@/lib/saas/effectiveSettings';
import {
  addConnection,
  reauthorizeConnection,
  testConnection,
  useExchangeSyncJob,
  AUTO_SYNC_HOSTED_ONLY,
  type ExchangeConnectionView,
  type ExchangeId
} from '@/lib/exchangeSync';
import { getAutoSyncExchange } from '@/components/import/autoSyncExchanges';

interface ExchangeConnectStepProps {
  exchangeId: ExchangeId;
  mode?: 'connect' | 'reauthorize';
  existingId?: string;
  /** Saved + first sync kicked off — the drawer closes and toasts. */
  onConnected: (connection: ExchangeConnectionView) => void;
  /** "Import a file instead" — the drawer switches to the file flow. */
  onUseFile: () => void;
}

const inputCls =
  'h-11 w-full rounded-lg border border-hi/10 bg-elev-1 px-3.5 pr-11 text-sm text-hi shadow-xs transition-colors placeholder:text-faint hover:border-hi/20 focus:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/30';

/**
 * Drawer step 3 (exchange) — connect via a read-only API key. Re-flow of the
 * old AddConnectionForm into the Connections v2 design: the exchange was
 * already picked in step 2, concise read-only instructions lead the fields,
 * and the footer is a single "Connect securely" action. The tested-fingerprint
 * contract is unchanged: Connect stays disabled until "Test connection"
 * passes for the EXACT current field values; any edit re-locks it.
 *
 * Mode gating is unchanged from AutoSyncPanel: local/BYOK shows the pinned
 * hosted-only explainer; hosted with the server flag off shows the
 * "temporarily unavailable" note.
 */
export function ExchangeConnectStep({
  exchangeId,
  mode: formMode = 'connect',
  existingId,
  onConnected,
  onUseFile
}: ExchangeConnectStepProps) {
  const { mode, selectMode } = useAppMode();
  const hosted = mode === 'hosted';
  const job = useExchangeSyncJob();
  const exchange = getAutoSyncExchange(exchangeId)!;

  const [flagEnabled, setFlagEnabled] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [secret, setSecret] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [label, setLabel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Fingerprint of the field values that last PASSED "Test connection". */
  const [testedFingerprint, setTestedFingerprint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hosted) return;
    let live = true;
    void isExchangeSyncEnabled().then((v) => {
      if (live) setFlagEnabled(v);
    });
    return () => {
      live = false;
    };
  }, [hosted]);

  const fingerprint = useMemo(
    () => JSON.stringify([exchangeId, apiKey.trim(), secret.trim(), passphrase.trim()]),
    [exchangeId, apiKey, secret, passphrase]
  );
  const requiredFilled =
    apiKey.trim().length > 0 &&
    secret.trim().length > 0 &&
    (!exchange.needsPassphrase || passphrase.trim().length > 0);
  /** Connect unlocks only when the CURRENT values are exactly the tested ones. */
  const tested = testedFingerprint === fingerprint;
  const busy = testing || saving;
  const reauthorizing = formMode === 'reauthorize';

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
      if (reauthorizing && !existingId) {
        throw new Error('Connection not found — reopen reauthorization and try again.');
      }
      const input = connectionInput();
      const view = reauthorizing
        ? await reauthorizeConnection(existingId!, {
            apiKey: input.apiKey,
            secret: input.secret,
            passphrase: input.passphrase
          })
        : await addConnection(input);
      onConnected(view);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the connection — try again.');
      setSaving(false);
    }
  };

  // ── local / BYOK: hosted-only explainer (pinned copy, unchanged) ──
  if (!hosted) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-hi/20 bg-elev-1 px-6 py-10 text-center">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-primary/10 text-primary">
          <CloudOff className="h-6 w-6" aria-hidden="true" />
        </span>
        <div>
          <p className="text-[15px] font-bold text-hi">Auto-sync needs a Hosted account</p>
          <p className="mt-2 text-sm leading-relaxed text-mid">{AUTO_SYNC_HOSTED_ONLY}</p>
        </div>
        <Button onClick={() => selectMode('hosted')}>Switch to Hosted mode</Button>
        <p className="flex items-start gap-2 text-xs leading-relaxed text-low">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Switching is free and takes a minute — everything you've already imported stays right
            here. Rather stay fully local?{' '}
            <button
              type="button"
              onClick={onUseFile}
              className="font-medium text-mid underline underline-offset-2 transition-colors hover:text-hi"
            >
              Import a file instead
            </button>
          </span>
        </p>
      </div>
    );
  }

  // ── hosted, flag not resolved yet ──
  if (flagEnabled === null) {
    return <p className="py-6 text-sm text-low">Checking auto-sync availability…</p>;
  }

  // ── hosted, admin flag off ──
  if (flagEnabled === false) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Auto-sync is temporarily unavailable — please use CSV import.</span>
        </div>
        <Button variant="secondary" onClick={onUseFile}>
          Import a file instead
        </Button>
      </div>
    );
  }

  // ── hosted + enabled: the connect form ──
  return (
    <div className="flex flex-col gap-4" data-testid="exchange-connect">
      {/* Static instructions lead the form; they are guidance, not a completion gate. */}
      <div data-testid="key-instructions">
        <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.09em] text-low">
          Get a read-only key
        </p>
        <ol className="list-decimal space-y-2 rounded-xl border border-hi/10 bg-elev-1 py-3 pl-9 pr-3.5 text-[13px] leading-relaxed text-mid marker:font-semibold marker:text-primary">
          {exchange.keyInstructions.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <a
          href={exchange.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-2.5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-primary underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          Open {exchange.label} API page <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      </div>

      {!reauthorizing && (
        <div>
          <label htmlFor="ecx-label" className="text-xs font-semibold text-mid">
            Label <span className="font-normal text-faint">(optional)</span>
          </label>
          <input
            id="ecx-label"
            autoComplete="off"
            placeholder="e.g. Main account"
            className={cn(inputCls, 'mt-1')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
      )}

      {/* Credentials with show/hide eyes */}
      <div>
        <label htmlFor="ecx-apikey" className="text-xs font-semibold text-mid">
          API key
        </label>
        <div className="relative mt-1">
          <input
            id="ecx-apikey"
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            className={cn(inputCls, 'font-mono')}
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              setError(null);
            }}
          />
          <button
            type="button"
            aria-label={showKey ? 'Hide API key' : 'Show API key'}
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-[10px] text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {showKey ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      <div>
        <label htmlFor="ecx-secret" className="text-xs font-semibold text-mid">
          API secret
        </label>
        <div className="relative mt-1">
          <input
            id="ecx-secret"
            type={showSecret ? 'text' : 'password'}
            autoComplete="off"
            className={cn(inputCls, 'font-mono')}
            value={secret}
            onChange={(e) => {
              setSecret(e.target.value);
              setError(null);
            }}
          />
          <button
            type="button"
            aria-label={showSecret ? 'Hide API secret' : 'Show API secret'}
            onClick={() => setShowSecret((v) => !v)}
            className="absolute right-1 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-[10px] text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {showSecret ? (
              <EyeOff className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Eye className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      {exchange.needsPassphrase && (
        <div>
          <label htmlFor="ecx-passphrase" className="text-xs font-semibold text-mid">
            Passphrase{' '}
            <span className="font-normal text-faint">
              — {exchange.label} keys have this extra word; you chose it when creating the key
            </span>
          </label>
          <div className="relative mt-1">
            <input
              id="ecx-passphrase"
              type="password"
              autoComplete="off"
              className={cn(inputCls, 'pr-3.5 font-mono')}
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                setError(null);
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-loss/30 bg-loss/10 px-3 py-2 text-xs text-loss">
          {error}
        </div>
      )}

      {tested && !busy && (
        <div className="flex items-center gap-2 rounded-lg border border-gain/30 bg-gain/10 px-4 py-2.5 text-sm text-gain">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Connected — read-only access confirmed</span>
        </div>
      )}

      <div className="flex items-center gap-3">
        <Button
          variant="secondary"
          disabled={busy || !requiredFilled}
          onClick={() => void runTest()}
        >
          {testing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Testing…
            </>
          ) : (
            <>
              <PlugZap className="h-4 w-4" aria-hidden="true" /> Test connection
            </>
          )}
        </Button>
      </div>

      {/* Footer action + privacy caption */}
      <div className="sticky bottom-0 -mx-1 mt-2 border-t border-hi/10 bg-elev-1 px-1 pb-1 pt-3">
        <Button
          className="w-full"
          disabled={busy || !tested || job.active}
          onClick={() => void runSave()}
        >
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {reauthorizing ? ' Reauthorizing…' : ' Connecting…'}
            </>
          ) : (
            <>
              <Lock className="h-4 w-4" aria-hidden="true" />
              {reauthorizing ? ' Reauthorize securely' : ' Connect securely'}
            </>
          )}
        </Button>
        {job.active && (
          <p className="mt-2 text-xs text-low">
            A sync is already running — wait for it to finish before{' '}
            {reauthorizing ? 'reauthorizing' : 'adding'} a connection.
          </p>
        )}
        <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-low">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gain" aria-hidden="true" />
          <span>
            Signed on this device — your secret never leaves it. Keys are stored only in this
            browser's local database and used right here to sign requests to your exchange.
          </span>
        </p>
      </div>
    </div>
  );
}
