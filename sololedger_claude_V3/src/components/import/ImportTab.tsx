import { useCallback, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { parseImportFile, isSpreadsheetFile, type FileParseOutcome } from '@/lib/parsers';
import { parseWithMapping } from '@/lib/parsers/generic';
import { suggestCsvMappingWithAi } from '@/lib/ai/csvMapping';
import {
  db,
  getCsvImports,
  getSettings,
  hashFileContent,
  upsertCsvImport,
  deleteCsvImportAndTransactions,
  countCsvImportTransactions,
  deduplicateTransactions
} from '@/lib/storage/db';
import { convertOrNormalizeForImport } from '@/lib/pricing/fiatConvert';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import { getEffectiveSettings, isAiMappingAvailable } from '@/lib/saas/effectiveSettings';
import { normalizeFiatMagnitude } from '@/lib/parsers/types';
import {
  buildFallbackMessages,
  FixTheFileGuidance
} from './importFallback';
import type { Transaction } from '@/types/transaction';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@/components/ui/card';
import { Upload, FileCheck2, AlertTriangle, CheckCircle2, Trash2, Loader2 } from 'lucide-react';
import { ColumnMappingForm } from './ColumnMappingForm';
import { ManualEntryForm } from './ManualEntryForm';
import { WalletLookupPanel } from './WalletLookupPanel';
import { ConnectionWizard } from './ConnectionWizard';
import { EmptyState } from '@/components/ui/EmptyState';
import { cn } from '@/lib/utils';

type Mode = 'guided' | 'csv' | 'manual' | 'wallet';

const SUPPORTED = [
  { id: 'coinbase', label: 'Coinbase', guide: 'Settings → Reports → Generate custom report → Transaction history CSV' },
  { id: 'binance', label: 'Binance', guide: 'Recommended: Wallet → Transaction History → Export (full ledger). Also: Orders → Spot → Trade History for spot trades only.' },
  { id: 'wazirx', label: 'WazirX (Excel)', guide: 'Download Trade Report / Spot Trade Report (.xlsx). All sheets are scanned — trades, deposits & withdrawals import automatically; profile sheets are skipped.' },
  {
    id: 'hyperliquid',
    label: 'Hyperliquid (Perps)',
    guide:
      'Portfolio → Trade History → Export as CSV. Also export Deposits & Withdrawals. Perp profits import as income (USDC); losses & fees debit USDC — not as spot BTC/ETH buys.'
  }
];

export function ImportTab() {
  const transactionCount = useLiveQuery(() => db.transactions.count(), []) ?? 0;
  const [mode, setMode] = useState<Mode>('csv');
  const [outcome, setOutcome] = useState<FileParseOutcome | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [fileHash, setFileHash] = useState<string>('');
  const [duplicateBlocked, setDuplicateBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState<{ id: string; fileName: string; txCount: number } | null>(null);
  const [conversionNote, setConversionNote] = useState<string | null>(null);
  const [priceFetchNote, setPriceFetchNote] = useState<string | null>(null);
  const [extractionNote, setExtractionNote] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [importPhase, setImportPhase] = useState<'saving' | 'pricing' | 'mapping' | null>(null);
  /** Actionable fix-the-file + AI-last-resort guidance when a file can't be read. */
  const [fallbackMessages, setFallbackMessages] = useState<string[]>([]);
  /** Whether AI column-mapping is actually available (own key, or hosted with server AI enabled). */
  const [aiAvailable, setAiAvailable] = useState(false);

  const csvImports = useLiveQuery(() => getCsvImports(), []) ?? [];

  const persistTransactions = async (
    txs: Transaction[],
    parserId: string | null,
    hash: string,
    name: string
  ): Promise<{ converted: number; failed: number; pricesUpdated: number; pricesFailed: number; warnings: string[] }> => {
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
    if (nConverted > 0) {
      setConversionNote(
        `Converted ${nConverted} value${nConverted === 1 ? '' : 's'} to ${settings.reportingCurrency} using historical exchange rates.`
      );
    }
    if (nFailed > 0) {
      setConversionNote(
        (prev) =>
          `${prev ? `${prev} ` : ''}${nFailed} value${nFailed === 1 ? '' : 's'} could not be converted to ${settings.reportingCurrency} — edit in Review if needed.`
      );
    }

    await db.transactions.bulkPut(converted);
    await deduplicateTransactions();
    const count = await countCsvImportTransactions(hash);
    await upsertCsvImport(hash, name, parserId, count);

    // Auto price fetch only when Live price lookup is enabled (network egress).
    let pricesUpdated = 0;
    let pricesFailed = 0;
    if (priceApiEnabled) {
      setImportPhase('pricing');
      const priceResult = await fetchMissingPricesForAllTransactions(settings);
      pricesUpdated = priceResult.updated;
      pricesFailed = priceResult.failed;
      if (priceResult.updated > 0 || priceResult.failed > 0) {
        setPriceFetchNote(
          priceResult.updated > 0
            ? `Fetched prices for ${priceResult.updated} transaction${priceResult.updated === 1 ? '' : 's'}.` +
                (priceResult.failed > 0 ? ` ${priceResult.failed} could not be priced — edit in Review.` : '')
            : `${priceResult.failed} transaction${priceResult.failed === 1 ? '' : 's'} could not be priced — edit in Review.`
        );
      }
    }

    return {
      converted: nConverted,
      failed: nFailed,
      pricesUpdated,
      pricesFailed,
      warnings: []
    };
  };

  const handleFile = useCallback(async (file: File) => {
    setSavedCount(null);
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
    if (existing) {
      setDuplicateBlocked(true);
      return;
    }

    const result = await parseImportFile(file);
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
        await persistTransactions(result.transactions, result.detectedParser, hash, file.name);
        setSavedCount(result.transactions.length);
        setImportWarnings(result.warnings);
        setFileName('');
        setFileHash('');
      } finally {
        setSaving(false);
        setImportPhase(null);
      }
      return;
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
  }, []);

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
      await persistTransactions(autoMapped.transactions, 'ai_mapping', fileHash, fileName);
      setSavedCount(autoMapped.transactions.length);
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
      const file = e.dataTransfer.files?.[0];
      if (file) void handleFile(file);
    },
    [handleFile]
  );

  const saveMapped = async (mapped: ReturnType<typeof parseWithMapping>) => {
    if (mapped.transactions.length === 0 || !fileHash) return;
    setSaving(true);
    setImportPhase('saving');
    try {
      await persistTransactions(mapped.transactions, 'manual_mapping', fileHash, fileName);
      setSavedCount(mapped.transactions.length);
      setImportWarnings(mapped.warnings);
      setOutcome(null);
      setFileName('');
      setFileHash('');
    } finally {
      setSaving(false);
      setImportPhase(null);
    }
  };

  const modes: { id: Mode; label: string }[] = [
    { id: 'guided', label: 'Guided import' },
    { id: 'csv', label: 'File upload' },
    { id: 'manual', label: 'Manual entry' },
    { id: 'wallet', label: 'Wallet lookup' }
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="page-title">Bring in your trades</h2>
        <p className="mt-1 text-sm text-low">
          Drop in a CSV or Excel export from your exchange and we'll do the rest. Files are parsed
          right here in your browser — nothing is uploaded. (The optional "Try AI mapping" step
          sends just your column names and a few sample rows to identify columns.)
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {modes.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={cn(
              'rounded-full px-4 py-2 text-sm font-medium transition-all hover:scale-[1.03] active:scale-95',
              mode === m.id ? 'bg-violet text-white shadow-pop' : 'bg-elev-3/50 text-low hover:text-mid'
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {transactionCount === 0 && mode === 'csv' && (
        <EmptyState
          icon={<Upload className="h-11 w-11" />}
          title="No transactions yet"
          description="Bring your trades in once and Portfolio, Capital Gains and Reports all fill themselves in. The guided import walks you through exporting from your exchange."
          actionLabel="Import your first file"
          onAction={() => setMode('guided')}
          hint="Nothing has left your device."
        />
      )}

      {mode === 'guided' && <ConnectionWizard />}

      {mode === 'csv' && (
        <>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={
              'flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-14 text-center transition-colors ' +
              (dragOver ? 'border-violet bg-gain/15' : 'border-white/10 bg-elev-2')
            }
          >
            {saving ? (
              <>
                <Loader2 className="mb-3 h-6 w-6 animate-spin text-gain" />
                <p className="text-sm text-low">
                  {importPhase === 'pricing'
                    ? 'Fetching missing market prices…'
                    : 'Importing and saving transactions…'}
                </p>
              </>
            ) : (
              <>
                <Upload className="mb-3 h-6 w-6 text-gain" />
                <p className="text-sm text-low">
                  Drop a CSV or Excel (.xlsx) file — multi-sheet workbooks are scanned automatically, or
                </p>
                <label className="mt-3">
                  <input
                    type="file"
                    accept=".csv,.txt,.xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                    className="hidden"
                    disabled={saving}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleFile(file);
                      e.target.value = '';
                    }}
                  />
                  <span className="cursor-pointer rounded-full bg-violet px-4 py-2 text-sm font-medium text-white shadow-pop transition-all hover:scale-[1.03] hover:bg-violet active:scale-95">
                    Choose file
                  </span>
                </label>
              </>
            )}
            {fileName && !duplicateBlocked && !saving && outcome && (
              <p className="mt-3 font-mono text-xs text-low">{fileName}</p>
            )}
          </div>

          {duplicateBlocked && (
            <div className="rounded-lg border border-warn/30 bg-warn/10 px-4 py-3 text-sm text-warn">
              <strong>{fileName}</strong> was already imported. Remove it from{' '}
              <strong>Files already imported</strong> below to upload it again with different mapping.
            </div>
          )}

          {extractionNote && (
            <div className="rounded-lg border border-violet/30 bg-violet/10 px-4 py-3 text-sm text-low">
              {extractionNote}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SUPPORTED.map((s) => (
              <Card key={s.id}>
                <CardContent className="flex items-start gap-3 py-4">
                  <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0 text-gain" />
                  <div>
                    <p className="text-sm font-medium text-mid">{s.label}</p>
                    <p className="mt-0.5 text-xs text-low">{s.guide}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {outcome && (
            <Card>
              <CardHeader>
                <CardTitle>
                  {outcome.detectedParser ? 'Import issue' : 'Map your columns'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {outcome.detectedParser ? (
                    <Badge tone="emerald">Detected: {outcome.detectedParser}</Badge>
                  ) : (
                    <Badge tone="gold">Format not recognized — auto extraction applied, review mapping below</Badge>
                  )}
                  <Badge tone="neutral">{outcome.transactions.length} transactions parsed</Badge>
                  {outcome.skippedRows > 0 && <Badge tone="loss">{outcome.skippedRows} rows skipped</Badge>}
                </div>

                {outcome.warnings.map((w, i) => (
                  <div key={i} className="flex items-start gap-2 rounded-sm bg-warn/5 px-3 py-2 text-xs text-warn">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
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
                        className="inline-flex items-center gap-2 rounded-full bg-violet px-4 py-2 text-sm font-medium text-white transition-all hover:scale-[1.03] active:scale-95 disabled:opacity-60"
                      >
                        {importPhase === 'mapping' ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Asking AI to map columns…
                          </>
                        ) : (
                          'Try AI mapping'
                        )}
                      </button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {csvImports.length > 0 && (
            <div className="rounded-lg border border-white/10 bg-elev-2 p-4">
              <h3 className="mb-3 text-sm font-medium text-mid">Files already imported</h3>
              <div className="space-y-2">
                {csvImports.map((row) => (
                  <div
                    key={row.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg bg-elev-3/40 px-3 py-2 text-xs"
                  >
                    <Badge tone="violet">{row.parserId ?? 'mapped'}</Badge>
                    <span className="font-medium text-mid" title={row.fileName}>
                      {row.fileName.length > 40 ? `${row.fileName.slice(0, 28)}…${row.fileName.slice(-10)}` : row.fileName}
                    </span>
                    <span className="text-low">{row.txCount} txs</span>
                    <span className="text-low">imported {new Date(row.importedAt).toLocaleDateString()}</span>
                    <button
                      className="ml-auto flex items-center gap-1 text-loss hover:underline"
                      onClick={() => setRemoveConfirm({ id: row.id, fileName: row.fileName, txCount: row.txCount })}
                    >
                      <Trash2 className="h-3 w-3" /> Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {mode === 'manual' && <ManualEntryForm onSaved={() => setSavedCount((c) => (c ?? 0) + 1)} />}

      {mode === 'wallet' && <WalletLookupPanel />}

      {savedCount !== null && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg border border-violet/30 bg-violet/15 px-4 py-2.5 text-sm text-gain">
            <CheckCircle2 className="h-4 w-4" />
            Saved {savedCount} transaction{savedCount === 1 ? '' : 's'} to your local database. Head to Review to
            categorize them.
          </div>
          {importWarnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 rounded-sm bg-warn/5 px-3 py-2 text-xs text-warn">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
          {conversionNote && (
            <div className="flex items-start gap-2 rounded-lg border border-violet/30 bg-violet/10 px-4 py-2.5 text-sm text-low">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-gain" />
              <span>{conversionNote}</span>
            </div>
          )}
          {priceFetchNote && (
            <div className="flex items-start gap-2 rounded-lg border border-violet/30 bg-violet/10 px-4 py-2.5 text-sm text-gain">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{priceFetchNote}</span>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={removeConfirm !== null}
        destructive
        title="Remove import and its transactions?"
        body={
          removeConfirm ? (
            <>
              Deletes <strong className="text-mid">{removeConfirm.txCount}</strong> transaction
              {removeConfirm.txCount === 1 ? '' : 's'} from{' '}
              <span className="text-low">{removeConfirm.fileName}</span>. You can re-import the file after.
            </>
          ) : undefined
        }
        confirmLabel="Remove file"
        onConfirm={async () => {
          if (removeConfirm) await deleteCsvImportAndTransactions(removeConfirm.id);
          setRemoveConfirm(null);
        }}
        onCancel={() => setRemoveConfirm(null)}
      />
    </div>
  );
}
