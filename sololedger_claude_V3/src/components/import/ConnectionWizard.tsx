import { useCallback, useMemo, useReducer, useRef, useState } from 'react';
import {
  Upload,
  Check,
  ChevronRight,
  AlertTriangle,
  ShieldCheck,
  Loader2,
  ArrowLeft
} from 'lucide-react';
import {
  parseImportFile,
  isSpreadsheetFile,
  type FileParseOutcome
} from '@/lib/parsers';
import { parseWithMapping } from '@/lib/parsers/generic';
import { confirmAddressOrientation, confirmSheetOrientations } from '@/lib/parsers/addressOrientation';
import { suggestCsvMappingWithAi } from '@/lib/ai/csvMapping';
import {
  db,
  getSettings,
  hashFileContent,
  upsertCsvImport,
  countCsvImportTransactions,
  deduplicateTransactions
} from '@/lib/storage/db';
import { convertOrNormalizeForImport } from '@/lib/pricing/fiatConvert';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import { getEffectiveSettings, isAiMappingAvailable } from '@/lib/saas/effectiveSettings';
import { normalizeFiatMagnitude } from '@/lib/parsers/types';
import { buildFallbackMessages, FixTheFileGuidance } from './importFallback';
import { ImportPreviewCard } from './ImportPreviewCard';
import type { Transaction } from '@/types/transaction';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  IMPORT_SOURCES,
  getImportSource,
  type ImportSource
} from './importSources';
import {
  wizardReducer,
  initialWizardState,
  WIZARD_STEP_ORDER,
  type WizardStep
} from './wizardReducer';

interface ConnectionWizardProps {
  /** Called after transactions are confirmed and persisted. */
  onComplete?: (savedCount: number) => void;
  /** Called if the user backs out of the wizard entirely (from step 1). */
  onExit?: () => void;
  /**
   * Called when the user abandons the guided setup for the plain Import tab.
   * When provided, a subtle "Skip setup" footer link stays visible on EVERY
   * wizard step (the onboarding flow passes it; the Import tab's embedded
   * wizard does not — that user is already on Import).
   */
  onSkip?: () => void;
}

/** A parsed, not-yet-persisted preview of a dropped file. */
interface PreviewData {
  transactions: Transaction[];
  parserId: string | null;
  hash: string;
  fileName: string;
  fileSize: number;
  warnings: string[];
  /** Rows missing a fiat value — surfaced so the user knows before confirming. */
  missingPriceCount: number;
  distinctAssets: number;
  tdsTotalInr: number;
  /** True when AI mapping was applied but not every required field resolved. */
  aiIncomplete: boolean;
}

const STEP_LABELS: Record<WizardStep, string> = {
  pick: 'Pick exchange',
  instructions: 'Export steps',
  upload: 'Upload file',
  preview: 'Preview & confirm'
};

function Stepper({ current }: { current: WizardStep }) {
  const currentIndex = WIZARD_STEP_ORDER.indexOf(current);
  return (
    <div className="flex items-center" data-testid="wizard-stepper">
      {WIZARD_STEP_ORDER.map((step, i) => {
        const state = i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'todo';
        return (
          <div key={step} className="flex flex-1 items-center last:flex-none">
            <div className="flex items-center gap-2.5">
              <div
                className={cn(
                  'grid h-8 w-8 shrink-0 place-items-center rounded-full text-xs font-bold',
                  state === 'done' && 'border border-gain/40 bg-gain/15 text-gain',
                  state === 'active' && 'bg-aurora text-[#0A0B1A] shadow-glow',
                  state === 'todo' && 'border border-white/10 bg-elev-2 text-low'
                )}
              >
                {state === 'done' ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              <div className="hidden sm:block">
                <div className="font-mono text-[10px] font-semibold uppercase tracking-wider text-low">
                  Step {i + 1}
                </div>
                <div
                  className={cn(
                    'text-[13px] font-bold',
                    state === 'active' ? 'text-hi' : 'text-mid'
                  )}
                >
                  {STEP_LABELS[step]}
                </div>
              </div>
            </div>
            {i < WIZARD_STEP_ORDER.length - 1 && (
              <div
                className={cn(
                  'mx-3 h-0.5 flex-1',
                  i < currentIndex ? 'bg-gradient-to-r from-gain to-violet' : 'bg-white/10'
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SourceTile({
  source,
  chosen,
  onChoose
}: {
  source: ImportSource;
  chosen: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      className={cn(
        'flex w-full items-center gap-3 rounded-[10px] border px-3 py-2.5 text-left transition-colors',
        chosen
          ? 'border-gain/50 bg-gain/[0.06]'
          : 'border-white/10 bg-elev-3/50 hover:border-white/20'
      )}
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-aurora font-mono text-[11px] font-extrabold text-[#0A0B1A]">
        {source.monogram}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-bold text-hi">{source.label}</span>
        <span className="block text-[10.5px] text-low">{source.formatHint}</span>
      </span>
      {chosen && <Check className="ml-auto h-4 w-4 shrink-0 text-gain" />}
    </button>
  );
}

export function ConnectionWizard({ onComplete, onExit, onSkip }: ConnectionWizardProps) {
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savePhase, setSavePhase] = useState<'saving' | 'pricing' | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Actionable fix-the-file + AI-last-resort guidance when a file can't be read. */
  const [fallbackMessages, setFallbackMessages] = useState<string[]>([]);
  /** Whether AI column-mapping is actually available (own key, or hosted with server AI enabled). */
  const [aiAvailable, setAiAvailable] = useState(false);
  /** Parsed-but-unrecognized file kept so an explicit "Try AI mapping" click can map it. */
  const [pendingUnrecognized, setPendingUnrecognized] = useState<{
    headers: string[];
    rows: Record<string, string>[];
    hash: string;
    fileName: string;
    fileSize: number;
  } | null>(null);
  /** True while an explicit AI-mapping request is in flight. */
  const [aiMapping, setAiMapping] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  /** Files queued after the one currently being read (multi-file drops). */
  const [fileQueue, setFileQueue] = useState<File[]>([]);
  /** Total files in the current batch — drives the "file N of M" progress copy. */
  const [queueTotal, setQueueTotal] = useState(0);
  /** Non-blocking note about batch files that were skipped (e.g. duplicates). */
  const [queueNote, setQueueNote] = useState<string | null>(null);
  /** Appends one sentence to the batch note (space-separated accumulation). */
  const appendQueueNote = useCallback((note: string) => {
    setQueueNote((prev) => (prev ? `${prev} ${note}` : note));
  }, []);
  /** Transactions confirmed so far across a multi-file batch. A ref, not
   *  state: it accumulates inside async file chaining where render closures
   *  go stale, and it is never rendered directly. */
  const batchSavedRef = useRef(0);

  const source = useMemo(() => getImportSource(state.source), [state.source]);
  const india = IMPORT_SOURCES.filter((s) => s.region === 'india');
  const global = IMPORT_SOURCES.filter((s) => s.region === 'global');

  // Build a preview WITHOUT persisting — this is C1's missing gate. Auto-detect
  // parsers run first; if the format isn't recognized we surface fix-the-file
  // guidance and an explicit "Try AI mapping" button — AI never fires
  // automatically, so column headers + sample rows are only sent after the
  // user opts in (with the disclosure visible).
  const showPreview = useCallback(
    (
      transactions: Transaction[],
      parserId: string | null,
      hash: string,
      file: { name: string; size: number },
      warnings: string[],
      aiIncomplete: boolean
    ) => {
      const distinctAssets = new Set(transactions.map((t) => t.asset)).size;
      const missingPriceCount = transactions.filter(
        (t) => t.fiatValue == null && !t.isInternalTransfer
      ).length;
      const tdsTotalInr = transactions.reduce((sum, t) => sum + (t.tdsInr ?? 0), 0);
      setPreview({
        transactions,
        parserId,
        hash,
        fileName: file.name,
        fileSize: file.size,
        warnings,
        missingPriceCount,
        distinctAssets,
        tdsTotalInr,
        aiIncomplete
      });
      setFallbackMessages([]);
      setPendingUnrecognized(null);
      dispatch({ type: 'fileReady' });
      dispatch({ type: 'preview' });
    },
    []
  );

  /**
   * Read and preview ONE file. `queue` holds the files still waiting after
   * this one — threaded as a parameter (NOT read from state) because this
   * function chains into itself asynchronously, where a render closure would
   * go stale and re-dequeue the file already being processed.
   */
  const readFile = useCallback(
    async (file: File, queue: File[]) => {
      setError(null);
      setFallbackMessages([]);
      setPendingUnrecognized(null);
      setSavedCount(null);
      setReading(true);
      // True when this file chained into the next queued one — the chained
      // read keeps `reading` on, so the finally must not switch it off.
      let chained = false;
      try {
        const hashInput = isSpreadsheetFile(file) ? await file.arrayBuffer() : await file.text();
        const hash = await hashFileContent(hashInput);

        const existing = await db.csvImports.get(hash);
        if (existing) {
          if (queue.length > 0) {
            // Batch mode: skip an already-imported file instead of stranding
            // the queue — note it and chain straight into the next file.
            const [next, ...rest] = queue;
            setFileQueue(rest);
            setQueueNote((prev) => `${prev ? `${prev} ` : ''}Skipped already-imported file: ${file.name}.`);
            chained = true;
            void readFile(next, rest);
            return;
          }
          if (batchSavedRef.current > 0) {
            // Duplicate as the LAST file of a batch: end with the aggregated
            // batch outcome (banner + skip note), not the single-file error.
            const total = batchSavedRef.current;
            batchSavedRef.current = 0;
            setQueueTotal(0);
            setQueueNote((prev) => `${prev ? `${prev} ` : ''}Skipped already-imported file: ${file.name}.`);
            setSavedCount(total);
            onComplete?.(total);
            return;
          }
          setError(`"${file.name}" was already imported. Remove it from the Import tab to re-import.`);
          return;
        }

        const result: FileParseOutcome = await parseImportFile(file);
        // Whether AI mapping is actually available (own key, or hosted with the
        // server's aiAdvisorEnabled). Drives the "Try AI mapping" affordance.
        const aiOn = await isAiMappingAvailable();
        setAiAvailable(aiOn);

        if (result.transactions.length === 0) {
          // Do NOT auto-run AI mapping — that would relay headers + sample rows
          // before the user sees the disclosure. Surface actionable
          // fix-the-file guidance and keep the parsed rows around so an explicit
          // "Try AI mapping" click (which shows the disclosure) can map them.
          const missing = result.missingFields;
          setFallbackMessages(buildFallbackMessages(missing, aiOn));
          setError(null);
          if (result.rows.length > 0) {
            setPendingUnrecognized({
              headers: result.headers,
              rows: result.rows,
              hash,
              fileName: file.name,
              fileSize: file.size
            });
          }
          return;
        }

        // Best-effort orientation confirmation for ambiguous-Address sheets
        // (non-local only). Only ambiguous sheets' rows are re-oriented; other
        // sheets are left untouched. Non-fatal — failures keep the baseline.
        const orientedTransactions = await confirmSheetOrientations(
          result.sheets,
          result.transactions
        );

        showPreview(
          orientedTransactions,
          result.detectedParser,
          hash,
          file,
          [...result.warnings],
          false
        );
      } catch {
        // A file that throws mid-read (corrupt workbook, parser failure, hash
        // error) must NOT strand the rest of a batch with an unhandled
        // rejection (`void readFile(...)` swallows nothing). Note the failed
        // file and continue the chain — the same pattern as the
        // duplicate-skip path above.
        const skippedNote = `${file.name} couldn't be read — skipped.`;
        if (queue.length > 0) {
          const [next, ...rest] = queue;
          setFileQueue(rest);
          appendQueueNote(skippedNote);
          chained = true;
          void readFile(next, rest);
        } else if (batchSavedRef.current > 0) {
          // The LAST file of a batch failed: still end with the aggregated
          // batch outcome (banner + failure note) so the files that saved
          // are reported and onboarding can advance.
          const total = batchSavedRef.current;
          batchSavedRef.current = 0;
          setQueueTotal(0);
          appendQueueNote(skippedNote);
          setSavedCount(total);
          onComplete?.(total);
        } else {
          // Single-file failure: surface a blocking error instead of letting
          // the rejection escape silently.
          setError(
            `"${file.name}" couldn't be read — the file may be corrupt or in an unexpected format.`
          );
        }
      } finally {
        if (!chained) setReading(false);
      }
    },
    [showPreview, onComplete, appendQueueNote]
  );

  /**
   * Explicit, user-triggered AI column-mapping for an unrecognized file.
   * Reachable only via the "Try AI mapping" button (rendered under the
   * data-sharing disclosure), so headers + sample rows are never relayed
   * without the user's knowledge.
   */
  const runAiMapping = useCallback(async () => {
    if (!pendingUnrecognized) return;
    setAiMapping(true);
    try {
      const settings = await getSettings();
      const suggestion = await suggestCsvMappingWithAi(
        // Hosted mode: openrouter.ts injects the real key server-side and
        // ignores this arg; pass '' as a placeholder.
        settings.aiApiKey ?? '',
        pendingUnrecognized.headers,
        pendingUnrecognized.rows,
        settings.aiModel
      );
      const warnings: string[] = [];
      let aiIncomplete = false;
      if (!suggestion.valid) {
        aiIncomplete = true;
        warnings.push(
          `AI could not confidently map: ${suggestion.missingFields.join(', ')}. Review the mapping on the Import tab before saving.`
        );
      }
      const mapped = parseWithMapping(
        pendingUnrecognized.rows,
        {
          timestamp: suggestion.mapping.timestamp ?? '',
          type: suggestion.mapping.type ?? '',
          asset: suggestion.mapping.asset ?? '',
          amount: suggestion.mapping.amount ?? '',
          totalValue: suggestion.mapping.totalValue,
          pricePerUnit: suggestion.mapping.pricePerUnit,
          fiatValue: suggestion.mapping.fiatValue,
          fiatCurrency: suggestion.mapping.fiatCurrency,
          feeAmount: suggestion.mapping.feeAmount,
          feeAsset: suggestion.mapping.feeAsset,
          assetIsTradingPair: suggestion.mapping.assetIsTradingPair,
          typeValueMap: suggestion.mapping.typeValueMap ?? {}
        },
        settings.reportingCurrency
      );

      if (mapped.transactions.length === 0) {
        setFallbackMessages([
          `AI could not confidently map this file${
            suggestion.missingFields.length ? ` (missing: ${suggestion.missingFields.join(', ')})` : ''
          }. Map the columns manually on the Import tab.`
        ]);
        return;
      }

      warnings.push(
        `AI mapped the columns (${suggestion.confidence} confidence): ${suggestion.explanation}`,
        ...mapped.warnings
      );
      const aiOriented = mapped.addressColumnAmbiguous
        ? await confirmAddressOrientation(mapped.transactions)
        : mapped.transactions;
      showPreview(
        aiOriented,
        'ai_mapping',
        pendingUnrecognized.hash,
        { name: pendingUnrecognized.fileName, size: pendingUnrecognized.fileSize },
        warnings,
        aiIncomplete
      );
    } catch {
      setFallbackMessages([
        'AI mapping failed. Map the columns manually on the Import tab, or try a different export.'
      ]);
    } finally {
      setAiMapping(false);
    }
  }, [pendingUnrecognized, showPreview]);

  /**
   * Accept one or many files. Multi-file batches are processed SEQUENTIALLY —
   * each file gets its own preview + explicit confirm; confirming file N reads
   * file N+1, and the success banner appears (with the batch total) only after
   * the last file is confirmed.
   */
  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      const files = Array.from(fileList ?? []);
      if (files.length === 0) return;
      const [first, ...rest] = files;
      setFileQueue(rest);
      setQueueTotal(files.length);
      setQueueNote(null);
      batchSavedRef.current = 0;
      void readFile(first, rest);
    },
    [readFile]
  );

  // Persist ONLY on explicit confirm — mirrors ImportTab's persist pipeline.
  const confirmSave = useCallback(async () => {
    if (!preview) return;
    dispatch({ type: 'confirm' });
    setSaving(true);
    setSavePhase('saving');
    setError(null);
    try {
      // Raw local settings carry BYOK API keys; effective settings decide
      // whether Live price lookup is on (server-driven ON in hosted, OFF locally).
      const settings = await getSettings();
      const priceApiEnabled = (await getEffectiveSettings()).priceApiEnabled;
      const stamped = preview.transactions.map((t) => ({
        ...t,
        importBatchId: preview.hash,
        source: t.source || preview.parserId || 'import',
        fiatValue: normalizeFiatMagnitude(t.fiatValue),
        feeAmount: t.feeAmount != null ? Math.abs(t.feeAmount) : undefined
      }));

      // The pre-pricing save pipeline is isolated from pricing. A failure
      // HERE means nothing was durably written, so the error banner shows,
      // the preview stays open, and the queued files are preserved — the
      // user can confirm again to retry the whole batch.
      let savedNow = 0;
      try {
        const { transactions: converted } = await convertOrNormalizeForImport(
          stamped,
          settings,
          priceApiEnabled
        );
        await db.transactions.bulkPut(converted);
        await deduplicateTransactions();
        // Post-dedup rows attributable to this file — NOT the parsed preview
        // count. Overlapping re-exports (new hash, same rows) dedupe away, and
        // the banner must not claim those rows were saved.
        savedNow = await countCsvImportTransactions(preview.hash);
        await upsertCsvImport(preview.hash, preview.fileName, preview.parserId, savedNow);
      } catch {
        setError(`"${preview.fileName}" couldn't be saved — Confirm again to retry.`);
        return;
      }

      if (priceApiEnabled) {
        setSavePhase('pricing');
        try {
          await fetchMissingPricesForAllTransactions(settings);
        } catch {
          // Pricing is network/hosted dependent — a failure must NOT strand a
          // multi-file batch (the file itself is already safely saved, and a
          // throw here previously killed the chain AFTER file 1). Degrade to
          // a warning note and let the chain continue.
          appendQueueNote(
            "Saved, but live prices couldn't be fetched right now — they'll be retried on your next import."
          );
        }
      }

      if (fileQueue.length > 0) {
        // Batch mode: keep the wizard open and read the next queued file. The
        // success banner (with the running total) — and the onComplete signal
        // — are deferred to the last file, so consumers like onboarding don't
        // unmount the wizard mid-batch.
        const [next, ...rest] = fileQueue;
        setFileQueue(rest);
        batchSavedRef.current += savedNow;
        setPreview(null);
        dispatch({ type: 'clearFile' });
        void readFile(next, rest);
      } else {
        const total = batchSavedRef.current + savedNow;
        batchSavedRef.current = 0;
        setSavedCount(total);
        setQueueTotal(0);
        onComplete?.(total);
      }
    } finally {
      setSaving(false);
      setSavePhase(null);
    }
  }, [preview, onComplete, fileQueue, readFile, appendQueueNote]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-title">Let's bring your trades in — one step at a time</h2>
        <p className="mt-1 max-w-2xl text-sm text-mid">
          Pick your exchange, follow the export steps, drop in the file, and check the preview.
          Your file is parsed right here in your browser — nothing is uploaded (unless you opt into
          AI mapping, which sends only column names and a few sample rows).
        </p>
      </div>

      <Stepper current={state.step} />

      {savedCount !== null ? (
        <div className="space-y-3">
          {savedCount > 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-gain/30 bg-gain/10 px-4 py-3 text-sm text-gain">
              <Check className="h-4 w-4 shrink-0" />
              Saved {savedCount} transaction{savedCount === 1 ? '' : 's'} to your local ledger. Head to
              Review to categorize them.
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-xl border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              No new transactions — everything you imported was already in your ledger.
            </div>
          )}
          {/* Batch files skipped along the way (e.g. duplicates) stay visible next to the final banner. */}
          {queueNote && (
            <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-xs text-warn">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{queueNote}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-2xl border border-violet/30 bg-elev-2 p-5 shadow-card">
          {/* ── STEP 1 · pick exchange ── */}
          {state.step === 'pick' && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-extrabold text-hi">Which exchange?</h3>
                <p className="mt-1 text-xs text-low">
                  India's exchanges first. Pick one to start — you can add more later.
                </p>
              </div>
              <div>
                <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-teal">
                  India
                  <span className="h-px flex-1 bg-gradient-to-r from-teal/40 to-transparent" />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {india.map((s) => (
                    <SourceTile
                      key={s.id}
                      source={s}
                      chosen={state.source === s.id}
                      onChoose={() => dispatch({ type: 'selectSource', source: s.id })}
                    />
                  ))}
                </div>
              </div>
              <div>
                <div className="mb-2 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-low">
                  Global
                  <span className="h-px flex-1 bg-gradient-to-r from-white/10 to-transparent" />
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  {global.map((s) => (
                    <SourceTile
                      key={s.id}
                      source={s}
                      chosen={state.source === s.id}
                      onChoose={() => dispatch({ type: 'selectSource', source: s.id })}
                    />
                  ))}
                </div>
              </div>
              {onExit && (
                <div className="pt-1">
                  <Button variant="ghost" onClick={onExit}>
                    <ArrowLeft className="h-4 w-4" /> Back
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* ── STEP 2 · export instructions ── */}
          {state.step === 'instructions' && source && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-aurora font-mono text-xs font-extrabold text-[#0A0B1A]">
                  {source.monogram}
                </span>
                <div>
                  <h3 className="text-base font-extrabold text-hi">Export from {source.label}</h3>
                  <p className="mt-0.5 text-xs text-low">
                    Follow these steps, then come back and drop the file in.
                  </p>
                </div>
              </div>
              <ol className="space-y-2.5">
                {source.steps.map((step, i) => (
                  <li key={i} className="flex gap-3 text-sm text-mid">
                    <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-violet/15 font-mono text-[11px] font-bold text-violet">
                      {i + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px]">
                {source.path.map((crumb, i) => (
                  <span key={i} className="flex items-center gap-1.5">
                    <span className="rounded-md border border-white/10 bg-elev-3 px-2 py-0.5 text-mid">
                      {crumb}
                    </span>
                    {i < source.path.length - 1 && <span className="text-faint">›</span>}
                  </span>
                ))}
              </div>
              {source.note && (
                <p className="rounded-lg border border-teal/20 bg-teal/[0.06] px-3 py-2 text-xs text-mid">
                  {source.note}
                </p>
              )}
              <div className="flex gap-3 pt-1">
                <Button variant="ghost" onClick={() => dispatch({ type: 'back' })}>
                  <ArrowLeft className="h-4 w-4" /> Change exchange
                </Button>
                <Button className="flex-1" onClick={() => dispatch({ type: 'advance' })}>
                  I've got my file <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {/* ── STEP 3 · upload ── */}
          {state.step === 'upload' && source && (
            <div className="space-y-4">
              <div>
                <h3 className="text-base font-extrabold text-hi">Drop in your {source.label} file</h3>
                <p className="mt-1 text-xs text-low">
                  CSV or Excel. It's parsed right here — nothing is uploaded to us.
                </p>
              </div>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  handleFiles(e.dataTransfer.files);
                }}
                className={cn(
                  'flex flex-col items-center justify-center rounded-xl border-[1.5px] border-dashed px-6 py-12 text-center transition-colors',
                  dragOver ? 'border-violet bg-violet/10' : 'border-violet/50 bg-violet/5'
                )}
              >
                {reading ? (
                  <>
                    <Loader2 className="mb-3 h-6 w-6 animate-spin text-violet" />
                    <p className="text-sm text-mid">
                      Reading and previewing your file…
                      {queueTotal > 1 && ` (file ${queueTotal - fileQueue.length} of ${queueTotal})`}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mb-3 grid h-12 w-12 place-items-center rounded-xl bg-violet/15 text-violet">
                      <Upload className="h-6 w-6" />
                    </div>
                    <h4 className="text-sm font-bold text-hi">
                      Drag &amp; drop your {source.label} file{queueTotal > 1 ? 's' : ''}
                    </h4>
                    <p className="mt-1 text-xs text-low">CSV or XLSX · several files at once works too</p>
                    <label className="mt-4">
                      <input
                        type="file"
                        multiple
                        accept=".csv,.txt,.xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                        className="hidden"
                        onChange={(e) => {
                          handleFiles(e.target.files);
                          e.target.value = '';
                        }}
                      />
                      <span className="cursor-pointer rounded-[10px] bg-aurora px-4 py-2 text-sm font-bold text-[#0A0B1A] shadow-glow">
                        Browse files
                      </span>
                    </label>
                  </>
                )}
              </div>

              {queueNote && (
                <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-xs text-warn">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{queueNote}</span>
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-xs text-warn">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              {fallbackMessages.length > 0 && (
                <div className="space-y-3">
                  <FixTheFileGuidance messages={fallbackMessages} />
                  {aiAvailable && pendingUnrecognized && (
                    <Button onClick={runAiMapping} disabled={aiMapping}>
                      {aiMapping ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" /> Asking AI to map columns…
                        </>
                      ) : (
                        'Try AI mapping'
                      )}
                    </Button>
                  )}
                </div>
              )}

              <div className="flex items-start gap-3 rounded-lg border border-gain/20 bg-gain/[0.06] px-3 py-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gain/15 text-gain">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <div>
                  <h5 className="text-xs font-bold text-hi">Parsing stays 100% local</h5>
                  <p className="mt-0.5 text-xs text-mid">
                    Your file is parsed right here in this browser and never uploaded to SoloLedger.
                    Only if you choose "Try AI mapping" do we send your column names and a few sample
                    rows (never the full file) to identify columns.
                  </p>
                </div>
              </div>

              <Button variant="ghost" onClick={() => dispatch({ type: 'back' })}>
                <ArrowLeft className="h-4 w-4" /> Back
              </Button>
            </div>
          )}

          {/* ── STEP 4 · preview & confirm ── */}
          {state.step === 'preview' && preview && (
            <ImportPreviewCard
              transactions={preview.transactions}
              distinctAssets={preview.distinctAssets}
              warnings={preview.warnings}
              missingPriceCount={preview.missingPriceCount}
              tdsTotalInr={preview.tdsTotalInr}
              headerNote={
                <div>
                  <h3 className="text-base font-extrabold text-hi">Check it, then confirm</h3>
                  <p className="mt-1 text-xs text-low">
                    We mapped the columns for you. Nothing saves to your ledger until you confirm.
                  </p>
                </div>
              }
              saving={saving}
              savePhase={savePhase}
              error={error}
              onConfirm={() => void confirmSave()}
              onBack={() => {
                // Backing out of a preview cancels any queued batch files.
                setPreview(null);
                setFileQueue([]);
                setQueueTotal(0);
                batchSavedRef.current = 0;
                setQueueNote(null);
                dispatch({ type: 'clearFile' });
              }}
            />
          )}
        </div>
      )}

      {/* Item 1: a subtle skip link that persists across ALL wizard steps —
          rendered only when the caller passes onSkip (onboarding). The Import
          tab's embedded wizard omits it: that user is already on Import.
          Styling mirrors Onboarding's skipLink. */}
      {onSkip && (
        <div className="text-center">
          <button
            type="button"
            onClick={onSkip}
            className="text-center text-xs font-medium text-low transition-colors hover:text-mid focus:outline-none focus-visible:underline"
          >
            Skip setup — go straight to Import
          </button>
        </div>
      )}

      <p className="text-center font-mono text-[10.5px] text-faint">
        Every tax figure is an estimate to help you file — not tax advice.
      </p>
    </div>
  );
}
