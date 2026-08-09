import { useEffect, useState } from 'react';
import { ArrowLeft, Check, FileUp, Globe, PenLine, ShieldCheck, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { runInitialSync, type ExchangeConnectionView } from '@/lib/exchangeSync';
import type { ChainId } from '@/lib/rpc/providers';
import { ConnectionWizard } from '@/components/import/ConnectionWizard';
import { ManualEntryForm } from '@/components/import/ManualEntryForm';
import { Drawer } from './Drawer';
import { WhatStep, type FlowKind } from './WhatStep';
import { WhichStep, type ApiExchangeStates, type WhichSelection } from './WhichStep';
import { ExchangeConnectStep } from './ExchangeConnectStep';
import { WalletAddressForm } from './WalletAddressForm';
import { FileImportFlow } from './FileImportFlow';
import { BRAND_ICONS, BrandIcon, chainIconId } from './brandIcons';
import { getAutoSyncExchange } from '@/components/import/autoSyncExchanges';

interface AddDataDrawerProps {
  open: boolean;
  /** Guided mode renders the ConnectionWizard without the step rail. */
  guided: boolean;
  /** Deep-link straight into a flow ('file'/'manual' skip What + Which). */
  initialFlow: FlowKind | null;
  /** Independent exchange status sources for the Which step. */
  apiExchangeStates: ApiExchangeStates;
  fileImportedSlugs: string[];
  /** Existing source to restore in place; its id and exchange stay fixed. */
  reauthorizationTarget?: ExchangeConnectionView | null;
  onClose: () => void;
  onToast: (t: { tone: 'gain' | 'loss' | 'warn' | 'primary'; title: string; description?: string }) => void;
}

/** Flows that need a "Which one?" pick before the Connect step. */
const needsWhich = (f: FlowKind | null): f is 'exchange' | 'wallet-app' | 'chain' =>
  f === 'exchange' || f === 'wallet-app' || f === 'chain';

const RAIL_STEPS = [
  { n: 1, label: 'What' },
  { n: 2, label: 'Which' },
  { n: 3, label: 'Connect' }
] as const;

/** Vertical 3-step rail (sm+) / horizontal strip (mobile) — mockup `.rail`. */
function StepRail({ step, whichSkipped }: { step: 1 | 2 | 3; whichSkipped: boolean }) {
  return (
    <ol className="flex items-center gap-2 sm:flex-col sm:items-stretch sm:gap-0">
      {RAIL_STEPS.map((s, i) => {
        const done = s.n < step || (s.n === 2 && whichSkipped);
        const current = s.n === step && !done;
        return (
          <li key={s.n} className="flex items-center gap-2 sm:gap-0">
            {i > 0 && (
              <span
                aria-hidden="true"
                className={cn(
                  'mx-1 h-px w-5 sm:mx-0 sm:ml-[13px] sm:my-1 sm:h-6 sm:w-px',
                  s.n - 1 < step || (s.n === 3 && whichSkipped) ? 'bg-gain/40' : 'bg-hi/10'
                )}
              />
            )}
            <span
              className="flex items-center gap-2.5 sm:py-1"
              aria-current={current ? 'step' : undefined}
            >
              <span
                className={cn(
                  'grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold',
                  done
                    ? 'bg-gain/15 text-gain'
                    : current
                      ? 'bg-primary-solid text-white'
                      : 'bg-elev-3 text-low'
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : s.n}
              </span>
              <span
                className={cn(
                  'text-[13px] font-semibold',
                  current ? 'text-hi' : done ? 'text-mid' : 'text-low'
                )}
              >
                {s.label}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * AddDataDrawer (mockup `cv2-add-flow`) — the right-side drawer hosting every
 * add flow behind the locked 3-step rail: 1 What → 2 Which → 3 Connect.
 * File and manual flows skip Which (shown as done); guided mode swaps the
 * whole body for the ConnectionWizard without the rail.
 */
export function AddDataDrawer({
  open,
  guided,
  initialFlow,
  apiExchangeStates,
  fileImportedSlugs,
  reauthorizationTarget = null,
  onClose,
  onToast
}: AddDataDrawerProps) {
  const [flow, setFlow] = useState<FlowKind | null>(initialFlow);
  const [which, setWhich] = useState<WhichSelection | null>(null);
  const [guidedMode, setGuidedMode] = useState(guided);
  const [reauthorizing, setReauthorizing] = useState<ExchangeConnectionView | null>(
    reauthorizationTarget
  );

  // Fresh state every time the drawer opens.
  useEffect(() => {
    if (open) {
      setFlow(initialFlow);
      setWhich(null);
      setGuidedMode(guided);
      setReauthorizing(reauthorizationTarget);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const step: 1 | 2 | 3 = reauthorizing
    ? 3
    : flow === null
      ? 1
      : needsWhich(flow) && which === null
        ? 2
        : 3;
  const whichSkipped = step === 3 && !needsWhich(flow);

  const goBack = () => {
    if (step === 3) {
      if (needsWhich(flow)) setWhich(null);
      else setFlow(null);
    } else if (step === 2) {
      setFlow(null);
    }
  };

  const reauthorizationLabel = reauthorizing
    ? (getAutoSyncExchange(reauthorizing.exchange)?.label ?? reauthorizing.exchange)
    : null;

  // ── Titles / drawer aria-labels ──
  /** "a" / "an" by the label's first letter — "Watch an Ethereum address". */
  const articleFor = (label: string) => (/^[aeiou]/i.test(label) ? 'an' : 'a');
  const step2Title =
    flow === 'exchange' ? 'Exchange account' : flow === 'wallet-app' ? 'Wallet app' : 'Blockchain address';
  const step3Title = (() => {
    if (flow === 'exchange' && which?.kind === 'exchange-api') return `Connect ${which.label}`;
    if (flow === 'exchange' && which?.kind === 'exchange-file') return `Import a ${which.label} file`;
    if (flow === 'wallet-app' && which?.kind === 'wallet-app')
      // The generic any-wallet tile labels itself "My wallet" — "Watch a My
      // wallet address" reads broken (D-6); use the same generic title as __any.
      return which.id === 'any-wallet' ? 'Watch an address' : `Watch ${articleFor(which.label)} ${which.label} address`;
    if (flow === 'chain' && which?.kind === 'chain')
      return which.id === '__any' ? 'Watch an address' : `Watch ${articleFor(which.label)} ${which.label} address`;
    if (flow === 'manual') return 'Add one transaction';
    return 'Import a file';
  })();

  const title = reauthorizing
    ? `Reauthorize ${reauthorizationLabel}`
    : guidedMode
      ? 'Guided setup'
      : step === 1
        ? 'Add data'
        : step === 2
          ? step2Title
          : step3Title;
  const drawerLabel = guidedMode ? 'Guided setup' : step === 2 ? 'Add data — choose source' : title;

  // ── Step-3 body ──
  const renderConnect = () => {
    if (reauthorizing) {
      return (
        <ExchangeConnectStep
          exchangeId={reauthorizing.exchange}
          mode="reauthorize"
          existingId={reauthorizing.id}
          onConnected={() => {
            onClose();
            onToast({
              tone: 'gain',
              title: `${reauthorizationLabel} reauthorized`,
              description: 'Connection restored — syncing is available again.'
            });
          }}
          onUseFile={() => {
            setReauthorizing(null);
            setFlow('file');
            setWhich(null);
          }}
        />
      );
    }
    if (flow === 'exchange' && which?.kind === 'exchange-api') {
      return (
        <ExchangeConnectStep
          exchangeId={which.id}
          onConnected={(connection: ExchangeConnectionView) => {
            onClose();
            // First sync kicks off immediately; the staged preview / banners
            // surface on the Connections home via the global job store.
            void runInitialSync(connection.id).catch(() => undefined);
            onToast({
              tone: 'gain',
              title: `${which.label} connected`,
              description: 'First sync started — review what it finds before anything is saved.'
            });
          }}
          onUseFile={() => setWhich({ kind: 'exchange-file', id: which.id, label: which.label })}
        />
      );
    }
    if (flow === 'exchange' && which?.kind === 'exchange-file') return <FileImportFlow sourceId={which.id} />;
    if (flow === 'wallet-app' && which?.kind === 'wallet-app') {
      return (
        <WalletAddressForm
          defaultLabel={which.label}
          walletAppId={which.id}
          preselectChain={which.preselectChain as ChainId | undefined}
          onAddAnother={() => setWhich(null)}
          onContinueInBackground={onClose}
        />
      );
    }
    if (flow === 'chain' && which?.kind === 'chain') {
      return (
        <WalletAddressForm
          preselectChain={which.id === '__any' ? undefined : (which.id as ChainId)}
          onAddAnother={() => setWhich(null)}
          onContinueInBackground={onClose}
        />
      );
    }
    if (flow === 'manual') {
      return (
        <ManualEntryForm
          onSaved={() => {
            onClose();
            onToast({
              tone: 'gain',
              title: 'Transaction added',
              description: 'Head to Review to categorize it.'
            });
          }}
        />
      );
    }
    return <FileImportFlow />; // flow === 'file'
  };

  /** Brand/lucide icon chip in the Connect-step header. */
  const connectIcon = (() => {
    if (reauthorizing) {
      const exchange = getAutoSyncExchange(reauthorizing.exchange);
      return (
        <BrandIcon
          id={reauthorizing.exchange in BRAND_ICONS ? reauthorizing.exchange : null}
          fallback={exchange?.monogram ?? reauthorizationLabel ?? ''}
          size={36}
        />
      );
    }
    if (flow === 'exchange' && which?.kind === 'exchange-api') {
      const exchange = getAutoSyncExchange(which.id);
      return (
        <BrandIcon
          id={which.id in BRAND_ICONS ? which.id : null}
          fallback={exchange?.monogram ?? which.label}
          size={36}
        />
      );
    }
    if (flow === 'wallet-app' && which?.kind === 'wallet-app') {
      return <BrandIcon id={which.id} fallback={which.label} size={36} />;
    }
    if (flow === 'chain' && which?.kind === 'chain') {
      const iconId = which.id === '__any' ? null : chainIconId(which.id);
      if (iconId) return <BrandIcon id={iconId} fallback={which.label} size={36} />;
      return (
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/10 text-accent">
          <Globe className="h-4 w-4" aria-hidden="true" />
        </span>
      );
    }
    if (flow === 'manual') {
      return (
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-loss/10 text-loss">
          <PenLine className="h-4 w-4" aria-hidden="true" />
        </span>
      );
    }
    return (
      <span className="grid h-9 w-9 place-items-center rounded-xl bg-warn/10 text-warn">
        <FileUp className="h-4 w-4" aria-hidden="true" />
      </span>
    );
  })();

  return (
    <Drawer open={open} onClose={onClose} label={drawerLabel} wide>
      {guidedMode ? (
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-hi/10 px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[15px] font-bold text-hi">Guided setup</h2>
              <p className="text-xs text-low">Step by step</p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-[10px] text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <ConnectionWizard
              onComplete={(savedCount) => {
                onClose();
                onToast({
                  tone: 'gain',
                  title: 'Guided setup complete',
                  description:
                    savedCount > 0
                      ? `${savedCount} transaction${savedCount === 1 ? '' : 's'} saved to your ledger.`
                      : undefined
                });
              }}
              onExit={() => {
                setGuidedMode(false);
                setFlow(null);
                setWhich(null);
              }}
            />
          </div>
        </div>
      ) : (
        <div className="flex h-full flex-col sm:flex-row">
          {/* Step rail: horizontal strip on mobile, vertical aside on sm+ */}
          {!reauthorizing && (
            <aside className="shrink-0 border-b border-hi/10 px-4 py-3 sm:w-[136px] sm:border-b-0 sm:border-r sm:py-5">
              <StepRail step={step} whichSkipped={whichSkipped} />
            </aside>
          )}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* dhead */}
            <div className="flex shrink-0 items-center gap-2 border-b border-hi/10 px-4 py-3.5">
              {step > 1 && !reauthorizing && (
                <button
                  type="button"
                  aria-label="Back"
                  onClick={goBack}
                  className="-ml-1 grid h-11 w-11 shrink-0 place-items-center rounded-[10px] text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                >
                  <ArrowLeft className="h-5 w-5" aria-hidden="true" />
                </button>
              )}
              {step === 3 && connectIcon}
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[15px] font-bold text-hi">{title}</h2>
                <p className="text-xs text-low">
                  {reauthorizing ? 'Existing connection · label and history stay unchanged' : `Step ${step} of 3`}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="-mr-1 grid h-11 w-11 shrink-0 place-items-center rounded-[10px] text-low transition-colors hover:bg-elev-3 hover:text-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>

            {/* dbody */}
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {step === 1 && <WhatStep onPick={setFlow} />}
              {step === 2 && needsWhich(flow) && (
                <WhichStep
                  flow={flow}
                  apiExchangeStates={apiExchangeStates}
                  fileImportedSlugs={fileImportedSlugs}
                  onPick={setWhich}
                />
              )}
              {step === 3 && renderConnect()}
            </div>

            {/* dfoot — privacy caption on step 1 (mockup `drawer-privacy-note`) */}
            {step === 1 && (
              <div className="shrink-0 border-t border-hi/10 px-4 py-3">
                <p className="flex items-center gap-2 text-xs leading-relaxed text-low">
                  <ShieldCheck className="h-4 w-4 shrink-0 text-gain" aria-hidden="true" />
                  <span>Keys, files and history stay on this device — whatever you pick.</span>
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}
