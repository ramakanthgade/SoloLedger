import { useCallback, useRef, useState } from 'react';
import {
  buildCsvImportEvidenceGeneration,
  parseImportFile,
  isSpreadsheetFile,
  type FileParseOutcome
} from '@/lib/parsers';
import { parseWithMapping } from '@/lib/parsers/generic';
import { confirmAddressOrientation, confirmSheetOrientations } from '@/lib/parsers/addressOrientation';
import { suggestCsvMappingWithAi } from '@/lib/ai/csvMapping';
import {
  db,
  commitCsvImportGeneration,
  getSettings,
  hashFileContent,
} from '@/lib/storage/db';
import { convertOrNormalizeForImport } from '@/lib/pricing/fiatConvert';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import { getEffectiveSettings, isAiMappingAvailable } from '@/lib/saas/effectiveSettings';
import { normalizeFiatMagnitude } from '@/lib/parsers/types';
import { buildFallbackMessages, FixTheFileGuidance } from '@/components/import/importFallback';
import type { Transaction } from '@/types/transaction';
import { Badge } from '@/components/ui/card';
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Upload } from 'lucide-react';
import { ColumnMappingForm } from '@/components/import/ColumnMappingForm';
import { cn } from '@/lib/utils';

/** How one dropped file was handled — the multi-file wrapper (handleFiles)
 *  aggregates these into the batch summary. The saved variant also carries
 *  the per-file pricing/conversion tallies so a batch can report ONE
 *  aggregated note instead of only the last file's (Item 5). */
type FileHandleOutcome =
  | {
      kind: 'saved';
      count: number;
      pricesUpdated: number;
      pricesFailed: number;
      converted: number;
      convertFailed: number;
    }
  | { kind: 'duplicate' }
  | { kind: 'manual' };

class CsvSaveError extends Error {}

/**
 * Shared note builders — the single-file path (persistTransactions) and the
 * batch aggregation (handleFiles) MUST emit identical strings, so both call
 * these. Returns null when there is nothing to report.
 */
function priceFetchNoteText(updated: number, failed: number): string | null {
  if (updated <= 0 && failed <= 0) return null;
  return updated > 0
    ? `Fetched prices for ${updated} transaction${updated === 1 ? '' : 's'}.` +
        (failed > 0 ? ` ${failed} could not be priced — edit in Review.` : '')
    : `${failed} transaction${failed === 1 ? '' : 's'} could not be priced — edit in Review.`;
}

function conversionNoteText(converted: number, failed: number, currency: string): string | null {
  if (converted <= 0 && failed <= 0) return null;
  return [
    converted > 0
      ? `Converted ${converted} value${converted === 1 ? '' : 's'} to ${currency} using historical exchange rates.`
      : null,
    failed > 0
      ? `${failed} value${failed === 1 ? '' : 's'} could not be converted to ${currency} — edit in Review if needed.`
      : null
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Drawer step 3 (file) — the CSV/XLSX import flow, extracted UNCHANGED from
 * the old Import tab's File upload mode: multi-file sequential batches with
 * per-file auto-save on recognized formats, duplicate-hash blocking, the
 * aggregated batch summary, sheet-extraction notes, the column-mapping form
 * (manual + explicit AI mapping with the data-sharing disclosure), and the
 * saved/warning/conversion/pricing banners. Re-skinned to the Connections v2
 * dropzone (mockup `.drop`); the "Files already imported" list lives on the
 * Connections home as file cards now.
 */
export function FileImportFlow() {
  const [outcome, setOutcome] = useState<FileParseOutcome | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [fileHash, setFileHash] = useState<string>('');
  const [duplicateBlocked, setDuplicateBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [conversionNote, setConversionNote] = useState<string | null>(null);
  const [priceFetchNote, setPriceFetchNote] = useState<string | null>(null);
  const [extractionNote, setExtractionNote] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importPhase, setImportPhase] = useState<'saving' | 'pricing' | 'mapping' | null>(null);
  /** Summary line shown after a multi-file drop (per-file states are last-wins). */
  const [batchNote, setBatchNote] = useState<string | null>(null);
  /** Actionable fix-the-file + AI-last-resort guidance when a file can't be read. */
  const [fallbackMessages, setFallbackMessages] = useState<string[]>([]);
  /** Whether AI column-mapping is actually available (own key, or hosted with server AI enabled). */
  const [aiAvailable, setAiAvailable] = useState(false);
  /** The hidden CSV/XLSX input — the dropzone's browse control clicks it. */
  const fileInputRef = useRef<HTMLInputElement>(null);

  const persistTransactions = async (
    txs: Transaction[],
    parserId: string | null,
    hash: string,
    name: string,
    metadata?: Pick<FileParseOutcome, 'balanceSnapshot' | 'optionsBalanceUnavailable' | 'optionsBalanceIncluded' | 'optionsCoverageThrough' | 'evidence' | 'warnings'>
  ): Promise<{ converted: number; failed: number; pricesUpdated: number; pricesFailed: number; warnings: string[]; saved: number }> => {
    setConversionNote(null);
    setPriceFetchNote(null);
    // Raw local settings carry BYOK API keys for the actual fetch; the effective
    // settings decide whether Live price lookup is enabled (server-driven ON in
    // hosted, default OFF locally).
    const settings = await getSettings();
    const { priceApiEnabled } = await getEffectiveSettings();
    const stamped = txs.map((t) => ({
      ...t,
      importBatchId: hash,
      // Preserve per-sheet parser source when a workbook yields mixed formats
      source: t.source || parserId || 'import',
      fiatValue: normalizeFiatMagnitude(t.fiatValue),
      feeAmount: t.feeAmount != null ? Math.abs(t.feeAmount) : undefined
    }));

    const {
      transactions: converted,
      converted: nConverted,
      failed: nFailed
    } = await convertOrNormalizeForImport(stamped, settings, priceApiEnabled);
    if (nConverted > 0 || nFailed > 0) {
      setConversionNote(conversionNoteText(nConverted, nFailed, settings.reportingCurrency));
    }

    let count: number;
    try {
      count = await commitCsvImportGeneration({
      id: hash,
      fileName: name,
      parserId,
      transactions: converted,
      metadata: {
        balanceSnapshot: metadata?.balanceSnapshot,
        optionsBalanceUnavailable: metadata?.optionsBalanceUnavailable,
        optionsBalanceIncluded: metadata?.optionsBalanceIncluded,
        optionsCoverageThrough: metadata?.optionsCoverageThrough
      },
      buildGeneration: ({ generation, savedAfterDedup, savedTransactions, completedAt }) =>
        buildCsvImportEvidenceGeneration({
          sourceIdentityId: hash,
          parserId,
          parsedBeforeDedup: converted.length,
          savedAfterDedup,
          savedTransactions,
          evidence: metadata?.evidence,
          warnings: metadata?.warnings,
          optionsBalanceIncluded: metadata?.optionsBalanceIncluded,
          generation,
          completedAt
        })
      });
    } catch (error) {
      throw new CsvSaveError(error instanceof Error ? error.message : 'CSV persistence failed');
    }

    // Auto price fetch only when Live price lookup is enabled (network egress).
    let pricesUpdated = 0;
    let pricesFailed = 0;
    const warnings: string[] = [];
    if (priceApiEnabled) {
      setImportPhase('pricing');
      try {
        const priceResult = await fetchMissingPricesForAllTransactions(settings);
        pricesUpdated = priceResult.updated;
        pricesFailed = priceResult.failed;
        if (priceResult.updated > 0 || priceResult.failed > 0) {
          setPriceFetchNote(priceFetchNoteText(priceResult.updated, priceResult.failed));
        }
      } catch {
        // The import is already durable. Pricing is optional and must never
        // turn a successful save into a misleading "file could not be read".
        setPriceFetchNote('Transactions saved. Optional market prices could not be fetched — try again later.');
      }
    }

    return {
      converted: nConverted,
      failed: nFailed,
      pricesUpdated,
      pricesFailed,
      warnings,
      // Post-dedup rows attributable to this import — the honest "saved" count.
      // Parsed-but-deduped rows (overlapping re-exports) must not inflate it.
      saved: count
    };
  };

  /**
   * Parse (and, when recognized, auto-save) ONE file. Returns how the file
   * was handled so a multi-file wrapper can aggregate a batch summary.
   */
  const handleFile = useCallback(
    async (file: File): Promise<FileHandleOutcome> => {
      setDuplicateBlocked(false);
      setImportWarnings([]);
      setConversionNote(null);
      setPriceFetchNote(null);
      setExtractionNote(null);
      setOutcome(null);
      setFallbackMessages([]);
      setFileName(file.name);

      const hashInput = isSpreadsheetFile(file) ? await file.arrayBuffer() : await file.text();
      const hash = await hashFileContent(hashInput);
      setFileHash(hash);

      const existing = await db.csvImports.get(hash);
      if (existing && existing.txCount > 0) {
        setDuplicateBlocked(true);
        return { kind: 'duplicate' };
      }

      const result = await parseImportFile(file);
      if (result.transactions.length === 0) {
        try {
          await commitCsvImportGeneration({
            id: hash, fileName: file.name, parserId: result.detectedParser, transactions: [],
            buildGeneration: ({ generation, savedAfterDedup, savedTransactions, completedAt }) =>
              buildCsvImportEvidenceGeneration({
                sourceIdentityId: hash, parserId: result.detectedParser, parsedBeforeDedup: 0,
                savedAfterDedup, savedTransactions, evidence: result.evidence, warnings: result.warnings,
                generation, completedAt
              })
          });
        } catch (error) {
          throw new CsvSaveError(error instanceof Error ? error.message : 'CSV evidence persistence failed');
        }
      }
      const sheetSummary = result.sheets
        .filter((s) => !s.skipped && s.detectedParser && s.transactions.length > 0)
        .map((s) => `“${s.sheetName}”: ${s.transactions.length} via ${s.detectedParser}`)
        .join(' · ');
      const skippedSummary = result.sheets
        .filter((s) => s.skipped)
        .map((s) => s.sheetName)
        .join(', ');
      if (sheetSummary || skippedSummary) {
        setExtractionNote(
          [
            sheetSummary ? `Imported from sheets: ${sheetSummary}.` : null,
            skippedSummary ? `Skipped non-data sheets: ${skippedSummary}.` : null
          ]
            .filter(Boolean)
            .join(' ')
        );
      }

      // Auto-save when format is recognized and rows were parsed
      if (result.detectedParser && result.transactions.length > 0) {
        setSaving(true);
        setImportPhase('saving');
        try {
          // Best-effort orientation confirmation for ambiguous-Address sheets
          // (non-local only). Only the ambiguous sheets' rows are re-oriented;
          // clearly-named / non-generic sheets are left untouched. Non-fatal.
          const toPersist = await confirmSheetOrientations(result.sheets, result.transactions);
          const persisted = await persistTransactions(toPersist, result.detectedParser, hash, file.name, {
            balanceSnapshot: result.balanceSnapshot,
            optionsBalanceUnavailable: result.optionsBalanceUnavailable,
            optionsBalanceIncluded: result.optionsBalanceIncluded,
            optionsCoverageThrough: result.optionsCoverageThrough,
            evidence: result.evidence,
            warnings: result.warnings
          });
          setImportWarnings([...result.warnings, ...persisted.warnings]);
          setFileName('');
          setFileHash('');
          return {
            kind: 'saved',
            count: persisted.saved,
            pricesUpdated: persisted.pricesUpdated,
            pricesFailed: persisted.pricesFailed,
            converted: persisted.converted,
            convertFailed: persisted.failed
          };
        } finally {
          setSaving(false);
          setImportPhase(null);
        }
      }

      // Format not recognized (or recognized but produced no rows). Do NOT fire
      // AI mapping automatically — it would relay column headers + sample rows to
      // the AI provider (via SoloLedger's server in hosted mode) without the user
      // seeing the data-sharing disclosure first. Instead surface actionable
      // fix-the-file guidance and, when AI mapping is actually available, an
      // explicit "Try AI mapping" button (which shows the disclosure). The
      // default path stays fully local.
      const aiOn = await isAiMappingAvailable();
      setAiAvailable(aiOn);
      if (result.transactions.length === 0) {
        const missing = result.missingFields;
        setFallbackMessages(buildFallbackMessages(missing, aiOn));
      }

      setOutcome(result);
      return { kind: 'manual' };
    },
    []
  );

  /**
   * Process one or many files SEQUENTIALLY. Each recognized file auto-saves
   * as today; the saved-count banner accumulates across the batch and a
   * one-line summary reports per-file outcomes. A file that throws (e.g. a
   * corrupt workbook) is counted and skipped so the rest of the batch still
   * runs. Files needing manual mapping (or duplicates) surface via the
   * existing per-file UI — last one wins.
   */
  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setSavedCount(null);
      setBatchNote(null);
      let savedFiles = 0;
      let totalSaved = 0;
      let duplicates = 0;
      let manual = 0;
      let failed = 0;
      let saveFailed = 0;
      let noNew = 0;
      // Pricing/conversion tallies accumulated across the whole batch — the
      // per-file notes are last-wins, so a multi-file drop replaces them with
      // ONE aggregated note after the loop (Item 5).
      let pricesUpdated = 0;
      let pricesFailed = 0;
      let valuesConverted = 0;
      let valuesConvertFailed = 0;
      /** Outcome of the last file that didn't throw — the per-file UI below
       *  (duplicate banner, column-mapping form) only reflects THIS file. */
      let lastOutcome: FileHandleOutcome | null = null;
      for (const file of files) {
        let outcome: FileHandleOutcome;
        try {
          // eslint-disable-next-line no-await-in-loop
          outcome = await handleFile(file);
        } catch (error) {
          // A corrupt/unreadable file must not strand the rest of the batch.
          if (error instanceof CsvSaveError) saveFailed += 1;
          else failed += 1;
          lastOutcome = null;
          continue;
        }
        lastOutcome = outcome;
        if (outcome.kind === 'saved') {
          pricesUpdated += outcome.pricesUpdated;
          pricesFailed += outcome.pricesFailed;
          valuesConverted += outcome.converted;
          valuesConvertFailed += outcome.convertFailed;
          if (outcome.count > 0) {
            savedFiles += 1;
            totalSaved += outcome.count;
          } else {
            // Parsed fine but every row was already in the ledger (row-level
            // dedup, e.g. an overlapping re-export) — must not inflate the
            // saved total or the "N of M files imported" count.
            noNew += 1;
          }
        } else if (outcome.kind === 'duplicate') {
          duplicates += 1;
        } else {
          manual += 1;
        }
      }
      if (totalSaved > 0) setSavedCount(totalSaved);
      if (files.length > 1) {
        // The batch summary replaces the single-file duplicate banner.
        setDuplicateBlocked(false);
        // Item 5: per-file price/conversion notes are last-wins across a
        // batch (each handleFile resets them) — replace them with ONE
        // aggregated note each, mirroring the single-file strings, so a
        // 3-file import reports "Fetched prices for 123 transactions."
        // instead of only the last file's count.
        setPriceFetchNote(priceFetchNoteText(pricesUpdated, pricesFailed));
        if (valuesConverted > 0 || valuesConvertFailed > 0) {
          const { reportingCurrency } = await getSettings();
          setConversionNote(conversionNoteText(valuesConverted, valuesConvertFailed, reportingCurrency));
        } else {
          setConversionNote(null);
        }
        // The column-mapping form only survives when the LAST processed file
        // is the one needing mapping — a later file's handleFile reset it.
        const mappingShown = lastOutcome?.kind === 'manual';
        setBatchNote(
          `${[
            `${savedFiles} of ${files.length} files imported (${totalSaved} transaction${totalSaved === 1 ? '' : 's'})`,
            duplicates > 0 ? `${duplicates} already imported — skipped` : null,
            manual > 0
              ? `${manual} need${manual === 1 ? 's' : ''} column mapping${
                  mappingShown ? ' — shown below' : ' — re-drop that file on its own to map it'
                }`
              : null,
            failed > 0 ? `${failed} could not be read — skipped` : null,
            saveFailed > 0 ? `${saveFailed} could not be saved — no partial data was kept` : null,
            noNew > 0
              ? `${noNew} had no new rows — everything already in your ledger`
              : null
          ]
            .filter(Boolean)
            .join(' · ')}.`
        );
      } else if (failed > 0) {
        // Single-file drop that threw: nothing else surfaced, so say so.
        setBatchNote(
          `"${files[0].name}" could not be read — the file may be corrupt or in an unexpected format.`
        );
      } else if (saveFailed > 0) {
        setBatchNote(
          `"${files[0].name}" could not be saved — no partial transactions or evidence were kept.`
        );
      } else if (noNew > 0) {
        // Single file parsed fine but row-level dedup dropped every row.
        setBatchNote(
          'No new transactions — everything in that file was already in your ledger.'
        );
      }
    },
    [handleFile]
  );

  /**
   * Explicit, user-triggered AI column-mapping. Only reachable via the
   * "Try AI mapping" button, which renders the data-sharing disclosure first,
   * so headers + sample rows are never relayed without the user's knowledge.
   */
  const runAiMapping = useCallback(async () => {
    if (!outcome || outcome.rows.length === 0 || !fileHash) return;
    const settings = await getSettings();
    setSaving(true);
    setImportPhase('mapping');
    try {
      const suggestion = await suggestCsvMappingWithAi(
        // In hosted mode `openrouter.ts` supplies the real credential
        // server-side and ignores this arg; pass '' as a placeholder.
        settings.aiApiKey ?? '',
        outcome.headers,
        outcome.rows,
        settings.aiModel
      );
      const autoMapped = parseWithMapping(
        outcome.rows,
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

      if (autoMapped.transactions.length === 0) {
        setFallbackMessages([
          `AI could not confidently map this file${
            suggestion.missingFields.length ? ` (missing: ${suggestion.missingFields.join(', ')})` : ''
          }. Map the columns manually below.`
        ]);
        return;
      }

      setImportPhase('saving');
      const aiToPersist = autoMapped.addressColumnAmbiguous
        ? await confirmAddressOrientation(autoMapped.transactions)
        : autoMapped.transactions;
      const aiPersisted = await persistTransactions(aiToPersist, 'ai_mapping', fileHash, fileName);
      setSavedCount(aiPersisted.saved);
      setImportWarnings([
        `AI mapped the columns (${suggestion.confidence} confidence): ${suggestion.explanation}`,
        ...autoMapped.warnings
      ]);
      setFileName('');
      setFileHash('');
      setOutcome(null);
      setFallbackMessages([]);
    } catch {
      setFallbackMessages([
        'AI mapping failed. Map the columns manually below, or try a different export.'
      ]);
    } finally {
      setSaving(false);
      setImportPhase(null);
    }
  }, [outcome, fileHash, fileName]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files ?? []);
      if (files.length > 0) void handleFiles(files);
    },
    [handleFiles]
  );

  const saveMapped = async (mapped: ReturnType<typeof parseWithMapping>) => {
    if (mapped.transactions.length === 0 || !fileHash) return;
    setSaving(true);
    setImportPhase('saving');
    try {
      const toPersist = mapped.addressColumnAmbiguous
        ? await confirmAddressOrientation(mapped.transactions)
        : mapped.transactions;
      const mappedPersisted = await persistTransactions(toPersist, 'manual_mapping', fileHash, fileName);
      setSavedCount(mappedPersisted.saved);
      setImportWarnings(mapped.warnings);
      setOutcome(null);
      setFileName('');
      setFileHash('');
    } finally {
      setSaving(false);
      setImportPhase(null);
    }
  };

  return (
    <div className="flex flex-col gap-4" data-testid="file-import-flow">
      {/* The hidden file input stays mounted for the whole flow so the
          dropzone's browse control can open the real picker in one click. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".csv,.txt,.xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
        className="hidden"
        disabled={saving}
        onChange={(e) => {
          const selected = Array.from(e.target.files ?? []);
          if (selected.length > 0) void handleFiles(selected);
          e.target.value = '';
        }}
      />

      {/* Dropzone (mockup `.drop`) */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors',
          dragOver ? 'border-primary bg-primary/[0.06]' : 'border-hi/20 bg-elev-2'
        )}
      >
        {saving ? (
          <>
            <Loader2 className="mb-3 h-6 w-6 animate-spin text-primary" aria-hidden="true" />
            <p className="text-sm text-mid">
              {importPhase === 'pricing'
                ? 'Transactions saved. Fetching optional market prices in the background — you can close this panel.'
                : importPhase === 'mapping'
                  ? 'Asking AI to map columns…'
                  : 'Importing and saving transactions…'}
            </p>
          </>
        ) : (
          <>
            <span className="mb-3 grid h-12 w-12 place-items-center rounded-full border border-hi/10 bg-elev-1 text-primary">
              <Upload className="h-5 w-5" aria-hidden="true" />
            </span>
            <p className="text-[15px] font-bold text-hi">Drop your export here</p>
            <p className="mt-1 text-[13px] text-mid">
              or{' '}
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="font-semibold text-primary underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                browse this device
              </button>{' '}
              — CSV or XLSX, several files at once works too
            </p>
            <p className="mt-2 text-xs text-low">Nothing is uploaded. Parsing happens right here.</p>
          </>
        )}
        {fileName && !duplicateBlocked && !saving && outcome && (
          <p className="mt-3 flex items-center gap-1.5 font-mono text-xs text-low">
            <FileUp className="h-3.5 w-3.5" aria-hidden="true" />
            {fileName}
          </p>
        )}
      </div>

      {duplicateBlocked && (
        <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
          <strong>{fileName}</strong> was already imported. Remove its card from the Connections
          home to upload it again with different mapping.
        </div>
      )}

      {batchNote && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-mid">
          {batchNote}
        </div>
      )}

      {extractionNote && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-mid">
          {extractionNote}
        </div>
      )}

      {outcome && (
        <div className="overflow-hidden rounded-2xl border border-hi/10 bg-elev-2 shadow-card">
          <div className="border-b border-hi/10 bg-elev-1/50 px-5 py-4">
            <h3 className="text-sm font-semibold tracking-tight text-hi">
              {outcome.detectedParser ? 'Import issue' : 'Map your columns'}
            </h3>
          </div>
          <div className="space-y-3 px-5 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {outcome.detectedParser ? (
                <Badge tone="gain">Detected: {outcome.detectedParser}</Badge>
              ) : (
                <Badge tone="warn">Format not recognized — auto extraction applied, review mapping below</Badge>
              )}
              <Badge tone="neutral">{outcome.transactions.length} transactions parsed</Badge>
              {outcome.skippedRows > 0 && <Badge tone="loss">{outcome.skippedRows} rows skipped</Badge>}
            </div>

            {outcome.warnings.map((w, i) => (
              <div key={i} className="flex items-start gap-2 rounded-sm bg-warn/5 px-3 py-2 text-xs text-warn">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{w}</span>
              </div>
            ))}

            {!outcome.detectedParser && (
              <ColumnMappingForm headers={outcome.headers} rows={outcome.rows} onMapped={saveMapped} />
            )}

            {outcome.transactions.length === 0 && fallbackMessages.length > 0 && (
              <div className="space-y-3">
                <FixTheFileGuidance messages={fallbackMessages} />
                {aiAvailable && outcome.rows.length > 0 && (
                  <button
                    type="button"
                    onClick={runAiMapping}
                    disabled={importPhase === 'mapping' || saving}
                    className="inline-flex h-11 items-center gap-2 rounded-lg bg-primary-solid px-5 text-sm font-bold text-white shadow-sm transition-all hover:bg-primary-solid-deep focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 disabled:opacity-60"
                  >
                    {importPhase === 'mapping' ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Asking AI to map columns…
                      </>
                    ) : (
                      'Try AI mapping'
                    )}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {savedCount !== null && (
        <div className="space-y-2">
          {savedCount > 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-gain/30 bg-gain/10 px-4 py-2.5 text-sm text-gain">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              Saved {savedCount} transaction{savedCount === 1 ? '' : 's'} to your local database. Head to
              Review to categorize them.
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-4 py-2.5 text-sm text-warn">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              No new transactions — everything in that file was already in your ledger.
            </div>
          )}
          {importWarnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 rounded-sm bg-warn/5 px-3 py-2 text-xs text-warn">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>{w}</span>
            </div>
          ))}
          {conversionNote && (
            <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm text-mid">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-gain" aria-hidden="true" />
              <span>{conversionNote}</span>
            </div>
          )}
          {priceFetchNote && (
            <div className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 py-2.5 text-sm text-gain">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{priceFetchNote}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
