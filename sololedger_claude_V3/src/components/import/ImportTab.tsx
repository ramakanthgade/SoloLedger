import { useCallback, useState } from 'react';
import { parseCsvFile, type FileParseOutcome } from '@/lib/parsers';
import { parseWithMapping } from '@/lib/parsers/generic';
import { db } from '@/lib/storage/db';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Badge } from '@/components/ui/card';
import { Upload, FileCheck2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { ColumnMappingForm } from './ColumnMappingForm';
import { ManualEntryForm } from './ManualEntryForm';
import { WalletLookupPanel } from './WalletLookupPanel';
import { cn } from '@/lib/utils';

type Mode = 'csv' | 'manual' | 'wallet';

const SUPPORTED = [
  { id: 'coinbase', label: 'Coinbase', guide: 'Settings → Reports → Generate custom report → Transaction history CSV' },
  { id: 'binance', label: 'Binance', guide: 'Wallet → Transaction History → Export (choose the generic CSV export)' }
];

export function ImportTab() {
  const [mode, setMode] = useState<Mode>('csv');
  const [outcome, setOutcome] = useState<FileParseOutcome | null>(null);
  const [fileName, setFileName] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(async (file: File) => {
    setSavedCount(null);
    setFileName(file.name);
    const result = await parseCsvFile(file);
    setOutcome(result);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const save = async () => {
    if (!outcome || outcome.transactions.length === 0) return;
    setSaving(true);
    await db.transactions.bulkPut(outcome.transactions);
    setSaving(false);
    setSavedCount(outcome.transactions.length);
    setOutcome(null);
  };

  const saveMapped = async (mapped: ReturnType<typeof parseWithMapping>) => {
    if (mapped.transactions.length === 0) return;
    setSaving(true);
    await db.transactions.bulkPut(mapped.transactions);
    setSaving(false);
    setSavedCount(mapped.transactions.length);
    setOutcome(null);
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
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
              <span className="cursor-pointer rounded-full bg-violet px-4 py-2 text-sm font-medium text-white shadow-pop transition-all hover:scale-[1.03] hover:bg-violet-600 active:scale-95">
                Choose file
              </span>
            </label>
            {fileName && <p className="mt-3 font-mono text-xs text-mist-400">{fileName}</p>}
          </div>

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
                    <Badge tone="gold">Format not recognized</Badge>
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
                  <Button onClick={save} disabled={saving}>
                    {saving ? 'Saving locally…' : `Save ${outcome.transactions.length} transactions to SoloLedger`}
                  </Button>
                )}
              </CardContent>
            </Card>
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
    </div>
  );
}
