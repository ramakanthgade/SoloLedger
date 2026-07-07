import { useCallback, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { parseCsvFile, type FileParseOutcome } from '@/lib/parsers';
import { parseWithMapping } from '@/lib/parsers/generic';
import {
  db,
  getCsvImports,
  hashFileContent,
  upsertCsvImport,
  deleteCsvImportAndTransactions,
  countCsvImportTransactions,
  deduplicateTransactions
} from '@/lib/storage/db';
import type { Transaction } from '@/types/transaction';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@/components/ui/card';
import { Upload, FileCheck2, AlertTriangle, CheckCircle2, Trash2 } from 'lucide-react';
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

  const csvImports = useLiveQuery(() => getCsvImports(), []) ?? [];

  const handleFile = useCallback(async (file: File) => {
    setSavedCount(null);
    setDuplicateBlocked(false);
    setFileName(file.name);
    const text = await file.text();
    const hash = await hashFileContent(text);
    setFileHash(hash);

    const existing = await db.csvImports.get(hash);
    if (existing) {
      setDuplicateBlocked(true);
      setOutcome(null);
      return;
    }

    const result = await parseCsvFile(file);
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

  const persistTransactions = async (txs: Transaction[], parserId: string | null) => {
    if (txs.length === 0 || !fileHash) return;
    const stamped = txs.map((t) => ({
      ...t,
      importBatchId: fileHash,
      source: parserId ?? t.source
    }));
    await db.transactions.bulkPut(stamped);
    await deduplicateTransactions();
    const count = await countCsvImportTransactions(fileHash);
    await upsertCsvImport(fileHash, fileName, parserId, count);
  };

  const save = async () => {
    if (!outcome || outcome.transactions.length === 0) return;
    setSaving(true);
    await persistTransactions(outcome.transactions, outcome.detectedParser);
    setSaving(false);
    setSavedCount(outcome.transactions.length);
    setOutcome(null);
    setFileName('');
    setFileHash('');
  };

  const saveMapped = async (mapped: ReturnType<typeof parseWithMapping>) => {
    if (mapped.transactions.length === 0) return;
    setSaving(true);
    await persistTransactions(mapped.transactions, 'manual_mapping');
    setSaving(false);
    setSavedCount(mapped.transactions.length);
    setOutcome(null);
    setFileName('');
    setFileHash('');
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
            <Upload className="mb-3 h-6 w-6 text-violet" />
            <p className="text-sm text-mist-300">Drop your CSV here — we'll take it from there, or</p>
            <label className="mt-3">
              <input
                type="file"
                accept=".csv,.txt"
                className="hidden"
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
            {fileName && !duplicateBlocked && <p className="mt-3 font-mono text-xs text-mist-400">{fileName}</p>}
          </div>

          {duplicateBlocked && (
            <div className="rounded-lg border border-gold/30 bg-gold/10 px-4 py-3 text-sm text-gold-600">
              <strong>{fileName}</strong> was already imported. Remove it from{' '}
              <strong>CSV files already imported</strong> below to upload it again with different mapping.
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
                <CardTitle>Parse result</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {outcome.detectedParser ? (
                    <Badge tone="emerald">Detected: {outcome.detectedParser}</Badge>
                  ) : (
                    <Badge tone="gold">Format not recognized — use AI auto-map or map manually</Badge>
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

                {outcome.detectedParser && outcome.transactions.length > 0 && (
                  <Button onClick={() => void save()} disabled={saving}>
                    {saving ? 'Saving locally…' : `Save ${outcome.transactions.length} transactions to SoloLedger`}
                  </Button>
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
        <div className="flex items-center gap-2 rounded-lg border border-emerald/30 bg-emerald/15 px-4 py-2.5 text-sm text-emerald-600">
          <CheckCircle2 className="h-4 w-4" />
          Saved {savedCount} transaction{savedCount === 1 ? '' : 's'} to your local database. Head to Review to
          categorize them.
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
