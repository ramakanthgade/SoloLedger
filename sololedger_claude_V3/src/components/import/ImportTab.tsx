import { useCallback, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { parseCsvFile, type FileParseOutcome } from '@/lib/parsers';
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
import { convertTransactionsToReportingCurrency } from '@/lib/pricing/fiatConvert';
import { fetchMissingPricesForAllTransactions } from '@/lib/pricing/autoFetch';
import { normalizeFiatMagnitude } from '@/lib/parsers/types';
import type { Transaction } from '@/types/transaction';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@/components/ui/card';
import { Upload, FileCheck2, AlertTriangle, CheckCircle2, Trash2, Loader2 } from 'lucide-react';
import { ColumnMappingForm } from './ColumnMappingForm';
import { ManualEntryForm } from './ManualEntryForm';
import { WalletLookupPanel } from './WalletLookupPanel';
import { cn } from '@/lib/utils';

type Mode = 'csv' | 'manual' | 'wallet';

const SUPPORTED = [
  { id: 'coinbase', label: 'Coinbase', guide: 'Settings → Reports → Generate custom report → Transaction history CSV' },
  { id: 'binance', label: 'Binance', guide: 'Recommended: Wallet → Transaction History → Export (full ledger). Also: Orders → Spot → Trade History for spot trades only.' }
];

export function ImportTab() {
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
  const [importPhase, setImportPhase] = useState<'saving' | 'pricing' | null>(null);

  const csvImports = useLiveQuery(() => getCsvImports(), []) ?? [];

  const persistTransactions = async (
    txs: Transaction[],
    parserId: string | null,
    hash: string,
    name: string
  ): Promise<{ converted: number; failed: number; pricesUpdated: number; pricesFailed: number; warnings: string[] }> => {
    setConversionNote(null);
    setPriceFetchNote(null);
    const settings = await getSettings();
    const stamped = txs.map((t) => ({
      ...t,
      importBatchId: hash,
      source: parserId ?? t.source,
      fiatValue: normalizeFiatMagnitude(t.fiatValue),
      feeAmount: t.feeAmount != null ? Math.abs(t.feeAmount) : undefined
    }));
    const { transactions: converted, converted: nConverted, failed: nFailed } =
      await convertTransactionsToReportingCurrency(stamped, settings);
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

    setImportPhase('pricing');
    const priceResult = await fetchMissingPricesForAllTransactions(settings);
    if (priceResult.updated > 0 || priceResult.failed > 0) {
      setPriceFetchNote(
        priceResult.updated > 0
          ? `Fetched prices for ${priceResult.updated} transaction${priceResult.updated === 1 ? '' : 's'}.` +
              (priceResult.failed > 0 ? ` ${priceResult.failed} could not be priced — edit in Review.` : '')
          : `${priceResult.failed} transaction${priceResult.failed === 1 ? '' : 's'} could not be priced — edit in Review.`
      );
    }

    return {
      converted: nConverted,
      failed: nFailed,
      pricesUpdated: priceResult.updated,
      pricesFailed: priceResult.failed,
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
    setFileName(file.name);

    const text = await file.text();
    const hash = await hashFileContent(text);
    setFileHash(hash);

    const existing = await db.csvImports.get(hash);
    if (existing) {
      setDuplicateBlocked(true);
      return;
    }

    const result = await parseCsvFile(file);
    const preambleWarning = result.warnings.find((w) =>
      w.toLowerCase().startsWith('ignored ') && w.toLowerCase().includes('before the detected header row')
    );
    if (preambleWarning) setExtractionNote(preambleWarning);

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

    // Auto-apply AI mapping when format isn't directly recognized.
    if (!result.detectedParser && result.rows.length > 0) {
      const settings = await getSettings();
      if (settings.aiApiKey) {
        try {
          const suggestion = await suggestCsvMappingWithAi(
            settings.aiApiKey,
            result.headers,
            result.rows,
            settings.aiModel
          );
          const autoMapped = parseWithMapping(
            result.rows,
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

          if (autoMapped.transactions.length > 0) {
            setSaving(true);
            setImportPhase('saving');
            try {
              await persistTransactions(autoMapped.transactions, 'ai_mapping', hash, file.name);
              setSavedCount(autoMapped.transactions.length);
              setImportWarnings([
                ...(preambleWarning ? [preambleWarning] : []),
                `AI auto-mapped file (${suggestion.confidence} confidence): ${suggestion.explanation}`,
                ...autoMapped.warnings
              ]);
              setFileName('');
              setFileHash('');
              setOutcome(null);
            } finally {
              setSaving(false);
              setImportPhase(null);
            }
            return;
          }
        } catch {
          // Fall through to manual mapping UI with parse warnings.
        }
      }
    }

    setOutcome(result);
  }, []);

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
    { id: 'csv', label: 'CSV upload' },
    { id: 'manual', label: 'Manual entry' },
    { id: 'wallet', label: 'Wallet lookup' }
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-semibold text-mist">Bring in your transactions</h2>
        <p className="mt-1 text-sm text-mist-400">
          Everything's read right here in your browser — nothing gets uploaded anywhere.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {modes.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={cn(
              'rounded-full px-4 py-2 text-sm font-medium transition-all hover:scale-[1.03] active:scale-95',
              mode === m.id ? 'bg-violet text-white shadow-pop' : 'bg-ink-700/50 text-mist-400 hover:text-mist'
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

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
              (dragOver ? 'border-violet bg-violet-100' : 'border-ink-600 bg-ink-800')
            }
          >
            {saving ? (
              <>
                <Loader2 className="mb-3 h-6 w-6 animate-spin text-violet" />
                <p className="text-sm text-mist-300">
                  {importPhase === 'pricing'
                    ? 'Fetching missing market prices…'
                    : 'Importing and saving transactions…'}
                </p>
              </>
            ) : (
              <>
                <Upload className="mb-3 h-6 w-6 text-violet" />
                <p className="text-sm text-mist-300">Drop your CSV here — we'll import it automatically, or</p>
                <label className="mt-3">
                  <input
                    type="file"
                    accept=".csv,.txt"
                    className="hidden"
                    disabled={saving}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void handleFile(file);
                      e.target.value = '';
                    }}
                  />
                  <span className="cursor-pointer rounded-full bg-violet px-4 py-2 text-sm font-medium text-white shadow-pop transition-all hover:scale-[1.03] hover:bg-violet-600 active:scale-95">
                    Choose file
                  </span>
                </label>
              </>
            )}
            {fileName && !duplicateBlocked && !saving && outcome && (
              <p className="mt-3 font-mono text-xs text-mist-400">{fileName}</p>
            )}
          </div>

          {duplicateBlocked && (
            <div className="rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-gold-600">
              <strong>{fileName}</strong> was already imported. Remove it from{' '}
              <strong>CSV files already imported</strong> below to upload it again with different mapping.
            </div>
          )}

          {extractionNote && (
            <div className="rounded-lg border border-violet/30 bg-violet/10 px-4 py-3 text-sm text-mist-300">
              {extractionNote}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {SUPPORTED.map((s) => (
              <Card key={s.id}>
                <CardContent className="flex items-start gap-3 py-4">
                  <FileCheck2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <div>
                    <p className="text-sm font-medium text-mist">{s.label}</p>
                    <p className="mt-0.5 text-xs text-mist-400">{s.guide}</p>
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
                  <div key={i} className="flex items-start gap-2 rounded-sm bg-gold/5 px-3 py-2 text-xs text-gold-600">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}

                {!outcome.detectedParser && (
                  <ColumnMappingForm headers={outcome.headers} rows={outcome.rows} onMapped={saveMapped} />
                )}

                {outcome.detectedParser && outcome.transactions.length === 0 && (
                  <p className="text-sm text-mist-400">
                    No transactions could be imported from this file. Check the warnings above or try a different export.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {csvImports.length > 0 && (
            <div className="rounded-lg border border-ink-700 bg-ink-800 p-4">
              <h3 className="mb-3 text-sm font-medium text-mist">CSV files already imported</h3>
              <div className="space-y-2">
                {csvImports.map((row) => (
                  <div
                    key={row.id}
                    className="flex flex-wrap items-center gap-2 rounded-lg bg-ink-700/40 px-3 py-2 text-xs"
                  >
                    <Badge tone="violet">{row.parserId ?? 'mapped'}</Badge>
                    <span className="font-medium text-mist" title={row.fileName}>
                      {row.fileName.length > 40 ? `${row.fileName.slice(0, 28)}…${row.fileName.slice(-10)}` : row.fileName}
                    </span>
                    <span className="text-mist-400">{row.txCount} txs</span>
                    <span className="text-mist-400">imported {new Date(row.importedAt).toLocaleDateString()}</span>
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
          <div className="flex items-center gap-2 rounded-lg border border-emerald/30 bg-emerald/15 px-4 py-2.5 text-sm text-emerald-600">
            <CheckCircle2 className="h-4 w-4" />
            Saved {savedCount} transaction{savedCount === 1 ? '' : 's'} to your local database. Head to Review to
            categorize them.
          </div>
          {importWarnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 rounded-sm bg-gold/5 px-3 py-2 text-xs text-gold-600">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{w}</span>
            </div>
          ))}
          {conversionNote && (
            <div className="flex items-start gap-2 rounded-lg border border-violet/30 bg-violet/10 px-4 py-2.5 text-sm text-mist-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-violet" />
              <span>{conversionNote}</span>
            </div>
          )}
          {priceFetchNote && (
            <div className="flex items-start gap-2 rounded-lg border border-emerald/30 bg-emerald/10 px-4 py-2.5 text-sm text-emerald-600">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{priceFetchNote}</span>
            </div>
          )}
        </div>
      )}

      {removeConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4">
          <div className="max-w-md rounded-lg border border-ink-700 bg-ink-800 p-5 shadow-xl">
            <h3 className="text-sm font-semibold text-mist">Remove CSV import and its transactions?</h3>
            <p className="mt-2 text-xs text-mist-400">
              Deletes <strong className="text-mist">{removeConfirm.txCount}</strong> transaction
              {removeConfirm.txCount === 1 ? '' : 's'} from{' '}
              <span className="text-mist-300">{removeConfirm.fileName}</span>. You can re-import the file after.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setRemoveConfirm(null)}>Cancel</Button>
              <Button
                variant="secondary"
                className="border-loss/40 text-loss hover:bg-loss/10"
                onClick={async () => {
                  await deleteCsvImportAndTransactions(removeConfirm.id);
                  setRemoveConfirm(null);
                }}
              >
                Remove file
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
